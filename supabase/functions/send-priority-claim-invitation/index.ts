import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  buildClaimUrl,
  resolveAppBase,
} from "../_shared/priority-claim-invite.ts";
import { personKeyOf } from "../_shared/person-identity.ts";
import { fetchGuestContacts, guestContactEmail, guestContactName } from "../_shared/rebook-guest-contact.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { sanitizeEmailSubject } from "../_shared/email-subject.ts";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { loadInvitationMetadata, type InvitationDb } from "../_shared/rebook-invitation-context.ts";
import { sendThenStampOne } from "../_shared/send-then-stamp.ts";
import { fetchAllKeyset } from "../_shared/paginate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const APP_BASE = resolveAppBase(Deno.env.get("PUBLIC_APP_URL"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  guest_players: { full_name: string | null; email: string | null; linked_profile: { email: string | null } | null } | null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Strip characters that would break the RFC 5322 From display name (quotes, backslash,
// angle brackets, CR/LF) and collapse whitespace, so an academy name with a comma/dot is
// safe once we wrap the whole display phrase in quotes.
const sanitizeFromName = (s: string) =>
  (s || "").replace(/["\\<>\r\n]/g, "").replace(/\s+/g, " ").trim().slice(0, 64);

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

// The academy's optional custom message. It LEADS the email (their own greeting +
// words), so render it as clean paragraphs — no box — like a letter from the academy.
// Substitute BEFORE escaping so an injected name is escaped too; blank lines collapse
// (the paragraph margins provide the spacing). Returns '' when there is no message.
const renderCustomMessage = (message: string, fullName: string): string => {
  const msg = (message || "").trim();
  if (!msg) return "";
  return substituteVars(msg, fullName)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p style="color:#374151;line-height:1.6;margin:0 0 12px;">${escapeHtml(line)}</p>`)
    .join("");
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
    let callerUserId: string | null = null;
    if (!isService) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
      callerEmail = data.user.email ?? null;
      callerUserId = data.user.id;
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
      // Authorize: the caller must MANAGE the cycle's academy — mirrors
      // bulk-rebook-cycle's academy_managers gate. Do NOT infer ownership from
      // availability_slots (rebook slots are is_public:true → world-readable) nor
      // from slot_priority_claims (a player can read their OWN claim). Both would let
      // a non-owner trigger a live invite blast on another tenant's round. Service
      // callers (internal retry) skip the JWT gate.
      if (!isService) {
        const { data: cyc } = await supabase
          .from("cycles").select("owner_id, owner_type").eq("id", cycleId).maybeSingle();
        const ownerId = (cyc as { owner_id: string | null; owner_type: string | null } | null)?.owner_id ?? null;
        const ownerType = (cyc as { owner_id: string | null; owner_type: string | null } | null)?.owner_type ?? null;
        let allowed = false;
        if (ownerId && ownerType === "academy" && callerUserId) {
          const { data: mgr } = await supabase
            .from("academy_managers").select("user_id")
            .eq("academy_profile_id", ownerId).eq("user_id", callerUserId).maybeSingle();
          allowed = !!mgr;
        }
        if (!allowed) {
          return new Response(JSON.stringify({ error: "Forbidden", sent: 0, remaining: 0 }), {
            status: 403,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          });
        }
      }
      // The cycle's slots (SERVICE client — trusted + complete; authorization is the academy_managers
      // gate above, not a per-row read). KEYSET-paginated by id (Codex round-7 #4) so a cycle with
      // >1000 slots can't silently truncate the slot set (which would drop every claim on the missing
      // slots from discovery → the drain reports completion while those recipients are untouched).
      const { rows: slotRows, error: sErr } = await fetchAllKeyset<{ id: string }>(
        (after, limit) => {
          let q = supabase.from("availability_slots").select("id").eq("cyclus_id", cycleId);
          if (after) q = q.gt("id", after);
          return q.order("id").limit(limit);
        },
        (r) => r.id,
      );
      if (sErr) throw sErr;
      const cycleSlotIds = slotRows.map((r) => r.id);
      // All pending claims on the round's slots, with slot start_time + recipient email presence, so
      // we can pick each (series, player)'s earliest-week claim as the representative AND skip claims
      // with no email (which can never be sent, so must not be counted as "remaining" or the drain
      // would never converge). Slots are batched by 200 to bound the .in() list; claims within each
      // batch are KEYSET-paginated by claim id (Codex round-7 #4) — stable against pending claims
      // changing status mid-read, and no >1000-row truncation.
      type RepClaim = { id: string; invited_at: string | null; slot_id: string; player_id: string | null; guest_player_id: string | null; rebook_group_id: string | null; availability_slots: { start_time: string } | null; profiles: { email: string | null } | null; guest_players: { email: string | null; linked_profile: { email: string | null } | null } | null };
      const repClaims: RepClaim[] = [];
      for (let i = 0; i < cycleSlotIds.length; i += 200) {
        const slotChunk = cycleSlotIds.slice(i, i + 200);
        const { rows: rc, error: rcErr } = await fetchAllKeyset<RepClaim>(
          (after, limit) => {
            let q = supabase
              .from("slot_priority_claims")
              .select("id, invited_at, slot_id, player_id, guest_player_id, rebook_group_id, availability_slots:slot_id(start_time), profiles:player_id(email), guest_players:guest_player_id(email, linked_profile:linked_profile_id(email))")
              .in("slot_id", slotChunk)
              .eq("status", "pending");
            if (after) q = q.gt("id", after);
            return q.order("id").limit(limit);
          },
          (r) => r.id,
        );
        if (rcErr) throw rcErr;
        // PostgREST types the to-one embeds as arrays; the runtime values are single objects.
        repClaims.push(...(rc as unknown as RepClaim[]));
      }
      // Sendability MUST match the actual delivery resolution: a guest is sendable iff they have a
      // VERIFIED contact (own → account, person_links/twin/linked), never the raw player_id — else a
      // guest deemed sendable here but skipped at send time would stall the drain's convergence.
      const repGuestMap = await fetchGuestContacts(supabase, repClaims.map((c) => c.guest_player_id));
      const hasEmail = (c: { player_id: string | null; guest_player_id: string | null; profiles: { email: string | null } | null }) =>
        c.guest_player_id ? !!guestContactEmail(c.guest_player_id, repGuestMap) : !!c.profiles?.email?.trim();
      const repByKey = new Map<string, { id: string; start: string; invited: boolean; sendable: boolean }>();
      for (const c of repClaims) {
        // GUEST-FIRST person key (FAM-02): a dual-key child (g:<guest>) and their linked parent
        // (p:<player>) are DISTINCT reps — the old player-first key collapsed both, so only one of
        // them was ever invited/drained.
        const pkey = personKeyOf(c);
        if (!pkey) continue;
        const gkey = c.rebook_group_id ?? c.slot_id;
        const start = c.availability_slots?.start_time ?? "";
        const k = `${gkey}|${pkey}`;
        const cur = repByKey.get(k);
        if (!cur || start < cur.start) repByKey.set(k, { id: c.id, start, invited: !!c.invited_at, sendable: hasEmail(c) });
      }
      // Reps with no email can never be sent. Mark their invite step RESOLVED
      // (stamp invited_at) so they drop out of `remaining` AND the owner's
      // uninvitedCount/"resume" banner — otherwise the banner could never clear and
      // a resume click would loop on a false "0 sent" success. No email is sent. The
      // only reader of invited_at (send-rebook-group-confirmation) never emails an
      // emailless member, so this is safe. The owner already acknowledged the
      // no-email count in the wizard.
      const emaillessRepIds = [...repByKey.values()].filter((r) => !r.invited && !r.sendable).map((r) => r.id);
      for (let i = 0; i < emaillessRepIds.length; i += 200) {
        const { error: emaillessErr } = await supabase
          .from("slot_priority_claims")
          .update({ invited_at: new Date().toISOString() })
          .in("id", emaillessRepIds.slice(i, i + 200))
          .is("invited_at", null);
        // Fail loud (Codex round-7 #8): a swallowed error here leaves emailless reps un-stamped → they
        // stay in `remaining` and the drain never converges (an endless "resume" that sends nothing).
        if (emaillessErr) throw emaillessErr;
      }
      // Only un-invited AND sendable (has email) reps are drainable.
      const eligibleReps = [...repByKey.values()].filter((r) => !r.invited && r.sendable).map((r) => r.id);
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
        const { data: cy, error: cyErr } = await supabase.from("cycles").select("settings").eq("id", cycleId).maybeSingle();
        // Fail loud (Codex round-7 #8): a swallowed error here silently drops the academy-authored
        // invitation copy → the drain's later chunks send the GENERIC default while the first chunk
        // used the custom text, so recipients of the same round get inconsistent emails.
        if (cyErr) throw cyErr;
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
        "id, claim_token, status, invited_at, slot_id, player_id, guest_player_id, rebook_group_id, profiles:player_id(full_name, email), guest_players:guest_player_id(full_name, email, linked_profile:linked_profile_id(email))"
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
    // PostgREST types the to-one embeds (profiles/guest_players) as arrays; the runtime
    // values are single objects — cast through unknown (same idiom as above).
    const allClaims = claims as unknown as ClaimRow[];
    const eligible = allClaims.filter(
      (c) => c.status === "pending" && (isTest || resend === true || !c.invited_at)
    );
    let skipped = allClaims.length - eligible.length;
    if (eligible.length === 0)
      return new Response(JSON.stringify({ sent: 0, skipped, remaining: cycleRemaining }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });

    // Assemble every piece of invitation metadata — slot info, academy branding (tz/name/reply-to),
    // per-cycle payment mode + start date, and the per-(group, player) session aggregation. FAIL-LOUD
    // on any read error and PAGINATED for the group-claims (Codex round-6 #1/#3): a swallowed error
    // here previously marked every invite "skipped" (slot read), sent the deferred-payment copy for an
    // upfront round (cycle read), or described a whole series as one session (group-claims read /
    // >1000-row truncation). Throws → the catch below → 500 + Slack, never a silent partial.
    const slotIds = [...new Set(eligible.map((c) => c.slot_id))];
    const groupIds = [...new Set(eligible.map((c) => c.rebook_group_id).filter((id): id is string => !!id))];
    const { slotMap, tzByAcademy, nameByAcademy, replyToByAcademy, upfrontCycleIds, startDateByCycle, groupInfo } =
      await loadInvitationMetadata(supabase as unknown as InvitationDb, slotIds, groupIds);

    let sent = 0;
    let failed = 0;
    // Sent-but-un-stamped (Codex round-6): the email went out but its invited_at stamp did not land, so
    // a retry re-sends (deduped by the deterministic idempotency key within Resend's 24h window). NOT a
    // clean success and NOT a permanent suppression — the claim stays eligible until it stamps.
    let unresolved = 0;
    const failedClaimIds: string[] = [];
    const unresolvedClaimIds: string[] = [];
    // First per-send failure reason (Resend rejection etc.) — surfaced to the caller + Slack so a
    // failed blast reports WHY, not just "N not sent" (the reason otherwise only reaches console).
    let firstSendError: string | null = null;
    // A per-invocation nonce makes the idempotency key of an explicit resend/test send DIFFERENT from
    // the original (so an owner-triggered re-nudge actually re-sends), while the key stays stable
    // across THIS invocation's internal Resend retries.
    const reqNonce = Date.now();

    // Wall-clock budget: under sustained Resend rate-limiting a big batch (pacing +
    // up to ~4.8s backoff per send) could blow the edge runtime's hard timeout, which
    // would surface to the caller as a total failure of the WHOLE batch (incl. claims
    // that already sent). Instead, stop early and report the not-yet-attempted claims
    // as retryable — their invited_at is still NULL, so a resend picks them up.
    const startedAt = Date.now();
    const TIME_BUDGET_MS = 100_000;

    // VERIFIED guest contacts (person_links → twin → linked, split-freeze) — a guest is reached at
    // their OWN email then their VERIFIED account, NEVER the raw claim.player_id.
    const guestMap = await fetchGuestContacts(supabase, eligible.map((c) => c.guest_player_id));

    for (let idx = 0; idx < eligible.length; idx++) {
      const c = eligible[idx];
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        for (let j = idx; j < eligible.length; j++) { failed++; failedClaimIds.push(eligible[j].id); }
        console.warn("send-priority-claim-invitation: time budget reached", { remaining: eligible.length - idx });
        break;
      }
      const slot = slotMap.get(c.slot_id);
      if (!slot) { skipped++; continue; }
      const playerKey = personKeyOf(c);
      if (!playerKey) { skipped++; continue; }
      const group = c.rebook_group_id ? groupInfo.get(`${c.rebook_group_id}|${playerKey}`) : undefined;
      // A test/preview send goes ONLY to the caller (never an attacker-chosen address); a real send
      // uses the VERIFIED guest contact (own → account, never player_id) or the pure profile's email.
      const recipientEmail = isTest
        ? (callerEmail?.trim() || null)
        : (c.guest_player_id ? guestContactEmail(c.guest_player_id, guestMap) : (c.profiles?.email?.trim() || null));
      // No email on file → nothing we can send; count as skipped so the caller's
      // totals reconcile to the number of claims it asked us to invite.
      if (!recipientEmail) { skipped++; continue; }
      // GUEST-FIRST name: a guest shows their own then their verified account name, never player_id.
      const recipientName = c.guest_player_id
        ? guestContactName(c.guest_player_id, guestMap)
        : (c.profiles?.full_name?.trim() || "");

      // Times are stored UTC; render in the academy's timezone (default
      // Europe/Amsterdam) so 18:00-local reads as 18:00, not 16:00.
      const tz = (slot.academy_profile_id && tzByAcademy.get(slot.academy_profile_id)) || "Europe/Amsterdam";
      const academyName = (slot.academy_profile_id && nameByAcademy.get(slot.academy_profile_id)) || "";
      const replyTo = (slot.academy_profile_id && replyToByAcademy.get(slot.academy_profile_id)) || "";
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
          ${inviteMessage
            ? `${renderCustomMessage(inviteMessage, recipientName)}
               <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0;" />`
            : `<h2 style="margin:0 0 12px;">Hou je je vaste plek?${slot.cyclus_name ? ` (${escapeHtml(slot.cyclus_name)})` : ""}</h2>
               <p style="color:#374151;line-height:1.6;">${recipientName ? `Hi ${escapeHtml(recipientName)},` : "Hi,"}</p>
               <p style="color:#374151;line-height:1.6;">Je hebt voorrang om je vaste plek voor de volgende cyclus te houden. Laat ons weten of je doorgaat.</p>`}
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
            <a href="${acceptUrl}" style="display:block;background:#16a34a;color:white;padding:16px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:16px;">Ja, ik hou mijn plek</a>
            ${isUpfront ? `<p style="color:#6b7280;font-size:12px;margin:8px 0 0;">Je rondt daarna direct de online betaling af.</p>` : ""}
            <p style="margin:14px 0 0;"><a href="${declineUrl}" style="color:#6b7280;font-size:14px;">Nee, ik geef mijn plek vrij</a></p>
          </div>
          <p style="color:#6b7280;font-size:13px;">${deadline ? "Reageer je niet? Dan komt je plek na de deadline vrij." : "Reageer je niet? Dan komt je plek daarna vrij."} Je kunt daarna nog proberen te boeken via de boekingspagina zolang er plek is, of contact opnemen met de academy.</p>
          <p style="color:#9ca3af;font-size:12px;text-align:center;">Of open deze link: <a href="${claimUrl}" style="color:#f45d25;">${claimUrl}</a></p>
          <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0 12px;" />
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin:0;">
            ${academyName ? `Je ontvangt deze e-mail omdat je traint bij <strong>${escapeHtml(academyName)}</strong>.` : ""}
            Verzonden via PadelTrainer.ai${academyName ? ` namens ${escapeHtml(academyName)}` : ""}${replyTo ? " — vragen? Antwoord gerust op deze e-mail." : "."}
          </p>
        </div>
      `;

      // Pace sends a little so a big batch doesn't slam Resend's rate limit; sendResendEmail still
      // backs off on any 429 that slips through.
      if (sent > 0 || failed > 0 || unresolved > 0) await sleep(120);
      // Brand the sender with the academy name (a cold recipient recognises their academy, not
      // "PadelTrainer.ai"); wrap the whole display phrase in quotes so a name with a comma/dot stays a
      // valid RFC 5322 From. Reply-to routes replies to the academy, and a mailto List-Unsubscribe (to
      // that same address — NOT the decline link, which would give up their spot) gives large mailbox
      // providers the opt-out signal a bulk-ish blast needs.
      const fromName = academyName ? `${sanitizeFromName(academyName)} via PadelTrainer.ai` : "PadelTrainer.ai";
      const inviteHeaders: Record<string, string> = {};
      if (replyTo) inviteHeaders["List-Unsubscribe"] = `<mailto:${replyTo}?subject=Uitschrijven>`;
      // Academy-authored subject if set (with {first_name} etc. substituted per recipient), else the
      // default (deadline appended when known). Re-sanitized after substitution so a stray newline in
      // a name can't defeat the header-injection guard. [TEST] prefix for tests.
      const subject = (() => {
        const base = sanitizeEmailSubject(
          inviteSubject
            ? substituteVars(inviteSubject, recipientName)
            : deadline
              ? `Reserveer je plek voor de volgende cyclus (vóór ${deadline})`
              : "Reserveer je plek voor de volgende cyclus",
        );
        return testEmail ? `[TEST] ${base}` : base;
      })();

      // SEND-THEN-STAMP (Codex round-6): send FIRST with a deterministic idempotency key, then stamp
      // invited_at only on a CONFIRMED send. A failed send therefore never leaves a stamp — removing
      // the permanent-suppression window the old claim-before-send had (send-fail + a failed
      // invited_at-clear left the claim stamped-but-unsent forever). A concurrent run re-sends the SAME
      // key → Resend dedupes within 24h. A post-send stamp failure is UNRESOLVED (retryable), never a
      // clean skip. Normal drain = a stable per-claim key; an explicit resend/test varies by nonce so
      // it actually re-sends.
      const idempotencyKey = (!isTest && !resend)
        ? `priority-claim-invite:${c.id}`
        : `priority-claim-invite:${c.id}:${reqNonce}`;
      // Stamp AFTER a confirmed send. Normal path stamps only where still NULL (a concurrent run's
      // stamp is then a harmless 0-row no-op, not an error); test sends never stamp.
      const stamp = isTest ? null : (async () => {
        let q = supabase.from("slot_priority_claims").update({ invited_at: new Date().toISOString() }).eq("id", c.id);
        if (!resend) q = q.is("invited_at", null);
        const { error } = await q;
        return { error };
      });
      const { outcome, error: sendError } = await sendThenStampOne({
        send: async () => {
          const o = await sendResendEmail(
            resendApiKey,
            {
              from: `"${fromName}" <noreply@app.padeltrainer.ai>`,
              to: [recipientEmail],
              subject,
              html,
              ...(replyTo ? { reply_to: replyTo } : {}),
              ...(Object.keys(inviteHeaders).length ? { headers: inviteHeaders } : {}),
            },
            { idempotencyKey },
          );
          return { ok: o.ok, error: o.ok ? undefined : o.error };
        },
        stamp,
      });
      if (outcome === "send_failed") {
        if (!firstSendError && sendError) firstSendError = sendError;
        failed++;
        failedClaimIds.push(c.id);
        continue; // invited_at stays NULL → the claim is still eligible for a later retry
      }
      if (outcome === "unresolved") {
        // The email went out but invited_at did not stamp: surface it (NOT clean success). The claim
        // stays eligible; a retry re-sends deduped by the idempotency key (24h) and re-stamps.
        sent++;
        unresolved++;
        unresolvedClaimIds.push(c.id);
        continue;
      }
      sent++;
    }

    // Partial-failure alert: a high-volume rebook blast can silently drop invites (per-send Resend
    // errors, the time-budget early-stop, or a sent-but-un-stamped UNRESOLVED). Alert ONCE with counts
    // + claim IDs (no PII) instead of per recipient.
    if (failed > 0 || unresolved > 0) {
      await notifySlackEdgeError(
        "send-priority-claim-invitation",
        `${failed} failed / ${unresolved} unresolved of ${eligible.length} priority-claim invites${firstSendError ? `: ${firstSendError}` : ""}`,
        { sent, skipped, failed, unresolved, failedClaimIds, unresolvedClaimIds, sampleError: firstSendError, isTest, resend: resend === true },
      );
    }
    // `remaining` (cycleId mode only): representative invites still un-sent for this round AFTER this
    // chunk, so the client can loop until drained. Send-then-stamp: a failed send never stamped
    // invited_at, and an UNRESOLVED send left it NULL too, so both reappear as eligible on the next
    // call (transient 429s retried; the recipient is protected from a duplicate by the idempotency key
    // within 24h). The client stops on no-progress to avoid an endless loop.
    return new Response(JSON.stringify({ sent, skipped, failed, unresolved, failedClaimIds, unresolvedClaimIds, remaining: cycleRemaining, sampleError: firstSendError ?? undefined }), {
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
