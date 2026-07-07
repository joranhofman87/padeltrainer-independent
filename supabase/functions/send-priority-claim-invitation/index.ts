import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import {
  buildClaimUrl,
  resolveAppBase,
  resolveRecipient,
} from "../_shared/priority-claim-invite.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { sanitizeEmailSubject } from "../_shared/email-subject.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const APP_BASE = resolveAppBase(Deno.env.get("PUBLIC_APP_URL"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resend rate-limits bursts (HTTP 429). A bulk rebook can fire dozens of invites
// back to back, so back off and retry on rate-limit errors instead of dropping the
// invitation. Non-rate-limit errors are returned immediately (the caller releases
// the claim so a later run can retry). Returns the final Resend error or null.
async function sendInviteWithRetry(
  resendClient: Resend,
  payload: { from: string; to: string[]; subject: string; html: string },
  maxAttempts = 4,
): Promise<{ error: unknown | null }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { error } = await resendClient.emails.send(payload);
    if (!error) return { error: null };
    lastError = error;
    const e = error as { statusCode?: number; name?: string };
    // Prefer the structured fields; only fall back to scanning the serialized error
    // when no statusCode is present, so a non-rate-limit error that merely contains
    // "429" somewhere isn't retried as if it were throttled.
    const isRateLimit = e?.statusCode === 429 || e?.name === "rate_limit_exceeded" ||
      (e?.statusCode == null && /\b429\b|rate.?limit/i.test(JSON.stringify(error ?? {})));
    if (!isRateLimit) return { error };
    if (attempt < maxAttempts - 1) await sleep(800 * (attempt + 1)); // 0.8s, 1.6s, 2.4s
  }
  return { error: lastError };
}

interface ClaimRow {
  id: string;
  claim_token: string;
  status: string;
  invited_at: string | null;
  slot_id: string;
  player_id: string | null;
  guest_player_id: string | null;
  rebook_group_id: string | null;
  profiles: { full_name: string | null; email: string | null } | null;
  guest_players: { full_name: string | null; email: string | null } | null;
}

interface SlotRow {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  price_per_session: number | null;
  priority_window_ends_at: string | null;
  academy_profile_id: string | null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Personalization tokens — same set the reminder + invoice emails use.
const substituteVars = (text: string, fullName: string) => {
  const full = (fullName || "").trim();
  const first = full.split(/\s+/)[0] || full;
  const last = full.includes(" ") ? full.slice(full.indexOf(" ") + 1).trim() : "";
  return text
    .replace(/\{first_name\}/g, first)
    .replace(/\{last_name\}/g, last)
    .replace(/\{full_name\}/g, full);
};

// The academy's optional custom message → escaped, token-substituted paragraphs (or ''
// when none). Substitute BEFORE escaping so an injected name is escaped too.
const renderCustomMessage = (message: string, fullName: string): string => {
  const msg = (message || "").trim();
  if (!msg) return "";
  const paras = substituteVars(msg, fullName)
    .split("\n")
    .map((line) => `<p style="color:#374151;line-height:1.6;margin:0 0 8px;">${escapeHtml(line)}</p>`)
    .join("");
  return `<div style="background:#ffffff;border-left:3px solid #f45d25;padding:8px 0 8px 14px;margin:16px 0;">${paras}</div>`;
};

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return new Response(JSON.stringify({ error: "email_not_configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const token = authHeader.replace("Bearer ", "");
    const isService = token === serviceKey;
    let callerEmail: string | null = null;
    if (!isService) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      callerEmail = data.user.email ?? null;
    }

    const body = await req.json();
    const { claimIds, slotId, cycleId, limit, testEmail, resend, customMessage, customSubject } = body as {
      claimIds?: string[];
      slotId?: string;
      cycleId?: string;
      limit?: number;
      testEmail?: string;
      resend?: boolean;
      customMessage?: string;
      customSubject?: string;
    };
    const isTest = !!testEmail;
    // Optional academy-authored intro injected at the top of every invite (escaped + tokenized).
    let inviteMessage = typeof customMessage === "string" ? customMessage.trim().slice(0, 2000) : "";
    // Optional academy-authored subject line; empty ⇒ the default below. Sanitized (no CR/LF).
    let inviteSubject = sanitizeEmailSubject(customSubject);

    if (!(claimIds && claimIds.length) && !slotId && !cycleId) {
      return new Response(JSON.stringify({ error: "claimIds, slotId or cycleId required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // cycleId mode (resumable bulk drain): the caller sends invites in bounded
    // chunks for a whole round instead of one giant blocking invocation that risks
    // the edge wall-clock. We pick the REPRESENTATIVE claim per (series, player)
    // — one email per weekly series, mirroring bulk-rebook-cycle — that is still
    // pending AND not yet invited, cap it at `limit`, and report `remaining` so the
    // client can loop until drained. invited_at stamping (below) keeps it idempotent,
    // so re-runs never double-send.
    let cycleCandidateIds: string[] | null = null;
    let cycleRemaining = 0;
    if (cycleId) {
      const chunkLimit = Math.max(1, Math.min(Number(limit) || 40, 100));
      // Authorize by slot ownership: under the caller's JWT, RLS on
      // availability_slots restricts to slots they own/manage. Service callers
      // (e.g. an internal retry) skip the JWT gate.
      let ownedSlotIds: string[];
      if (isService) {
        const { data: s, error: sErr } = await supabase
          .from("availability_slots").select("id").eq("cyclus_id", cycleId);
        if (sErr) throw sErr;
        ownedSlotIds = (s || []).map((r: { id: string }) => r.id);
      } else {
        const userClient = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: s, error: sErr } = await userClient
          .from("availability_slots").select("id").eq("cyclus_id", cycleId);
        if (sErr) throw sErr;
        ownedSlotIds = (s || []).map((r: { id: string }) => r.id);
        if (ownedSlotIds.length === 0) {
          return new Response(JSON.stringify({ error: "Forbidden", sent: 0, remaining: 0 }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }
      // All pending claims on the round's slots, with their slot start_time, so we
      // can pick each (series, player)'s earliest-week claim as the representative.
      const repClaims: Array<{ id: string; invited_at: string | null; slot_id: string; player_id: string | null; guest_player_id: string | null; rebook_group_id: string | null; availability_slots: { start_time: string } | null }> = [];
      for (let i = 0; i < ownedSlotIds.length; i += 200) {
        const { data: rc, error: rcErr } = await supabase
          .from("slot_priority_claims")
          .select("id, invited_at, slot_id, player_id, guest_player_id, rebook_group_id, availability_slots:slot_id(start_time)")
          .in("slot_id", ownedSlotIds.slice(i, i + 200))
          .eq("status", "pending");
        if (rcErr) throw rcErr;
        // PostgREST types the to-one `availability_slots` embed as an array; the
        // runtime value is a single object. Cast through unknown (same idiom as the
        // ClaimRow cast below) to reconcile.
        repClaims.push(...((rc || []) as unknown as typeof repClaims));
      }
      const repByKey = new Map<string, { id: string; start: string; invited: boolean }>();
      for (const c of repClaims) {
        const pkey = c.player_id ?? `g:${c.guest_player_id}`;
        const gkey = c.rebook_group_id ?? c.slot_id;
        const start = c.availability_slots?.start_time ?? "";
        const k = `${gkey}|${pkey}`;
        const cur = repByKey.get(k);
        if (!cur || start < cur.start) repByKey.set(k, { id: c.id, start, invited: !!c.invited_at });
      }
      const eligibleReps = [...repByKey.values()].filter((r) => !r.invited).map((r) => r.id);
      cycleCandidateIds = eligibleReps.slice(0, chunkLimit);
      cycleRemaining = Math.max(0, eligibleReps.length - cycleCandidateIds.length);
      if (cycleCandidateIds.length === 0) {
        return new Response(JSON.stringify({ sent: 0, skipped: 0, remaining: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      // Consistent copy on resume: fall back to the message/subject stored on the
      // cycle at creation when the caller didn't pass them (e.g. the recovery button).
      if (!inviteMessage || !inviteSubject) {
        const { data: cy } = await supabase.from("cycles").select("settings").eq("id", cycleId).maybeSingle();
        const st = (cy?.settings || {}) as Record<string, unknown>;
        if (!inviteMessage && typeof st.rebook_invitation_message === "string") {
          inviteMessage = (st.rebook_invitation_message as string).trim().slice(0, 2000);
        }
        if (!inviteSubject && typeof st.rebook_invitation_subject === "string") {
          inviteSubject = sanitizeEmailSubject(st.rebook_invitation_subject as string);
        }
      }
    }

    // Authorization: for non-service callers, resolve which claims they are
    // allowed to invite by querying under their JWT, where the
    // "Slot owners manage priority claims" RLS policy restricts the rows to
    // slots they own. We then load full details via the service client for
    // ONLY those authorized ids. This prevents a logged-in user from inviting
    // (and, via testEmail, harvesting tokens for) claims on slots they don't own.
    // cycleId mode did its own slot-ownership authorization above.
    let authorizedIds: string[] | null = null;
    if (!isService && !cycleId) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      let ownQuery = userClient.from("slot_priority_claims").select("id");
      if (claimIds && claimIds.length) ownQuery = ownQuery.in("id", claimIds);
      else if (slotId) ownQuery = ownQuery.eq("slot_id", slotId);
      const { data: ownRows, error: ownErr } = await ownQuery;
      if (ownErr) throw ownErr;
      authorizedIds = (ownRows || []).map((r: { id: string }) => r.id);
      if (authorizedIds.length === 0) {
        return new Response(JSON.stringify({ error: "Forbidden", sent: 0 }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    let query = supabase
      .from("slot_priority_claims")
      .select(
        "id, claim_token, status, invited_at, slot_id, player_id, guest_player_id, rebook_group_id, profiles:player_id(full_name, email), guest_players:guest_player_id(full_name, email)"
      );
    if (cycleCandidateIds) query = query.in("id", cycleCandidateIds);
    else if (authorizedIds) query = query.in("id", authorizedIds);
    else if (claimIds && claimIds.length) query = query.in("id", claimIds);
    else if (slotId) query = query.eq("slot_id", slotId);

    const { data: claims, error: cErr } = await query;
    if (cErr) throw cErr;
    if (!claims || claims.length === 0)
      return new Response(JSON.stringify({ sent: 0, skipped: 0, remaining: cycleRemaining }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });

    // Only pending claims are invite-eligible: a responded (claimed/declined)
    // or expired/released claim must never receive a fresh live accept link.
    // Already-invited claims are skipped unless the caller explicitly asks for
    // a resend. Test sends go to the caller's own inbox with a placeholder
    // token (see _shared/priority-claim-invite.ts), so invited_at is ignored.
    const allClaims = claims as ClaimRow[];
    const eligible = allClaims.filter(
      (c) => c.status === "pending" && (isTest || resend === true || !c.invited_at)
    );
    let skipped = allClaims.length - eligible.length;
    if (eligible.length === 0)
      return new Response(JSON.stringify({ sent: 0, skipped, remaining: cycleRemaining }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });

    // Fetch slot info for the first slot (assume all share or fetch per claim)
    const slotIds = [...new Set(eligible.map((c) => c.slot_id))];
    const { data: slots } = await supabase
      .from("availability_slots")
      .select("id, start_time, end_time, cyclus_id, cyclus_name, price_per_session, priority_window_ends_at, academy_profile_id")
      .in("id", slotIds);

    // Academy timezone for DISPLAY (slots are stored UTC). Default Europe/Amsterdam.
    const acadIds = [...new Set(((slots || []) as SlotRow[]).map((s) => s.academy_profile_id).filter((id): id is string => !!id))];
    const tzByAcademy = new Map<string, string>();
    if (acadIds.length > 0) {
      const { data: acads } = await supabase.from("academy_profiles").select("id, timezone").in("id", acadIds);
      for (const a of (acads || []) as Array<{ id: string; timezone: string | null }>) {
        tzByAcademy.set(a.id, a.timezone || "Europe/Amsterdam");
      }
    }
    const slotMap = new Map<string, SlotRow>(
      ((slots || []) as SlotRow[]).map((s) => [s.id, s])
    );

    // Payment-mode per cycle (cycles.settings.rebook_payment_mode): 'upfront'
    // means the player checks out online on accept; the default
    // 'deferred_split' is invoiced at cycle start. Drives the email copy.
    const cyclusIds = [
      ...new Set(
        ((slots || []) as SlotRow[]).map((s) => s.cyclus_id).filter((id): id is string => !!id)
      ),
    ];
    const upfrontCycleIds = new Set<string>();
    const startDateByCycle = new Map<string, string>(); // cycleId -> yyyy-mm-dd (new round start)
    if (cyclusIds.length > 0) {
      const { data: cycleRows } = await supabase
        .from("cycles")
        .select("id, settings, start_date")
        .in("id", cyclusIds);
      for (const row of (cycleRows || []) as Array<{ id: string; settings: Record<string, unknown> | null; start_date: string | null }>) {
        if ((row.settings || {}).rebook_payment_mode === "upfront") upfrontCycleIds.add(row.id);
        if (row.start_date) startDateByCycle.set(row.id, row.start_date);
      }
    }

    // Group rebooking: a player's claim belongs to a weekly SERIES (shared
    // rebook_group_id). Compute per (group, player) the session count + date
    // range + weekday/time so the email describes the whole group, not just the
    // first week. One Yes books the entire series.
    type GroupInfo = { sessions: number; firstStart: string; lastStart: string };
    const groupInfo = new Map<string, GroupInfo>(); // key: `${rebook_group_id}|${playerKey}`
    const groupIds = [...new Set(eligible.map((c) => c.rebook_group_id).filter((id): id is string => !!id))];
    if (groupIds.length > 0) {
      const { data: groupClaims } = await supabase
        .from("slot_priority_claims")
        .select("rebook_group_id, player_id, guest_player_id, status, availability_slots:slot_id(start_time)")
        .in("rebook_group_id", groupIds)
        .eq("status", "pending");
      for (const gc of (groupClaims || []) as Array<{ rebook_group_id: string | null; player_id: string | null; guest_player_id: string | null; availability_slots: { start_time: string } | null }>) {
        if (!gc.rebook_group_id || !gc.availability_slots) continue;
        const pkey = gc.player_id ?? `g:${gc.guest_player_id}`;
        const key = `${gc.rebook_group_id}|${pkey}`;
        const start = gc.availability_slots.start_time;
        const cur = groupInfo.get(key);
        if (!cur) groupInfo.set(key, { sessions: 1, firstStart: start, lastStart: start });
        else {
          cur.sessions++;
          if (start < cur.firstStart) cur.firstStart = start;
          if (start > cur.lastStart) cur.lastStart = start;
        }
      }
    }

    const resendClient = new Resend(resendApiKey);
    let sent = 0;
    let failed = 0;
    const failedClaimIds: string[] = [];

    // Wall-clock budget: under sustained Resend rate-limiting a big batch (pacing +
    // up to ~4.8s backoff per send) could blow the edge runtime's hard timeout, which
    // would surface to the caller as a total failure of the WHOLE batch (incl. claims
    // that already sent). Instead, stop early and report the not-yet-attempted claims
    // as retryable — their invited_at is still NULL, so a resend picks them up.
    const startedAt = Date.now();
    const TIME_BUDGET_MS = 100_000;

    for (let idx = 0; idx < eligible.length; idx++) {
      const c = eligible[idx];
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        for (let j = idx; j < eligible.length; j++) { failed++; failedClaimIds.push(eligible[j].id); }
        console.warn("send-priority-claim-invitation: time budget reached", { remaining: eligible.length - idx });
        break;
      }
      const slot = slotMap.get(c.slot_id);
      if (!slot) { skipped++; continue; }
      const playerKey = c.player_id ?? `g:${c.guest_player_id}`;
      const group = c.rebook_group_id ? groupInfo.get(`${c.rebook_group_id}|${playerKey}`) : undefined;
      const recipientEmail = resolveRecipient({
        isTest,
        callerEmail,
        playerEmail: c.profiles?.email,
        guestEmail: c.guest_players?.email,
      });
      // No email on file → nothing we can send; count as skipped so the caller's
      // totals reconcile to the number of claims it asked us to invite.
      if (!recipientEmail) { skipped++; continue; }
      const recipientName = c.profiles?.full_name || c.guest_players?.full_name || "";

      // Times are stored UTC; render in the academy's timezone (default
      // Europe/Amsterdam) so 18:00-local reads as 18:00, not 16:00.
      const tz = (slot.academy_profile_id && tzByAcademy.get(slot.academy_profile_id)) || "Europe/Amsterdam";
      // For a group, anchor the description on the group's FIRST session.
      const start = new Date(group ? group.firstStart : slot.start_time);
      const durationMs = new Date(slot.end_time).getTime() - new Date(slot.start_time).getTime();
      const end = new Date(start.getTime() + durationMs);
      const weekday = start.toLocaleDateString("nl-NL", { weekday: "long", timeZone: tz });
      const startTime = start.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      const timeRange = `${startTime} - ${end.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: tz })}`;
      // Single-week (legacy) vs group (series) heading — include the time so the
      // player knows exactly which weekly slot they're committing to.
      const fmtDate = group
        ? `Elke ${weekday} om ${startTime} · ${group.sessions} ${group.sessions === 1 ? "sessie" : "sessies"}`
        : start.toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz });
      const groupRange = group
        ? `${new Date(group.firstStart).toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: tz })} t/m ${new Date(group.lastStart).toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: tz })}`
        : null;
      const fmtTime = timeRange;
      const claimUrl = buildClaimUrl(APP_BASE, c.claim_token, isTest);
      const acceptUrl = `${claimUrl}?intent=accept`;
      const declineUrl = `${claimUrl}?intent=decline`;
      const deadline = slot.priority_window_ends_at
        ? new Date(slot.priority_window_ends_at).toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: tz })
        : null;
      // New round's start date (a DATE; render at noon UTC so the tz never shifts
      // it to the previous day). Omitted from the email when unknown.
      const cycleStartRaw = slot.cyclus_id ? startDateByCycle.get(slot.cyclus_id) : null;
      const cycleStart = cycleStartRaw
        ? new Date(`${cycleStartRaw}T12:00:00Z`).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric", timeZone: tz })
        : null;
      const isUpfront = !!slot.cyclus_id && upfrontCycleIds.has(slot.cyclus_id);
      const paymentLine = isUpfront
        ? "Je rekent direct online af wanneer je je plek bevestigt."
        : "Je betaalt pas wanneer de cyclus start; de prijs wordt gedeeld door iedereen die meedoet — hoe minder spelers, hoe hoger ieders deel.";

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color:#1a1a1a;">
          <h2 style="margin:0 0 12px;">Hou je je vaste plek?${slot.cyclus_name ? ` (${slot.cyclus_name})` : ""}</h2>
          <p style="color:#374151;line-height:1.6;">${recipientName ? `Hi ${recipientName},` : "Hi,"}</p>
          ${renderCustomMessage(inviteMessage, recipientName)}
          <p style="color:#374151;line-height:1.6;">Je hebt voorrang om je vaste plek voor de volgende cyclus te houden. Laat ons weten of je doorgaat.</p>
          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;">
            <div style="font-weight:600;">${fmtDate}</div>
            <div style="color:#6b7280;">${fmtTime}</div>
            ${groupRange ? `<div style="color:#6b7280;font-size:13px;margin-top:4px;">${groupRange}</div>` : ""}
            ${slot.price_per_session ? `<div style="margin-top:6px;">EUR ${Number(slot.price_per_session).toFixed(2)} per sessie</div>` : ""}
            ${cycleStart ? `<div style="color:#6b7280;font-size:13px;margin-top:6px;">De nieuwe cyclus start op <strong>${cycleStart}</strong>.</div>` : ""}
          </div>
          <p style="color:#6b7280;font-size:13px;">${paymentLine}</p>
          ${deadline
            ? `<p style="color:#6b7280;font-size:13px;">Je houdt je vaste plek tot <strong>${deadline}</strong>. Reageer op tijd, anders komt je plek daarna vrij voor anderen.</p>`
            : `<p style="color:#6b7280;font-size:13px;">Je houdt je vaste plek zolang de voorrangsperiode loopt. Daarna komt je plek vrij voor anderen.</p>`}
          <p style="color:#6b7280;font-size:13px;">Je houdt je eigen dag en tijd. Wil je wisselen? Vraag het de academy — dat is het makkelijkst. Je kunt ook je plek vrijgeven en opnieuw boeken als er ergens plek is.</p>
          <div style="text-align:center;margin:28px 0;">
            <a href="${acceptUrl}" style="display:inline-block;background:#16a34a;color:white;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:4px;">Ja, ik hou mijn plek</a>
            <a href="${declineUrl}" style="display:inline-block;background:#ffffff;color:#1a1a1a;border:1px solid #d1d5db;padding:14px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:4px;">Nee, geef mijn plek vrij</a>
          </div>
          <p style="color:#6b7280;font-size:13px;">${deadline ? "Reageer je niet? Dan komt je plek na de deadline vrij." : "Reageer je niet? Dan komt je plek daarna vrij."} Je kunt daarna nog proberen te boeken via de boekingspagina zolang er plek is, of contact opnemen met de academy.</p>
          <p style="color:#9ca3af;font-size:12px;text-align:center;">Of open deze link: <a href="${claimUrl}" style="color:#f45d25;">${claimUrl}</a></p>
        </div>
      `;

      // Atomic claim-before-send (normal path): stamp invited_at only if it is
      // still NULL, so a crash mid-loop or a concurrent run can't double-send the
      // "reserve your spot" email. Test sends and explicit resends intentionally
      // re-send, so they skip the claim.
      if (!isTest && !resend) {
        const { data: claimedRows } = await supabase
          .from("slot_priority_claims")
          .update({ invited_at: new Date().toISOString() })
          .eq("id", c.id)
          .is("invited_at", null)
          .select("id");
        if (!claimedRows || claimedRows.length === 0) {
          skipped++;
          continue;
        }
      }

      // Pace sends a little so a big batch doesn't slam Resend's rate limit; the
      // retry wrapper still covers any 429s that slip through.
      if (sent > 0 || failed > 0) await sleep(120);
      const { error: sendErr } = await sendInviteWithRetry(resendClient, {
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [recipientEmail],
        subject: (() => {
          // Academy-authored subject if set (with {first_name} etc. substituted per
          // recipient), else the default. Re-sanitized after substitution so a name with a
          // stray newline can't defeat the header-injection guard. [TEST] prefix for tests.
          const base = sanitizeEmailSubject(
            inviteSubject ? substituteVars(inviteSubject, recipientName) : "Reserveer je plek voor de volgende cyclus",
          );
          return testEmail ? `[TEST] ${base}` : base;
        })(),
        html,
      });
      if (sendErr) {
        console.error("send error", sendErr);
        failed++;
        failedClaimIds.push(c.id);
        // Release the claim so a later run can retry this invitation.
        if (!isTest && !resend) {
          await supabase
            .from("slot_priority_claims")
            .update({ invited_at: null })
            .eq("id", c.id);
        }
        continue;
      }
      sent++;
      // Resend stamps the new send time here (the claim above was skipped).
      if (!isTest && resend) {
        await supabase
          .from("slot_priority_claims")
          .update({ invited_at: new Date().toISOString() })
          .eq("id", c.id);
      }
    }

    // Partial-failure alert: a high-volume rebook blast can silently drop invites
    // (per-send Resend errors or the time-budget early-stop). Alert ONCE with
    // counts + claim IDs (no PII) instead of per recipient, before the 200.
    if (failed > 0) {
      await notifySlackEdgeError(
        "send-priority-claim-invitation",
        `${failed} of ${eligible.length} priority-claim invites failed`,
        { sent, skipped, failed, failedClaimIds, isTest, resend: resend === true },
      );
    }
    // `remaining` (cycleId mode only): representative invites still un-sent for this
    // round AFTER this chunk, so the client can loop until drained. Failures rolled
    // invited_at back to NULL, so they reappear as eligible on the next call (transient
    // 429s get retried); the client stops on no-progress to avoid an endless loop.
    return new Response(JSON.stringify({ sent, skipped, failed, failedClaimIds, remaining: cycleRemaining }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : String(e);
    // Total-failure alert: auth/RLS query errors, body-parse failures, or any
    // unexpected throw abort the whole batch and otherwise reach only console.
    await notifySlackEdgeError("send-priority-claim-invitation", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
};

serve(handler);
