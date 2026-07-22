// Group-captain rebooking, Phase 4: notify the people the captain booked.
//
// Fired (fire-and-forget, token-gated) after a successful rebook_group_apply (deferred) or
// rebook_group_manage (upfront). For every group member the captain booked — i.e. claims with
// booked_by_* set, status 'claimed', and confirmation_sent_at still NULL — we send ONE email:
//   • EXISTING members (someone the academy had already invited this round) → "X re-booked you".
//   • NEW people the captain added (never invited → no invited_at on ANY of their claims)
//     → "you've been added by X". This welcome email is also the GDPR consent touchpoint.
// The captain themselves is excluded (their own claims carry booked_by_* = NULL).
//
// Idempotency: claim-before-send. We atomically stamp confirmation_sent_at (only where still
// NULL) BEFORE sending and clear it again on send failure, so concurrent runs / re-invocations
// never double-send and a transient Resend error stays retryable.
//
// Token-gated + self-authenticating (verify_jwt = false): the anon captain may be logged out.
// The claim_token is the capability; everything DB-side runs as the service role after the gate.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { effectiveGuestEmail } from "../_shared/priority-claim-invite.ts";
import { personKeyOf, personRefOf, personContactEmail, personDisplayName } from "../_shared/person-identity.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const FROM = "PadelTrainer.ai <noreply@app.padeltrainer.ai>";

// substitute BEFORE escape, exactly like send-priority-claim-invitation, so an injected name is
// HTML-escaped after replacement.
const escapeHtml = (s: string) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const firstNameOf = (full?: string | null, first?: string | null): string => {
  const f = (first ?? "").trim();
  if (f) return f;
  const fl = (full ?? "").trim();
  return fl.split(/\s+/)[0] || fl || "";
};

// Hash the capability token so the per-token rate-limit key never stores the raw secret.
const sha256Hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
};

interface NameEmail { full_name?: string | null; first_name?: string | null; email?: string | null; linked_profile?: { email?: string | null } | null }
interface SlotJoin { start_time: string; end_time: string; cyclus_id: string | null; cyclus_name: string | null; academy_profile_id: string | null }
interface ClaimRow {
  id: string;
  invited_at: string | null;
  slot_id: string;
  player_id: string | null;
  guest_player_id: string | null;
  profiles: NameEmail | null;
  guest_players: NameEmail | null;
  availability_slots: SlotJoin | null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) return json({ ok: false, error: "email_not_configured" }, 500);
    const admin = createClient(supabaseUrl, serviceKey);

    const { token } = await req.json();
    if (!token || typeof token !== "string") return json({ ok: false, error: "token is required" }, 400);

    // Token gate: a valid GROUP claim. Its holder is the captain. A READ error must fail loud —
    // treating it as "claim_not_found" would silently drop a whole group's confirmations.
    const { data: cap, error: capErr } = await admin
      .from("slot_priority_claims")
      .select("id, rebook_group_id, player_id, guest_player_id, profiles:player_id(full_name), guest_players:guest_player_id(full_name, first_name)")
      .eq("claim_token", token)
      .maybeSingle();
    if (capErr) throw new Error(`token gate read failed: ${capErr.message}`);
    if (!cap) return json({ ok: false, error: "claim_not_found" }, 404);
    if (!cap.rebook_group_id) return json({ ok: false, reason: "not_a_group" });
    const groupId = cap.rebook_group_id as string;
    // GUEST-FIRST captain name (FAM-02), keyed on the captain claim's ids: a dual-key captain
    // shows their OWN name; the guest's first_name is preferred only when the captain IS the guest.
    const capRef = personRefOf({ player_id: cap.player_id, guest_player_id: cap.guest_player_id });
    const captainName = firstNameOf(
      personDisplayName(
        { player_id: cap.player_id, guest_player_id: cap.guest_player_id },
        { profileName: (cap.profiles as NameEmail | null)?.full_name, guestName: (cap.guest_players as NameEmail | null)?.full_name },
        "",
      ),
      capRef?.guestPlayerId ? (cap.guest_players as NameEmail | null)?.first_name : null,
    ) || "Je groep";

    // Per-token throttle (best-effort read-modify-write over rate_limits; service-role bypasses its
    // RLS). confirmation_sent_at clears on send failure (so a transient Resend blip stays retryable),
    // which would otherwise let a token-holder loop-invoke to burn Resend quota via an always-failing
    // recipient. 6/15min is ample for the legit apply (+ later manage) flow; a small over-count under
    // concurrency is harmless for an abuse bound.
    const RL_KEY = "rbgc:" + (await sha256Hex(token)).slice(0, 32);
    const RL_ENDPOINT = "send-rebook-group-confirmation";
    const RL_MAX = 6, RL_WINDOW_MS = 15 * 60 * 1000;
    const nowMs = Date.now();
    const { data: rl } = await admin.from("rate_limits")
      .select("request_count, window_start")
      .eq("identifier", RL_KEY).eq("endpoint", RL_ENDPOINT).maybeSingle();
    const inWindow = rl?.window_start && new Date(rl.window_start).getTime() > nowMs - RL_WINDOW_MS;
    const rlCount = inWindow ? ((rl?.request_count ?? 0) + 1) : 1;
    if (inWindow) {
      await admin.from("rate_limits").update({ request_count: rlCount })
        .eq("identifier", RL_KEY).eq("endpoint", RL_ENDPOINT);
    } else {
      await admin.from("rate_limits").upsert(
        { identifier: RL_KEY, endpoint: RL_ENDPOINT, request_count: 1, window_start: new Date(nowMs).toISOString() },
        { onConflict: "identifier,endpoint" });
    }
    if (rlCount > RL_MAX) return json({ ok: true, throttled: true, sent: 0, skipped: 0, failed: 0 });

    // Everyone the captain booked, not yet confirmed. booked_by_* set ⇒ not the captain's own row.
    const { data: rows, error: rowsErr } = await admin
      .from("slot_priority_claims")
      .select(
        "id, invited_at, slot_id, player_id, guest_player_id, " +
        "profiles:player_id(full_name, email), guest_players:guest_player_id(full_name, first_name, email, linked_profile:linked_profile_id(email)), " +
        "availability_slots:slot_id(start_time, end_time, cyclus_id, cyclus_name, academy_profile_id)",
      )
      .eq("rebook_group_id", groupId)
      .eq("status", "claimed")
      .is("confirmation_sent_at", null)
      .or("booked_by_player_id.not.is.null,booked_by_guest_player_id.not.is.null");
    if (rowsErr) throw new Error(`member read failed: ${rowsErr.message}`); // fail loud — not a silent zero-send
    const claims = (rows ?? []) as unknown as ClaimRow[];
    if (claims.length === 0) return json({ ok: true, sent: 0, skipped: 0, failed: 0 });

    // Academy timezone (slots stored UTC) + cycle payment-mode/start, mirrored from the invite fn.
    const acadIds = [...new Set(claims.map((c) => c.availability_slots?.academy_profile_id).filter((x): x is string => !!x))];
    const tzByAcademy = new Map<string, string>();
    if (acadIds.length > 0) {
      const { data: acads, error: acadErr } = await admin.from("academy_profiles").select("id, timezone").in("id", acadIds);
      if (acadErr) throw new Error(`academy timezone read failed: ${acadErr.message}`);
      for (const a of (acads ?? []) as Array<{ id: string; timezone: string | null }>) {
        tzByAcademy.set(a.id, a.timezone || "Europe/Amsterdam");
      }
    }
    const cyclusIds = [...new Set(claims.map((c) => c.availability_slots?.cyclus_id).filter((x): x is string => !!x))];
    const upfrontCycles = new Set<string>();
    const startByCycle = new Map<string, string>();
    if (cyclusIds.length > 0) {
      const { data: cycleRows, error: cycleErr } = await admin.from("cycles").select("id, settings, start_date").in("id", cyclusIds);
      // Fail loud: on error upfrontCycles stays empty → EVERY member gets the "pay your own share"
      // (deferred) copy, wrong for an upfront round.
      if (cycleErr) throw new Error(`cycle payment-mode read failed: ${cycleErr.message}`);
      for (const r of (cycleRows ?? []) as Array<{ id: string; settings: Record<string, unknown> | null; start_date: string | null }>) {
        if ((r.settings || {}).rebook_payment_mode === "upfront") upfrontCycles.add(r.id);
        if (r.start_date) startByCycle.set(r.id, r.start_date);
      }
    }

    // Group claims by member (one email per person; a member has one claim per weekly slot).
    interface Member { key: string; player_id: string | null; guest_player_id: string | null; rep: ClaimRow; sessions: number; firstStart: string; lastStart: string }
    const members = new Map<string, Member>();
    for (const c of claims) {
      if (!c.availability_slots) continue;
      // GUEST-FIRST member key (FAM-02): a dual-key child (g:<guest>) and their linked parent
      // (p:<player>) are DISTINCT members. The old player-first key collapsed both into one, so
      // sessions merged and only ONE confirmation email went out.
      const key = personKeyOf(c);
      if (!key) continue;
      const start = c.availability_slots.start_time;
      const m = members.get(key);
      if (!m) {
        members.set(key, {
          key, player_id: c.player_id, guest_player_id: c.guest_player_id, rep: c,
          sessions: 1, firstStart: start, lastStart: start,
        });
      } else {
        m.sessions++;
        if (start < m.firstStart) m.firstStart = start;
        if (start > m.lastStart) m.lastStart = start;
      }
    }

    // New vs existing: a member is "existing" iff the academy already invited them this round —
    // i.e. ANY of their claims in this group carries invited_at (bulk-rebook-cycle stamps only one
    // representative claim per member, so check across all their rows, not just the booked subset).
    // Existing → "X re-booked you"; never-invited → a "you've been added by X" welcome.
    const { data: invitedRows, error: invitedErr } = await admin
      .from("slot_priority_claims")
      .select("player_id, guest_player_id")
      .eq("rebook_group_id", groupId)
      .not("invited_at", "is", null);
    // Fail loud: an error here would leave invitedKeys empty → EVERY member wrongly treated as "new"
    // → the wrong (welcome vs re-booked) email + GDPR-consent copy.
    if (invitedErr) throw new Error(`invited-state read failed: ${invitedErr.message}`);
    const invitedKeys = new Set(
      (invitedRows ?? []).map((r: { player_id: string | null; guest_player_id: string | null }) => personKeyOf(r))
        .filter((k): k is string => !!k),
    );

    let sent = 0, skipped = 0, failed = 0;

    for (const m of members.values()) {
      // GUEST-FIRST contact email (FAM-02), keyed on the member's ids: the guest's OWN address
      // wins (effectiveGuestEmail = guest.email ?? linked_profile.email); the linked profile is the
      // fallback only when the guest has none. The old profile-first `||` mailed a child at the parent.
      const recipientEmail = (personContactEmail(
        { player_id: m.player_id, guest_player_id: m.guest_player_id },
        { profileEmail: m.rep.profiles?.email, guestEmail: effectiveGuestEmail(m.rep.guest_players) },
      ) || "").trim();
      if (!recipientEmail) { skipped++; continue; } // no email on file → can't send (leave unstamped)

      // Claim-before-send: stamp confirmation_sent_at on THIS member's still-NULL claims and only
      // proceed if we won the row (RETURNING non-empty). Prevents double-send across runs.
      // GUEST-FIRST scope (FAM-02): stamp exactly this person's rows. A guest → guest_player_id;
      // a profile → player_id AND guest_player_id IS NULL, so a profile stamp NEVER consumes a
      // dual-key child's rows (which share the parent's player_id). personRefOf picks guest-first.
      const ref = personRefOf({ player_id: m.player_id, guest_player_id: m.guest_player_id });
      let stampQ = admin.from("slot_priority_claims")
        .update({ confirmation_sent_at: new Date().toISOString() })
        .eq("rebook_group_id", groupId).is("confirmation_sent_at", null);
      stampQ = ref?.guestPlayerId
        ? stampQ.eq("guest_player_id", ref.guestPlayerId)
        : stampQ.eq("player_id", ref!.playerId).is("guest_player_id", null);
      const { data: stamped, error: stampErr } = await stampQ.select("id");
      // Fail loud: a stamp ERROR is NOT "already sent" — treating it as an ordinary skip would
      // silently drop this member's confirmation. A genuine empty result (someone else won the row)
      // is the legitimate skip.
      if (stampErr) throw new Error(`confirmation claim-stamp failed: ${stampErr.message}`);
      if (!stamped || stamped.length === 0) { skipped++; continue; }

      const slot = m.rep.availability_slots!;
      const tz = (slot.academy_profile_id && tzByAcademy.get(slot.academy_profile_id)) || "Europe/Amsterdam";
      const start = new Date(m.firstStart);
      const startTime = start.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: tz });
      const weekday = start.toLocaleDateString("nl-NL", { weekday: "long", timeZone: tz });
      const seriesLine = `Elke ${weekday} om ${startTime} · ${m.sessions} ${m.sessions === 1 ? "sessie" : "sessies"}`;
      const range = `${new Date(m.firstStart).toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: tz })} t/m ${new Date(m.lastStart).toLocaleDateString("nl-NL", { day: "numeric", month: "long", timeZone: tz })}`;
      const cycleStart = slot.cyclus_id && startByCycle.has(slot.cyclus_id)
        ? new Date(`${startByCycle.get(slot.cyclus_id)}T12:00:00`).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric", timeZone: tz })
        : null;
      const isUpfront = slot.cyclus_id ? upfrontCycles.has(slot.cyclus_id) : false;

      // GUEST-FIRST recipient name (FAM-02), keyed on the member's ids.
      const recipientFirst = escapeHtml(firstNameOf(
        personDisplayName(
          { player_id: m.player_id, guest_player_id: m.guest_player_id },
          { profileName: m.rep.profiles?.full_name, guestName: m.rep.guest_players?.full_name },
          "",
        ),
        ref?.guestPlayerId ? m.rep.guest_players?.first_name : null,
      ));
      const captain = escapeHtml(captainName);
      const cyclus = escapeHtml(slot.cyclus_name || "de volgende cyclus");
      const isNew = !invitedKeys.has(m.key);

      const lead = isNew
        ? `${captain} heeft je toegevoegd aan ${cyclus}. Je doet mee met de volgende cyclus!`
        : `${captain} heeft je opnieuw ingeschreven voor ${cyclus}. Je vaste plek voor de volgende cyclus is gereserveerd.`;
      const payLine = isUpfront
        ? `${captain} heeft voor de hele groep betaald — jij hoeft verder niets te doen.`
        : `Je betaalt je eigen deel wanneer de cyclus start; de prijs wordt gedeeld door iedereen die meedoet.`;
      const subject = isNew ? `Je bent toegevoegd aan ${slot.cyclus_name || "de volgende cyclus"}` : "Je bent opnieuw ingeschreven voor de volgende cyclus";

      const html = `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color:#1a1a1a;">
    <h2 style="margin:0 0 12px;">${isNew ? "Je doet mee!" : "Je plek is gereserveerd"}</h2>
    <p style="color:#374151;line-height:1.6;">${recipientFirst ? `Hi ${recipientFirst},` : "Hi,"}</p>
    <p style="color:#374151;line-height:1.6;">${lead}</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0;">
      <div style="font-weight:600;">${escapeHtml(seriesLine)}</div>
      <div style="color:#6b7280;font-size:13px;margin-top:4px;">${escapeHtml(range)}</div>
      ${cycleStart ? `<div style="color:#6b7280;font-size:13px;margin-top:6px;">De nieuwe cyclus start op <strong>${escapeHtml(cycleStart)}</strong>.</div>` : ""}
    </div>
    <p style="color:#6b7280;font-size:13px;">${payLine}</p>
    <p style="color:#6b7280;font-size:13px;">Vragen of wil je toch niet meedoen? Neem contact op met de academy.</p>
  </div>`;

      const outcome = await sendResendEmail(resendApiKey, { from: FROM, to: [recipientEmail], subject, html });
      if (outcome.ok) {
        sent++;
      } else {
        // Send failed → clear the stamp so a later run retries this member. Bounded to the exact
        // rows we won (.in id), and scoped guest-first to mirror the stamp above.
        let clearQ = admin.from("slot_priority_claims")
          .update({ confirmation_sent_at: null })
          .eq("rebook_group_id", groupId);
        clearQ = ref?.guestPlayerId
          ? clearQ.eq("guest_player_id", ref.guestPlayerId)
          : clearQ.eq("player_id", ref!.playerId).is("guest_player_id", null);
        const { error: clearErr } = await clearQ.in("id", (stamped as Array<{ id: string }>).map((r) => r.id));
        if (clearErr) {
          // The stamp could not be cleared → confirmation_sent_at stays set → this member's
          // confirmation is permanently suppressed (never retried). Surface it loudly.
          await notifySlackEdgeError("send-rebook-group-confirmation", "stamp clear failed after a send error — confirmation permanently suppressed for a member", { groupId, error: String(clearErr.message ?? clearErr) });
        }
        failed++;
      }
    }

    return json({ ok: true, sent, skipped, failed });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await notifySlackEdgeError("send-rebook-group-confirmation", message);
    return json({ ok: false, error: "internal_error", message }, 500);
  }
});
