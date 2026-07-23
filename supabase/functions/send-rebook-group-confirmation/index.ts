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
// Idempotency: SEND-THEN-STAMP with a deterministic per-(group, member) Resend idempotency key. We
// send first, then stamp confirmation_sent_at only on a confirmed send — so a failed send never
// leaves a stamp that permanently suppresses the confirmation. The idempotency key dedupes duplicate
// sends only within Resend's 24h key window; it is NOT durable recovery. A post-send stamp failure is
// reported as an UNRESOLVED send (ok:false, unresolved>0), and durable recovery of those is a
// mandatory PR 10c acceptance item (the v2 outbox), NOT something this function guarantees.
//
// Token-gated + self-authenticating (verify_jwt = false): the anon captain may be logged out.
// The claim_token is the capability; everything DB-side runs as the service role after the gate.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { personKeyOf, personRefOf } from "../_shared/person-identity.ts";
import { fetchGuestContacts, guestContactEmail, guestContactName } from "../_shared/rebook-guest-contact.ts";
import { gateGroupConfirmation, groupConfirmOk, type MemberConfirmStep, runGroupConfirmations } from "../_shared/rebook-group-confirm.ts";
import { fetchAllKeyset } from "../_shared/paginate.ts";

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
    // A guest captain's name resolves from the guest's OWN verified relationships, never player_id.
    const capContacts = await fetchGuestContacts(admin, [cap.guest_player_id]);
    const captainName = firstNameOf(
      capRef?.guestPlayerId
        ? guestContactName(capRef.guestPlayerId, capContacts)
        : ((cap.profiles as NameEmail | null)?.full_name ?? ""),
      capRef?.guestPlayerId ? (cap.guest_players as NameEmail | null)?.first_name : null,
    ) || "Je groep";

    // Admission ordering (Codex round-9 #3): a CHEAP limit(1) work probe → the atomic rate-limit
    // consume → only THEN the full (many-page) scan. A no-work call returns WITHOUT consuming an
    // allowance; a throttled call returns WITHOUT scanning. On this verify_jwt=false endpoint that stops
    // a valid token from forcing repeated expensive scans while throttled. Throttled is NOT clean
    // success (the caller surfaces it); DURABLE recovery of a throttled/failed/unresolved confirmation
    // is a PR 10c outbox item (this fn's idempotency key only dedupes 24h).
    const gate = await gateGroupConfirmation<ClaimRow>({
      hasWork: async () => {
        const { data, error } = await admin
          .from("slot_priority_claims")
          .select("id")
          .eq("rebook_group_id", groupId)
          .eq("status", "claimed")
          .is("confirmation_sent_at", null)
          .or("booked_by_player_id.not.is.null,booked_by_guest_player_id.not.is.null")
          .limit(1);
        if (error) throw new Error(`member probe failed: ${error.message}`);
        return (data?.length ?? 0) > 0;
      },
      consumeAllowance: async () => {
        const RL_KEY = "rbgc:" + (await sha256Hex(token)).slice(0, 32);
        const { data: allowed, error: rlErr } = await admin.rpc("consume_rate_limit", {
          _identifier: RL_KEY, _endpoint: "send-rebook-group-confirmation", _max: 6, _window_ms: 15 * 60 * 1000,
        });
        if (rlErr) throw new Error(`rate-limit consume failed: ${rlErr.message}`); // fail CLOSED
        return allowed === true;
      },
      // Full KEYSET scan (round-8 #5): bounded per page, no >1000-claim truncation.
      scan: async () => {
        const { rows, error: rowsErr } = await fetchAllKeyset<ClaimRow & { id: string }>(
          (after, limit) => {
            let q = admin
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
            if (after) q = q.gt("id", after);
            return q.order("id").limit(limit) as unknown as PromiseLike<{ data: unknown; error: { message?: string } | null }>;
          },
          (r) => r.id,
        );
        if (rowsErr) throw new Error(`member read failed: ${rowsErr.message}`); // fail loud — not a silent zero-send
        return rows as unknown as ClaimRow[];
      },
    });
    if (gate.kind === "no_work") return json({ ok: true, sent: 0, skipped: 0, failed: 0, unresolved: 0 });
    if (gate.kind === "throttled") return json({ ok: false, throttled: true, sent: 0, skipped: 0, failed: 0, unresolved: 0 });
    const claims = gate.claims;

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

    // VERIFIED guest contacts for the members — a guest is reached at their OWN email then their
    // VERIFIED account (person_links → twin → linked, split-freeze), NEVER the raw claim.player_id.
    const guestMap = await fetchGuestContacts(admin, [...members.values()].map((m) => m.guest_player_id));

    // New vs existing: a member is "existing" iff the academy already invited them this round —
    // i.e. ANY of their claims in this group carries invited_at (bulk-rebook-cycle stamps only one
    // representative claim per member, so check across all their rows, not just the booked subset).
    // Existing → "X re-booked you"; never-invited → a "you've been added by X" welcome.
    // KEYSET-paginated (Codex round-8 #5): a >1000-claim group would truncate here → members past the
    // cap wrongly treated as "new" → the wrong (welcome vs re-booked) email + GDPR-consent copy.
    const { rows: invitedRows, error: invitedErr } = await fetchAllKeyset<{ id: string; player_id: string | null; guest_player_id: string | null }>(
      (after, limit) => {
        let q = admin
          .from("slot_priority_claims")
          .select("id, player_id, guest_player_id")
          .eq("rebook_group_id", groupId)
          .not("invited_at", "is", null);
        if (after) q = q.gt("id", after);
        return q.order("id").limit(limit) as unknown as PromiseLike<{ data: unknown; error: { message?: string } | null }>;
      },
      (r) => r.id,
    );
    // Fail loud: an error here would leave invitedKeys empty → EVERY member wrongly treated as "new"
    // → the wrong (welcome vs re-booked) email + GDPR-consent copy.
    if (invitedErr) throw new Error(`invited-state read failed: ${invitedErr.message}`);
    const invitedKeys = new Set(
      invitedRows.map((r: { player_id: string | null; guest_player_id: string | null }) => personKeyOf(r))
        .filter((k): k is string => !!k),
    );

    const tally = await runGroupConfirmations(members.values(), async (m): Promise<MemberConfirmStep> => {
      // VERIFIED contact email: a guest is reached at their OWN email then their VERIFIED account,
      // never the raw player_id; a pure profile uses its own email.
      const recipientEmail = (m.guest_player_id
        ? guestContactEmail(m.guest_player_id, guestMap)
        : (m.rep.profiles?.email?.trim() || null)) ?? "";
      if (!recipientEmail) return "skipped"; // no verified email → can't send (leave unstamped)

      // GUEST-FIRST stamp scope (FAM-02): a guest → guest_player_id; a profile → player_id AND
      // guest_player_id IS NULL, so a profile stamp NEVER consumes a dual-key child's rows.
      const ref = personRefOf({ player_id: m.player_id, guest_player_id: m.guest_player_id });

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

      // VERIFIED recipient name: a guest's own then their verified account name, never player_id.
      const recipientFirst = escapeHtml(firstNameOf(
        m.guest_player_id ? guestContactName(m.guest_player_id, guestMap) : (m.rep.profiles?.full_name ?? ""),
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

      // SEND-THEN-STAMP with a deterministic per-(group, member) idempotency key. A timeout after
      // Resend accepted the send cannot become a duplicate (the retry's key is a no-op at Resend),
      // and because we stamp ONLY after a confirmed send, a failed send never leaves a stamp that
      // permanently suppresses the confirmation. A concurrent run re-sends (deduped) and both stamp.
      const outcome = await sendResendEmail(
        resendApiKey,
        { from: FROM, to: [recipientEmail], subject, html },
        { idempotencyKey: `rebook-group-confirm:${groupId}:${m.key}` },
      );
      if (!outcome.ok) return "send_failed";
      // Record the send: stamp confirmation_sent_at on this person's still-NULL rows (guest-first).
      let stampQ = admin.from("slot_priority_claims")
        .update({ confirmation_sent_at: new Date().toISOString() })
        .eq("rebook_group_id", groupId).is("confirmation_sent_at", null);
      stampQ = ref?.guestPlayerId
        ? stampQ.eq("guest_player_id", ref.guestPlayerId)
        : stampQ.eq("player_id", ref!.playerId).is("guest_player_id", null);
      const { error: stampErr } = await stampQ;
      if (stampErr) {
        // The email went out, but its confirmation_sent_at stamp did NOT land, so the send is
        // UNRESOLVED: a later retry will re-send. Provider idempotency only dedupes within Resend's
        // 24h key window — beyond that (or on a different key) the recipient gets a duplicate. Durable
        // recovery of these unresolved sends is a mandatory PR 10c acceptance item (v2 outbox).
        await notifySlackEdgeError("send-rebook-group-confirmation", "confirmation-sent stamp failed after a successful send — send is UNRESOLVED (idempotency dedupes for 24h only; durable recovery is a PR 10c item)", { groupId, memberKey: m.key, error: String(stampErr.message ?? stampErr) });
        return "unresolved";
      }
      return "sent";
    });

    // ok ONLY when nothing failed to send AND every send was stamped. A provider send failure OR an
    // unresolved (sent-but-un-stamped) send degrades this to a partial result the caller/cron must
    // not treat as clean success.
    return json({ ok: groupConfirmOk(tally), ...tally });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await notifySlackEdgeError("send-rebook-group-confirmation", message);
    return json({ ok: false, error: "internal_error", message }, 500);
  }
});
