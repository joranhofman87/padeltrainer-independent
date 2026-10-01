import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import {
  buildClaimUrl,
  resolveAppBase,
} from "../_shared/priority-claim-invite.ts";
import { personKeyOf } from "../_shared/person-identity.ts";
import { fetchGuestContacts, guestContactEmail, guestContactName } from "../_shared/rebook-guest-contact.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";
import { sanitizeEmailSubject } from "../_shared/email-subject.ts";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { loadInvitationMetadata, type InvitationDb, groupSeriesKey } from "../_shared/rebook-invitation-context.ts";
import { sendThenStampOne } from "../_shared/send-then-stamp.ts";
import { fetchAllInChunks, fetchAllKeyset } from "../_shared/paginate.ts";

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
  /** `user_id` is the ACCOUNT behind the profile — the enqueue refuses a claim whose stated
   *  recipient is not the claim's own, and this is what it is checked against. */
  profiles: { full_name: string | null; email: string | null; user_id: string | null } | null;
  guest_players: { full_name: string | null; email: string | null } | null;
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
    // ONLY THE TEST PATH TALKS TO THE PROVIDER NOW. A live send enqueues a durable row and the D7
    // worker owns the provider call, so a missing edge-function secret must not block otherwise
    // valid enqueues — which it did, before any of the request was even examined. The check moved
    // to the one place that still needs the key, further down.
    const resendApiKey = Deno.env.get("RESEND_API_KEY");

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
    const { claimIds, slotId, cycleId, roundId, limit, testEmail, resend, customMessage, customSubject } = body as {
      claimIds?: string[];
      slotId?: string;
      cycleId?: string;
      /**
       * The D7 rebook round these claims belong to. REQUIRED for a live send: the protected event
       * type `rebook_priority_claim_invite` declares `requires_rebook_round`, and the transport's
       * subject triple is meaningless without the round it is scoped to. A test send never enters
       * the transport, so it does not need one.
       */
      roundId?: string;
      limit?: number;
      testEmail?: string;
      resend?: boolean;
      customMessage?: string;
      customSubject?: string;
    };
    const isTest = !!testEmail;
    if (isTest && !resendApiKey) {
      return new Response(JSON.stringify({ error: "email_not_configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
    /** The academy this batch belongs to — the enqueue's tenant fence. Set when a cycle is resolved. */
    let academyProfileId: string | null = null;
    // NOTE ON THE ROUND. Three live callers send none: the per-claim re-invite and the
    // invite-everyone-on-this-slot button in `PriorityClaimsSection`, and
    // `notifyPriorityClaimsForSlots` from the bulk-copy wizard. The round is DERIVED IN THE
    // DATABASE for them, from the claim's own capture record — not here, because
    // `rebook_round_recipient_claim_sources` is a Domain-A relation and no ABC-27 round table
    // appears in the generated Supabase types. A supplied `roundId` still wins.
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
      // Resolved ONCE and used twice: it is the authorization subject below AND the tenant the
      // enqueue is fenced by. Reading it in only one of those places would let the two disagree.
      const { data: cyc } = await supabase
        .from("cycles").select("owner_id, owner_type").eq("id", cycleId).maybeSingle();
      const ownerId = (cyc as { owner_id: string | null; owner_type: string | null } | null)?.owner_id ?? null;
      const ownerType = (cyc as { owner_id: string | null; owner_type: string | null } | null)?.owner_type ?? null;
      academyProfileId = ownerType === "academy" ? ownerId : null;
      if (!isService) {
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
      type RepClaim = { id: string; invited_at: string | null; slot_id: string; player_id: string | null; guest_player_id: string | null; rebook_group_id: string | null; availability_slots: { start_time: string } | null; profiles: { email: string | null } | null; guest_players: { email: string | null } | null };
      const { rows: repClaimsRaw, error: rcErr } = await fetchAllInChunks<RepClaim>(
        cycleSlotIds,
        (slotChunk, after, limit) => {
          let q = supabase
            .from("slot_priority_claims")
            .select("id, invited_at, slot_id, player_id, guest_player_id, rebook_group_id, availability_slots:slot_id(start_time), profiles:player_id(email), guest_players:guest_player_id(email)")
            .in("slot_id", slotChunk)
            .eq("status", "pending");
          if (after) q = q.gt("id", after);
          return q.order("id").limit(limit);
        },
        (r) => r.id,
      );
      if (rcErr) throw rcErr;
      // PostgREST types the to-one embeds as arrays; the runtime values are single objects.
      const repClaims = repClaimsRaw as unknown as RepClaim[];
      // Sendability MUST match the actual delivery resolution: a guest is sendable iff they have a
      // VERIFIED contact (own → account, person_links/twin/linked), never the raw player_id — else a
      // guest deemed sendable here but skipped at send time would stall the drain's convergence.
      const repGuestMap = await fetchGuestContacts(supabase, repClaims.map((c) => c.guest_player_id));
      const hasEmail = (c: { player_id: string | null; guest_player_id: string | null; profiles: { email: string | null } | null }) =>
        c.guest_player_id ? !!guestContactEmail(c.guest_player_id, repGuestMap) : !!c.profiles?.email?.trim();
      const repByKey = new Map<string, { id: string; start: string; invited: boolean; sendable: boolean }>();
      for (const c of repClaims) {
        // PAIR-EXACT representative key (`OWNER_DECISION_D7_RUNTIME_PRIORITY_INVITE_SEMANTICS_V1`).
        //
        // It was guest-first (FAM-02), which already fixed a player-first key that collapsed a
        // dual-key child with their linked parent. But guest-first still collapses `(P, G)` with
        // `(NULL, G)` — and since the invitation now DESCRIBES and the accept BOOKS the exact pair,
        // those are two different series that each need their own invitation. Collapsed, only the
        // earliest was ever enqueued and stamped; later drains selected that same already-invited
        // representative, reported nothing remaining, and the other pair stayed pending and
        // uninvited forever. Review round 2 found it as a consequence of the pair-exact narrowing.
        //
        // The key is the same one the series aggregation uses, so discovery and description cannot
        // disagree about what a series is.
        if (!personKeyOf(c)) continue;
        const gkey = c.rebook_group_id ?? c.slot_id;
        const start = c.availability_slots?.start_time ?? "";
        const k = `${gkey}|p:${c.player_id ?? ""}|g:${c.guest_player_id ?? ""}`;
        const cur = repByKey.get(k);
        // `invited` is a property of the SERIES, not of the leader. Closure review 6: reading only
        // the leader's own stamp meant a series invited from a slot page — where a sibling was
        // stamped — was discovered again here and enqueued a second time. It is ORed across every
        // claim of the series, whichever one ends up leading.
        const invited = (cur?.invited ?? false) || !!c.invited_at;
        if (!cur || start < cur.start) {
          repByKey.set(k, { id: c.id, start, invited, sendable: hasEmail(c) });
        } else {
          repByKey.set(k, { ...cur, invited });
        }
      }
      // Reps with no email can never be sent. Mark their invite step RESOLVED
      // (stamp invited_at) so they drop out of `remaining` AND the owner's
      // uninvitedCount/"resume" banner — otherwise the banner could never clear and
      // a resume click would loop on a false "0 sent" success. No email is sent. The
      // only reader of invited_at (send-rebook-group-confirmation) never emails an
      // emailless member, so this is safe. The owner already acknowledged the
      // no-email count in the wizard.
      // NOT ON A TEST SEND. A preview must mutate nothing — the endpoint says so for the send
      // itself — but this stamp ran BEFORE the test/live split, so previewing a cycle's copy
      // could resolve an emailless claim's invitation for good. If a verified contact were added
      // afterwards the real drain would already have excluded it, and the invitation was lost
      // with nothing to show for it (review round 5).
      const emaillessRepIds = isTest ? [] : [...repByKey.values()].filter((r) => !r.invited && !r.sendable).map((r) => r.id);
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
    // claim id → the academy it was PROVEN to belong to, so a later re-read cannot move it.
    const authorizedAcademyByClaim = new Map<string, string>();
    if (!isService && !cycleId) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      let ownQuery = userClient.from("slot_priority_claims").select("id");
      if (claimIds && claimIds.length) ownQuery = ownQuery.in("id", claimIds);
      else if (slotId) ownQuery = ownQuery.eq("slot_id", slotId);
      const { data: ownRows, error: ownErr } = await ownQuery;
      if (ownErr) throw ownErr;
      const visibleIds = (ownRows || []).map((r: { id: string }) => r.id);

      // VISIBLE IS NOT OWNED. PostgreSQL ORs permissive SELECT policies, so this read is satisfied
      // by "Slot owners manage priority claims" OR by "Players read own priority claims" — and a
      // player with a pending claim of their own therefore passed a check meant to prove slot
      // ownership. They could then drive this endpoint for their own claim, choose the custom copy,
      // and enqueue and stamp their own branded invitation ahead of the academy's (review round 3).
      //
      // So ownership is now PROVEN with the service client, exactly as the cycle path above proves
      // it against `academy_managers` — RLS decides what a caller may READ, never what they may
      // COMMAND.
      // OWNERSHIP IS THE POLICY'S OWN DEFINITION, evaluated with the service client.
      //
      // "Slot owners manage priority claims" (20260506080606) defines an owner three ways: the
      // slot's TRAINER — reached through `trainer_profiles.user_id`, because `availability_slots
      // .trainer_id` is a `trainer_profiles.id` and NOT an auth user id — a manager of the slot's
      // ACADEMY, or a manager of the CLUB at the slot's location. All three are reproduced here.
      //
      // Comparing `slot.trainer_id` to the caller's user id directly would 403 every legitimate
      // trainer, since those are different generated keys (review round 4 caught exactly that in
      // the first version of this proof).
      authorizedIds = [];
      if (visibleIds.length > 0 && callerUserId) {
        const { data: ownedRows, error: ownedErr } = await supabase
          .from("slot_priority_claims")
          .select("id, availability_slots:slot_id(trainer_id, academy_profile_id, location_id)")
          .in("id", visibleIds);
        if (ownedErr) throw ownedErr;
        const slotOf = (row: unknown): {
          trainer_id: string | null; academy_profile_id: string | null; location_id: string | null;
        } | null => {
          const embedded = (row as { availability_slots?: unknown }).availability_slots;
          const one = Array.isArray(embedded) ? embedded[0] : embedded;
          return (one ?? null) as {
            trainer_id: string | null; academy_profile_id: string | null; location_id: string | null;
          } | null;
        };
        const uniq = (xs: Array<string | null | undefined>) =>
          [...new Set(xs.filter((x): x is string => !!x))];
        const trainerIds = uniq((ownedRows || []).map((r) => slotOf(r)?.trainer_id));
        const academyIds = uniq((ownedRows || []).map((r) => slotOf(r)?.academy_profile_id));
        const locationIds = uniq((ownedRows || []).map((r) => slotOf(r)?.location_id));

        // 1 · the slot's trainer, mapped through the profile that owns the slot
        const ownedTrainers = new Set<string>();
        if (trainerIds.length > 0) {
          const { data: tps, error: tpErr } = await supabase
            .from("trainer_profiles").select("id").eq("user_id", callerUserId).in("id", trainerIds);
          if (tpErr) throw tpErr;
          for (const t of (tps || []) as Array<{ id: string }>) ownedTrainers.add(t.id);
        }
        // 2 · a manager of the slot's academy
        const managedAcademies = new Set<string>();
        if (academyIds.length > 0) {
          const { data: mgrRows, error: mgrErr } = await supabase
            .from("academy_managers").select("academy_profile_id")
            .eq("user_id", callerUserId).in("academy_profile_id", academyIds);
          if (mgrErr) throw mgrErr;
          for (const m of (mgrRows || []) as Array<{ academy_profile_id: string }>) {
            managedAcademies.add(m.academy_profile_id);
          }
        }
        // 3 · a manager of the club at the slot's location
        const managedLocations = new Set<string>();
        if (locationIds.length > 0) {
          const { data: clubIdRows, error: clubIdErr } = await supabase
            .rpc("get_user_club_ids", { _user_id: callerUserId });
          if (clubIdErr) throw clubIdErr;
          const clubIds = (Array.isArray(clubIdRows) ? clubIdRows : [])
            .map((x) => (typeof x === "string" ? x : (x as { get_user_club_ids?: string })?.get_user_club_ids))
            .filter((x): x is string => !!x);
          if (clubIds.length > 0) {
            const { data: clubs, error: clubErr } = await supabase
              .from("club_profiles").select("location_id")
              .in("id", clubIds).in("location_id", locationIds);
            if (clubErr) throw clubErr;
            for (const cp of (clubs || []) as Array<{ location_id: string | null }>) {
              if (cp.location_id) managedLocations.add(cp.location_id);
            }
          }
        }
        for (const r of (ownedRows || [])) {
          const slot = slotOf(r);
          if (!slot) continue;
          const owned =
            (slot.trainer_id && ownedTrainers.has(slot.trainer_id))
            || (slot.academy_profile_id && managedAcademies.has(slot.academy_profile_id))
            || (slot.location_id && managedLocations.has(slot.location_id));
          if (owned) {
            authorizedIds.push((r as { id: string }).id);
            // THE TENANT THIS CLAIM WAS AUTHORIZED UNDER, captured at proof time. Everything is
            // re-read later from current state, so a claim moved to another academy in between
            // would otherwise be enqueued under the NEW tenant on the OLD tenant's authority —
            // custom copy and all (review round 4). Carrying the proven academy forward makes the
            // enqueue's own fence reject that: the offer requires the slot's academy to equal the
            // tenant it is asked for, so a moved claim is simply not there any more.
            if (slot.academy_profile_id) {
              authorizedAcademyByClaim.set((r as { id: string }).id, slot.academy_profile_id);
            }
          }
        }
      }
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
        // `availability_slots(start_time)` is here so the direct paths can pick the SAME series
        // representative `cycleId` mode picks — the earliest session — rather than an arbitrary one.
        "id, claim_token, status, invited_at, slot_id, player_id, guest_player_id, rebook_group_id, availability_slots:slot_id(start_time), profiles:player_id(full_name, email, user_id), guest_players:guest_player_id(full_name, email)"
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
    const eligiblePending = allClaims.filter(
      (c) => c.status === "pending" && (isTest || resend === true || !c.invited_at)
    );
    const startOfRow = (row: unknown): string => {
      const e = (row as { availability_slots?: unknown } | undefined)?.availability_slots;
      const one = Array.isArray(e) ? e[0] : e;
      return (one as { start_time?: string } | null)?.start_time ?? "";
    };

    // ── ONE INVITATION PER SERIES, THROUGH THE ONE LEADER THE SERVER NAMES ─────────────────
    //
    // `APPROVE_D7_RUNTIME_FINAL_CONVERGENCE_V1`, D1. Six routes reach this endpoint and three of
    // them used to carry their own leader rule; two disagreeing produced two live bearer
    // invitations for one accept scope (closure review 6). There is now ONE definition —
    // `d7_p_invite_offer.series_leader_claim_id` — and this maps every requested claim onto it.
    //
    // MAPPING, not refusing (D1): a manager clicking week two still gets an invitation; it simply
    // describes the series from its first session, which is what one Accept books. The enqueue
    // refuses a non-leader as a backstop, so a route written later cannot reintroduce a duplicate.
    // The candidate leader is PROPOSED here and DECIDED by the enqueue. The proposal reads the same
    // rows with the same ordering the offer uses — earliest pending session of the exact
    // `(group-or-slot, player, guest)` series, tie-broken by id — but it is only a proposal: the
    // enqueue refuses anything that is not the leader IT names, so a divergence fails closed with
    // no row rather than silently producing a second invitation. `d7_p_invite_offer` is Domain-P
    // owned and granted only to the transport owner, so the edge cannot ask it directly; this is
    // why the authority lives in the enqueue rather than in a reply to the caller.
    const leaderOf = new Map<string, string>();
    const seriesGroupIds = [...new Set(eligiblePending
      .map((c) => c.rebook_group_id).filter((g): g is string => !!g))];
    const seriesRows = new Map<string, Array<{ id: string; start: string }>>();
    if (seriesGroupIds.length > 0) {
      const { rows: sibs, error: sibErr } = await fetchAllInChunks<{
        id: string; rebook_group_id: string | null; slot_id: string; player_id: string | null;
        guest_player_id: string | null; availability_slots: { start_time: string } | null;
      }>(seriesGroupIds, (chunkIds, after, limit) => {
        let q = supabase.from("slot_priority_claims")
          .select("id, rebook_group_id, slot_id, player_id, guest_player_id, availability_slots:slot_id(start_time)")
          .in("rebook_group_id", chunkIds).eq("status", "pending");
        if (after) q = q.gt("id", after);
        return q.order("id").limit(limit);
      }, (row) => row.id);
      if (sibErr) throw new Error(`series read failed: ${sibErr.message ?? String(sibErr)}`);
      for (const sib of sibs) {
        const k = `${sib.rebook_group_id ?? sib.slot_id}|p:${sib.player_id ?? ""}|g:${sib.guest_player_id ?? ""}`;
        const list = seriesRows.get(k) ?? [];
        list.push({ id: sib.id, start: startOfRow(sib) });
        seriesRows.set(k, list);
      }
    }
    for (const c of eligiblePending) {
      const k = `${c.rebook_group_id ?? c.slot_id}|p:${c.player_id ?? ""}|g:${c.guest_player_id ?? ""}`;
      const series = seriesRows.get(k);
      if (!series || series.length === 0) { leaderOf.set(c.id, c.id); continue; }
      // Earliest session, then id — total and deterministic, exactly as the offer orders it.
      const lead = series.reduce((a, b) =>
        a.start < b.start ? a : b.start < a.start ? b : (a.id <= b.id ? a : b));
      leaderOf.set(c.id, lead.id);
    }

    const byLeader = new Map<string, typeof eligiblePending[number]>();
    // Claims that were asked for but are not their series leader: their invitation is the leader's.
    const mergedIntoLeader: string[] = [];
    for (const c of eligiblePending) {
      const leader = leaderOf.get(c.id);
      // No leader resolvable (no tenant, or the claim is not this academy's) — leave it to the
      // enqueue, which refuses it with a reason the manager can act on.
      if (!leader) { byLeader.set(c.id, c); continue; }
      if (leader !== c.id) mergedIntoLeader.push(c.id);
      if (byLeader.has(leader)) continue;
      const already = allClaims.find((x) => x.id === leader);
      if (already) { byLeader.set(leader, already); continue; }
      // The leader is a sibling this request did not read. Fetch it, so the invitation is created
      // for the claim the series is actually led by rather than for the one that was clicked.
      const { data: lead, error: leadErr } = await supabase
        .from("slot_priority_claims")
        .select("id, claim_token, status, invited_at, slot_id, player_id, guest_player_id, rebook_group_id, availability_slots:slot_id(start_time), profiles:player_id(full_name, email, user_id), guest_players:guest_player_id(full_name, email)")
        .eq("id", leader).maybeSingle();
      if (leadErr) throw leadErr;
      if (lead) byLeader.set(leader, lead as unknown as typeof eligiblePending[number]);
    }
    // A leader already invited means the SERIES has its invitation — on any route, from any earlier
    // request. This is the half cycle discovery used to miss: it read only the leader's own stamp
    // when the leader was the claim it had picked, never a sibling's.
    const eligible = [...byLeader.values()].filter(
      (c) => isTest || resend === true || !c.invited_at
    );
    // Series whose leader is already stamped: their invitation exists, on whatever route made it.
    const alreadyInvitedSeries = byLeader.size - eligible.length;

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

    // ── THE CLOSED, DISJOINT OUTCOME SET ────────────────────────────────────────────────────
    // Exactly one of these per attempted claim; they sum to `attempted`, which is asserted below.
    let queued = 0;      // a row was created and this claim now has an invitation on its way
    // This SERIES already has one. Seeded with the claims resolved away before the loop: series
    // whose leader is already stamped, and claims merged into a leader — for the caller both mean
    // "this series has its invitation", and dropping them made `attempted` disagree with reality.
    let already = alreadyInvitedSeries + mergedIntoLeader.length;
    let suppressed = 0;  // the address is suppressed: nothing was queued and nothing will be
    let held = 0;        // an existing row for this series cannot be re-queued; needs a person
    let unstamped = 0;   // durably queued, but `invited_at` did not record it; needs a person
    let failed = 0;      // refused or errored outright
    const failedClaimIds: string[] = [];
    // Everything a human has to look at: suppressed + held + unstamped. NOT the same as `failed`.
    const needsAttentionClaimIds: string[] = [];
    // First per-send failure reason (Resend rejection etc.) — surfaced to the caller + Slack so a
    // failed blast reports WHY, not just "N not sent" (the reason otherwise only reaches console).
    let firstSendError: string | null = null;
    // A per-invocation nonce makes the idempotency key of an explicit resend/test send DIFFERENT from
    // the original (so an owner-triggered re-nudge actually re-sends), while the key stays stable
    /**
     * slot id → academy, for the modes that never resolve a cycle.
     *
     * `academyProfileId` is assigned from the cycle, and the live `claimIds` and `slotId` modes have
     * no cycle — so they passed NULL as the enqueue's tenant and every one of them was refused with
     * "tenant and claim are required". The tenant is on the claim's own slot, and
     * `availability_slots` is an ordinary product relation the generated types know.
     *
     * Resolved PER SLOT rather than once: a `claimIds` batch may span slots, and one wrong tenant
     * would be refused by the database anyway — but as a failure the manager cannot act on.
     */
    const academyBySlot = new Map<string, string>();
    if (!isTest && eligible.length > 0) {
      // FAIL LOUD. Dropping this error emptied the map, and every otherwise-valid direct claim then
      // failed with "tenant and claim are required" — a transient read reported as a per-claim
      // defect the manager cannot act on (review round 4).
      const { data: slotRows2, error: slotErr2 } = await supabase
        .from("availability_slots")
        .select("id, academy_profile_id")
        .in("id", [...new Set(eligible.map((c) => c.slot_id))]);
      if (slotErr2) throw slotErr2;
      for (const sl of (slotRows2 ?? []) as { id: string; academy_profile_id: string | null }[]) {
        if (sl.academy_profile_id) academyBySlot.set(sl.id, sl.academy_profile_id);
      }
    }

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
      // THE SERIES LOOKUP IS PAIR-EXACT, and must use the same key the aggregation was built with —
      // the scope `respond_to_priority_claim` books
      // (`OWNER_DECISION_D7_RUNTIME_PRIORITY_INVITE_SEMANTICS_V1`). `playerKey` above stays
      // guest-first because it serves dedup and display, which are a different question.
      const group = c.rebook_group_id ? groupInfo.get(groupSeriesKey(c)) : undefined;
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
      // FORMATTED IN UTC, deliberately. `cycleStartRaw` is a plain DATE; converting it through the
      // academy timezone moves it to the next day for every zone at or past UTC+12, and the noon
      // anchor only hides that for zones behind UTC+12. The value has no time and no zone, so it is
      // rendered in the one zone that cannot shift it.
      const cycleStart = cycleStartRaw
        ? new Date(`${cycleStartRaw}T12:00:00Z`).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
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
      if (queued > 0 || failed > 0 || suppressed > 0 || held > 0 || unstamped > 0) await sleep(120);
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

      // ── ENQUEUE-THEN-STAMP ────────────────────────────────────────────────────────────────
      //
      // This used to SEND-then-stamp: one Resend call with a deterministic key, then `invited_at`.
      // That left a real hole — a provider call that succeeded while the stamp failed had no durable
      // database record, and the only thing standing between that claim and a duplicate email on the
      // next drain was Resend's 24-hour idempotency window. `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1`
      // ruled that unacceptable: a time-bounded provider promise is not a correctness authority.
      //
      // The enqueue is now the durable record. `enqueue_notification` writes ONE outbox row with its
      // transport state, request bytes and hash frozen in the same statement, under a unique
      // idempotency key — so a second enqueue for the same claim returns `already_enqueued` forever,
      // not for a day. Nothing is sent here at all; the D7 worker dispatches under a grant it has to
      // present and consume, and an ambiguous provider outcome becomes `acceptance_uncertain` for an
      // operator rather than a silent re-send.
      //
      // Test sends are the one case that still calls the provider directly: they go to the caller's
      // own inbox, must never touch a claim, and must never enter the transport.
      const enqueueOne = async (): Promise<{ outcome: "ok" | "already" | "suppressed" | "held" | "send_failed" | "unstamped"; error?: string }> => {
        // The tenant this claim actually belongs to. The cycle mode knows it up front; the per-claim
        // and per-slot modes learn it from the slot the claim sits on.
        // The tenant proven at authorization time wins over anything re-read since.
        const claimAcademy = academyProfileId
          ?? authorizedAcademyByClaim.get(c.id)
          ?? academyBySlot.get(c.slot_id)
          ?? null;
        if (!claimAcademy) {
          return { outcome: "send_failed", error: "could not resolve the academy this claim belongs to" };
        }
        // NO ROUND, NO PROTECTED EVENT — and the refusal comes from the database, which is the only
        // place that can see which round a claim was captured for. There is deliberately no fallback
        // to a direct provider call: that is precisely the untracked send this cutover removes.
        const { data, error } = await supabase.rpc("enqueue_notification", {
          p_event_key: "rebook_priority_claim_invite",
          p_recipient_user_id: c.guest_player_id ? null : (c.profiles?.user_id ?? null),
          p_recipient_guest_player_id: c.guest_player_id ?? null,
          p_tenant_academy_profile_id: claimAcademy,
          p_related_rebook_round_id: roundId ?? null,
          p_related_slot_priority_claim_id: c.id,
          // EXPLICIT, never the default: the activation boundary measures `occurred_at`, and every
          // producer in this codebase is pinned to declare it rather than inherit `now()`.
          p_occurred_at: new Date().toISOString(),
          /**
           * THE FACTS THESE BYTES WERE RENDERED FROM — all of them, every time.
           *
           * The database compares every one against its own authoritative read and refuses on any
           * mismatch OR any omission. It never trusts these values: it re-derives the offer itself
           * and computes the digest from ITS read, after this comparison passes. The caller carries
           * facts, never authority.
           *
           * The previous version sent only the slot id, and the database checked it only when it was
           * present — so omitting it skipped the check entirely.
           */
          p_payload: {
            subject, html, from_name: fromName,
            d7_rendered: {
              slot_id: c.slot_id,
              // The PROFILE half of the identity pair. The accept books the exact
              // (player_id, guest_player_id) pair, so the message has to be bound to the
              // pair it was rendered for — not just to the guest.
              player_id: c.player_id ?? null,
              claim_token: c.claim_token,
              group_id: c.rebook_group_id ?? null,
              cyclus_id: slot.cyclus_id ?? null,
              cyclus_name: slot.cyclus_name ?? null,
              cycle_start: cycleStartRaw ?? null,
              // The email asserts one of two things — pay now, or pay when the cycle starts.
              payment_mode: isUpfront ? "upfront" : "",
              sessions: group ? String(group.sessions) : null,
              destination: recipientEmail,
              // THE RENDERED STRING, not the raw column. The HTML quotes
              // `Number(price).toFixed(2)`; sending the raw numeric let PostgreSQL round it
              // differently (2.675 -> 2.68 there, 2.67 here) and seal a price the mail never
              // stated. Echoing exactly what is printed makes a divergence a refusal.
              price: slot.price_per_session == null
                ? null : Number(slot.price_per_session).toFixed(2),
              start: slot.start_time,
              end: slot.end_time,
              priority_ends: slot.priority_window_ends_at ?? null,
              first_start: group ? group.firstStart : null,
              last_start: group ? group.lastStart : null,
            },
            ...(replyTo ? { reply_to: replyTo } : {}),
          },
        });
        if (error) return { outcome: "send_failed", error: error.message };
        const row = Array.isArray(data) ? data[0] : data;
        // `email_suppressed` is a real, terminal answer — the address bounced before. It is a SKIP,
        // not a failure, and re-driving it would just re-suppress.
        // SUPPRESSED IS NOT A SEND, AND NOT A STAMP. The core returns before its only INSERT, so no
        // outbox row exists and nothing will ever be delivered. Reporting it as sent made the
        // endpoint answer `sent: 1` for a claim with no row and no `invited_at` — and the client,
        // seeing no failures, declared the drain complete while the claim stayed eligible forever.
        // SURFACED, NOT SWALLOWED. `readChunkResponse` discards `skipped`, so a chunk of nothing but
        // skips looks like a clean drain — while the claim stays unstamped and is rediscovered
        // forever. Both of these need a human, so they travel on the `unresolved` channel the drain
        // already propagates and the wizard already reports.
        if (row?.skip_reason === "email_suppressed") {
          return { outcome: "suppressed", error: "the recipient's address is suppressed" };
        }
        if (row?.skip_reason === "existing_row_not_sendable") {
          return { outcome: "held", error: "an earlier invitation for this claim is held and cannot be re-queued" };
        }
        // ALREADY QUEUED IS NOT A SEND. The idempotency key is permanent, so a second enqueue for the
        // same claim can never produce another message — including for an explicit `resend`, which
        // used to report success and stamp `invited_at` while nothing whatsoever was re-sent.
        // Reported as skipped so the count the manager reads is the count of messages queued.
        // DECIDED BEFORE THE STAMP. Closure review 6: the stamp-error return sat earlier in the
        // control flow, so a repair attempt on an EXISTING row that failed to stamp was reported as
        // a fresh send — the same 40 claims rediscovered every chunk, `sent` climbing forever, the
        // client's no-progress stop defeated, and the untouched 60 starved to the iteration limit.
        const already = row?.skip_reason === "already_enqueued";
        // STAMP AFTER A DURABLE ENQUEUE. If this fails the claim stays unstamped and the next drain
        // re-enqueues — which is now a no-op returning `already_enqueued`, so the recipient cannot be
        // mailed twice by it. That is why the stamp is no longer the dangerous half of the pair.
        if (!isTest) {
          let q = supabase.from("slot_priority_claims")
            .update({ invited_at: new Date().toISOString() }).eq("id", c.id);
          if (!resend) q = q.is("invited_at", null);
          const { error: stampError } = await q;
          // An existing row whose stamp repair fails is STILL `already` — nothing new was queued.
          if (stampError) {
            return already
              ? { outcome: "already", error: stampError.message }
              : { outcome: "unstamped", error: stampError.message };
          }
        }
        return { outcome: already ? "already" : "ok" };
      };
      const { outcome, error: sendError } = isTest
        ? await sendThenStampOne({
            send: async () => {
              const o = await sendResendEmail(
                // Non-null by construction: a test send is refused above when the key is absent, and
                // this is the only path that reaches the provider at all.
                resendApiKey as string,
                {
                  from: `"${fromName}" <noreply@app.padeltrainer.ai>`,
                  to: [recipientEmail],
                  subject,
                  html,
                  ...(replyTo ? { reply_to: replyTo } : {}),
                  ...(Object.keys(inviteHeaders).length ? { headers: inviteHeaders } : {}),
                },
                { idempotencyKey: `priority-claim-invite:${c.id}:${reqNonce}` },
              );
              return { ok: o.ok, error: o.ok ? undefined : o.error };
            },
            stamp: null,
          })
        : await enqueueOne();
      // ── ONE TERMINAL OUTCOME PER ATTEMPT ────────────────────────────────────────────────
      //
      // `APPROVE_D7_RUNTIME_FINAL_CONVERGENCE_V1`. The tallies used to OVERLAP — a durable enqueue
      // whose `invited_at` stamp failed incremented both `sent` and `unresolved` — and three review
      // rounds in a row found a consumer that had got the arithmetic wrong: an inflated denominator,
      // a false "no progress" stop, a false zero leftover, a claim reported as both queued and not
      // queued. The cure is not more careful subtraction downstream. It is that a claim lands in
      // EXACTLY ONE bucket here, and the buckets sum to what was attempted.
      if (outcome === "send_failed") {
        if (!firstSendError && sendError) firstSendError = sendError;
        failed++;
        failedClaimIds.push(c.id);
        continue; // invited_at stays NULL → the claim is still eligible for a later retry
      }
      if (outcome === "already") {
        already++;
        continue;
      }
      if (outcome === "suppressed") {
        suppressed++;
        needsAttentionClaimIds.push(c.id);
        if (!firstSendError && sendError) firstSendError = sendError;
        continue;
      }
      if (outcome === "held") {
        held++;
        needsAttentionClaimIds.push(c.id);
        if (!firstSendError && sendError) firstSendError = sendError;
        continue;
      }
      if (outcome === "unstamped") {
        // The row is durably queued; only the RECORD of it failed. It is NOT `queued`, because the
        // claim is still un-stamped and a later drain will rediscover it — and it is NOT `failed`,
        // because a message really is on its way. Its own bucket, counted once.
        unstamped++;
        needsAttentionClaimIds.push(c.id);
        continue;
      }
      queued++;
    }

    // THE INVARIANT, ASSERTED BEFORE ANSWERING. If these ever disagree the tally is wrong and the
    // caller must not be handed a number it will reason from — every consumer of this endpoint
    // computes progress, completion and "what still needs a person" from exactly these figures.
    // Everything this call RESOLVED, not just what it looped over: the claims merged into a leader
    // and the series already invited were decided before the loop, and `already` counts them — so
    // they belong in the denominator or the invariant below is comparing two different populations.
    const attempted = eligible.length + alreadyInvitedSeries + mergedIntoLeader.length;
    const accounted = queued + already + suppressed + held + unstamped + failed;
    if (accounted !== attempted) {
      throw new Error(
        `invitation accounting is inconsistent: ${accounted} outcomes for ${attempted} attempts ` +
        `(queued=${queued} already=${already} suppressed=${suppressed} held=${held} ` +
        `unstamped=${unstamped} failed=${failed})`,
      );
    }

    // Partial-failure alert: a high-volume rebook blast can silently drop invites (per-send Resend
    // errors, the time-budget early-stop, or a sent-but-un-stamped UNRESOLVED). Alert ONCE with counts
    // + claim IDs (no PII) instead of per recipient.
    const needsAttention = suppressed + held + unstamped;
    if (failed > 0 || needsAttention > 0) {
      await notifySlackEdgeError(
        "send-priority-claim-invitation",
        `${failed} failed / ${needsAttention} needing attention of ${attempted} priority-claim invites${firstSendError ? `: ${firstSendError}` : ""}`,
        { queued, already, suppressed, held, unstamped, failed, attempted, skipped, failedClaimIds, needsAttentionClaimIds, sampleError: firstSendError, isTest, resend: resend === true },
      );
    }
    // `remaining` (cycleId mode only): representative invites still un-sent for this round AFTER this
    // chunk, so the client can loop until drained. Send-then-stamp: a failed send never stamped
    // invited_at, and an UNRESOLVED send left it NULL too, so both reappear as eligible on the next
    // call (transient 429s retried; the recipient is protected from a duplicate by the idempotency key
    // within 24h). The client stops on no-progress to avoid an endless loop.
    return new Response(JSON.stringify({ sent: queued, queued, already, suppressed, held, unstamped, failed, attempted, skipped, failedClaimIds, needsAttentionClaimIds, remaining: cycleRemaining, sampleError: firstSendError ?? undefined }), {
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
