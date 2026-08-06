// 10c-b D — open-slot follower alerts, CUT OVER to the v2 notification pipeline.
//
// This route used to POST send-email once per follower and dedup through its own
// `notification_sends` table. It now calls enqueue_notification('open_slots_player', ...) once
// per follower and lets the v2 resolver own preference, consent, suppression, contact
// resolution and idempotency. The policy rules live in _shared/open-slots-notify.ts so the
// suite exercises production code (this module ends in `serve(handler)` and cannot be imported).
//
// WHAT CHANGED THAT A READER MUST NOT MISS:
//   * There is no "sent" count any more, and the response no longer claims one. This route
//     ENQUEUES. Whether mail goes out is the worker's business, and while the digest engine is
//     disabled a daily/weekly follower is deliberately recorded `skipped`/`digest_engine_disabled`
//     rather than downgraded to an instant email.
//   * Dedup is the resolver's idempotency key (`<event>:<subject>:<recipient>`), so a retry or
//     two concurrent invocations collapse to ONE logical row per follower. The old
//     notification_sends claim/release is GONE — running both would be a dual-write with two
//     different notions of "already handled", and could produce a legacy send beside a v2 row.
//     The one remaining touch of that table is ONE-WAY and write-only: after enqueueing we
//     record the pre-cutover key so a ROLLBACK to the old handler does not send a second copy.
//     It is never READ to skip anyone — a legacy row is a claim taken before a send, not proof
//     of one, and honouring it could drop a follower silently. See markableLegacyKeys().
//   * The old per-follower filter read notification_preferences.email_new_availability — a
//     column dropped in 20260210090026, whose error was discarded, so that filter had been
//     silently inert. Preference is now enforced inside enqueue_notification against
//     notification_preferences_v2, which slice C backfilled from the legacy open_slots_digest.
//   * Dates arrive as validated ISO fields, never display text.
//
// Trainer identity is still taken from the authenticated user's trainer_profiles row and is
// never read from the request body.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import {
  classifyEnqueue,
  digestPayload,
  type EnqueueOutcome,
  eventSubject,
  legacyDedupKey,
  markableLegacyKeys,
  newCounts,
  parseNotifyRequest,
  parseResumeState,
  planRunOutcome,
  shouldContinue,
  splitProcessed,
  tally,
} from "../_shared/open-slots-notify.ts";
import { occurrenceForOpenSlots } from "../_shared/notification-occurrence.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });

const handler = async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("No authorization header provided");
      return json({ error: "Authentication required" }, 401);
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
    if (authError || !user) {
      console.error("Authentication failed:", authError?.message);
      return json({ error: "Unauthorized" }, 401);
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    // The wall-clock budget covers the WHOLE invocation, discovery included — starting it after
    // the queries would let paging consume the edge timeout and leave nothing for the sends.
    const start = Date.now();

    // Trainer identity comes from the AUTHENTICATED user, never from request data.
    const { data: trainerProfile, error: trainerError } = await supabase
      .from("trainer_profiles")
      .select("id, user_id, business_name")
      .eq("user_id", user.id)
      .single();

    if (trainerError || !trainerProfile) {
      console.error("User is not a trainer:", trainerError?.message);
      return json({ error: "Only trainers can notify followers" }, 403);
    }
    const trainerId = trainerProfile.id;

    const rawBody = await req.json().catch(() => null);
    const parsed = parseNotifyRequest(rawBody);
    if (!parsed.ok) {
      return json({ error: parsed.error }, 400);
    }
    const notify = parsed.req;
    // A self-continuation carries only a cursor and a hop count. Trainer identity still comes
    // from the authenticated user on every hop, so the chain can never widen its own scope.
    const resumeState = parseResumeState(rawBody);

    // business_name takes precedence (matches the in-app trainer name resolver).
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("user_id", trainerProfile.user_id)
      .single();
    const trainerName = trainerProfile.business_name?.trim() || profile?.full_name || "Your trainer";

    // Followers who still want new-availability alerts. The flag is re-checked LIVE before
    // delivery by the §PS event hook — before prepare and before every attempt on the digest
    // path, and immediately before send in the instant email worker — so unfollowing between
    // enqueue and delivery still stops the notification on both routes.
    // PAGED recipient discovery. Both of these reads are subject to PostgREST's configured row
    // cap, and the profile lookup additionally used a single `.in(...)` over every follower id —
    // which above a few thousand followers exceeds practical request limits. Silently returning
    // the first page was the worst outcome: the omitted followers were never notified AND never
    // counted as deferred, so the run reported a clean success. Paging with an explicit bound
    // keeps totals truthful and the tail resumable (a re-invoke is safe — already-enqueued
    // recipients collapse to no_row via the resolver's idempotency key).
    const PAGE = 500;
    // A per-INVOCATION discovery budget, NOT a hard ceiling on the trainer. The previous version
    // capped at 20000 and stopped there: above the cap the tail was unreachable, because every
    // client retry restarted discovery from the beginning with no cursor, re-walked the same
    // first 20000 and deferred the identical remainder for ever. The run now hands the cursor to
    // its own continuation, so the tail is drained rather than merely reported.
    const MAX_PER_RUN = 20000;
    const TIME_BUDGET_MS = 110_000;
    // Discovery gets a slice of the budget, checked INSIDE the paging loop. Checking only after
    // discovery meant slow paging could consume the whole edge lifetime and leave nothing for
    // the enqueues, so a run could burn its wall clock and enqueue nothing at all.
    const DISCOVERY_BUDGET_MS = 40_000;
    // Recipients a previous hop failed to enqueue, carried for their second (and final) attempt.
    // They are processed LAST — see the ordering note where the two lists are joined.
    const retrying: Array<{ id: string; user_id: string; isRetry: true }> = [];
    if (resumeState.retryPlayerIds.length > 0) {
      // THE RETRY SET IS AN INPUT, SO IT IS AUTHORISED LIKE ONE. Uuid-validating and capping the
      // ids bounds their shape and volume, not their authority: without this intersection an
      // authenticated trainer could post any player's profile id and mint an open_slots_player
      // row for a stranger. The live follower check in the worker would stop delivery, but only
      // once the worker carrying it is deployed — and nothing in the deploy order guarantees that
      // ordering — so the enqueue itself must be gated here.
      //
      // Intersecting against the CURRENT enabled follower rows also does the right thing for a
      // follower who unfollowed between hops: their retry simply stops existing.
      const { data: authorised, error: authorisedError } = await supabase
        .from("trainer_followers")
        .select("player_id")
        .eq("trainer_id", trainerId)
        .eq("notify_new_availability", true)
        .in("player_id", resumeState.retryPlayerIds);
      if (authorisedError) {
        console.error("Retry authorisation lookup failed:", authorisedError.message);
        return json({ error: "follower_lookup_failed" }, 500);
      }
      const authorisedIds = (authorised ?? []).map((r) => r.player_id as string);
      if (authorisedIds.length > 0) {
        const { data: retryProfiles, error: retryError } = await supabase
          .from("profiles")
          .select("id, user_id")
          .in("id", authorisedIds);
        if (retryError) {
          console.error("Retry profile lookup failed:", retryError.message);
          return json({ error: "profile_lookup_failed" }, 500);
        }
        for (const p of retryProfiles ?? []) {
          if (p.user_id) retrying.push({ id: p.id, user_id: p.user_id, isRetry: true });
        }
      }
    }
    const discovered: Array<{ id: string; user_id: string }> = [];

    // KEYSET paging, not offset. With `.range(from, …)` a follower deleted between pages shifts
    // every later row left, silently skipping one — and the run would still report success.
    // Paging from the last seen player_id cannot skip a row that was never read.
    let cursor: string | null = resumeState.afterPlayerId;
    let lastDiscovered: string | null = cursor;
    let discoveryStoppedEarly = false;
    // Both discovery bounds count FOLLOWER ROWS READ, not deliverable recipients. Counting
    // recipients let a run of followers whose profile has no user_id — guests, unlinked rows —
    // hold both guards at zero: leading pages of them scanned past the ceiling AND past the
    // discovery budget, and a large enough run could burn the whole invocation before a single
    // enqueue or continuation. Rows read is what actually advances, so it is what bounds.
    let followerRowsRead = 0;
    for (;;) {
      if (followerRowsRead >= MAX_PER_RUN) { discoveryStoppedEarly = true; break; }
      // `followerRowsRead > 0` keeps every hop monotonic: a hop always reads at least one page,
      // so the chain cannot stall on a cursor it never advances.
      if (followerRowsRead > 0 && Date.now() - start > DISCOVERY_BUDGET_MS) {
        discoveryStoppedEarly = true;
        break;
      }
      let q = supabase
        .from("trainer_followers")
        .select("player_id")
        .eq("trainer_id", trainerId)
        .eq("notify_new_availability", true)
        .order("player_id", { ascending: true })
        .limit(PAGE);
      if (cursor) q = q.gt("player_id", cursor);

      const { data: followerPage, error: followersError } = await q;
      // A failed READ must not read as "nobody to notify": returning 200/zero here would make a
      // database outage indistinguishable from a trainer with no followers.
      if (followersError) {
        console.error("Follower lookup failed:", followersError.message);
        return json({ error: "follower_lookup_failed" }, 500);
      }
      if (!followerPage || followerPage.length === 0) break;
      followerRowsRead += followerPage.length;
      cursor = followerPage[followerPage.length - 1].player_id;
      lastDiscovered = cursor;

      const { data: players, error: playersError } = await supabase
        .from("profiles")
        .select("id, user_id")
        .in("id", followerPage.map((f) => f.player_id));
      if (playersError) {
        console.error("Follower profile lookup failed:", playersError.message);
        return json({ error: "profile_lookup_failed" }, 500);
      }
      // `.in(...)` does not promise an order. Sorting by id restores the follower page's own
      // player_id ordering, which is what makes "everything before index N is done" a sound
      // statement — and therefore what makes the continuation cursor correct.
      for (const p of [...(players ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        if (p.user_id) discovered.push({ id: p.id, user_id: p.user_id });
      }
      if (followerPage.length < PAGE) break;
    }

    // DISCOVERY FIRST, RETRIES LAST — and this ordering is load-bearing.
    //
    // Putting retries first sounded fairer (they have waited longest) and starved the thing that
    // actually has to finish. The two lists share one wall-clock budget and one chunk loop, and
    // only the FIRST chunk of a hop is guaranteed to run; a long retry prefix could therefore
    // consume the whole hop, leave `processedDiscovered` at zero, hand back the same cursor, and
    // do that on every hop until the cap — so the healthy tail was never discovered and the
    // retries themselves drained ten at a time.
    //
    // With discovery first the guaranteed chunk is always a discovery chunk, so the cursor
    // advances on every hop and the tail drains at full speed. Retries are not lost by being
    // last: whatever the budget does not reach is carried forward, and once discovery is
    // exhausted the hops are all retries. A second attempt yielding to a first attempt is also
    // the right priority when something has to give. Termination is the cursor's job, not the
    // retry set's — see planRunOutcome.
    const recipients: Array<{ id: string; user_id: string; isRetry?: true }> = [...discovered, ...retrying];
    // "No followers with an account" is only TRUE when discovery actually finished. Returning it
    // after an early stop turned a page of unlinked profiles into a clean 200 with the tail
    // undiscovered — and a pre-cutover caller, which reads neither status nor body, never comes
    // back for it. When discovery stopped early the run falls through to the planning and
    // continuation below, which knows how to carry on from the cursor.
    if (recipients.length === 0 && !discoveryStoppedEarly) {
      return json({ message: "No followers with an account", ...newCounts() }, 200);
    }

    const subject = eventSubject(notify, trainerId);
    // WHEN THE AVAILABILITY APPEARED, read from the slots themselves. This handler is invoked
    // AFTER the slot write commits and is retried on its own budget, so the enqueue instant is
    // emphatically not the event instant — which is the precise shape of the replay the
    // activation boundary now has to catch. Fail closed: undateable means un-sent, and the
    // caller's bounded retry gets another go.
    const occurredAt = await occurrenceForOpenSlots(supabase, notify.subtype === "slot_reopened"
      ? { subtype: "slot_reopened", trainerId, bookingId: notify.bookingId ?? null, slotDate: notify.slotDate ?? null, slotTime: notify.slotTime ?? null }
      : { subtype: "new_availability", trainerId, dateFrom: notify.dateFrom, dateTo: notify.dateTo });
    if (!occurredAt) {
      return json({ error: "the availability's occurrence time could not be established", ...newCounts() }, 503);
    }
    const payload = digestPayload(notify, trainerName);
    const counts = newCounts();
    const errors: string[] = [];

    // Bounded processing: a large follower set must not blow the edge timeout. Un-processed
    // recipients are reported as `deferred` and continued — safely, because the resolver's
    // idempotency key makes an already-enqueued recipient a no-op rather than a duplicate.
    const CHUNK_SIZE = 10;
    let processed = 0;
    // Recipients this hop failed to enqueue that were NOT already retries. Only these are handed
    // to the next hop, which is what caps every recipient at two attempts and makes the retry set
    // strictly shrink. A retry that fails again is reported as `failed` and goes no further.
    const freshFailureIds: string[] = [];
    let anyFailure = false;
    // Recipients whose rollback marker could not be written. Not a delivery failure — the enqueue
    // stands — but an operator needs to know the rollback guarantee is weaker for them.
    let legacyMarkerFailures = 0;

    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
      // The FIRST chunk always runs. A hop that enqueued nobody would hand the same cursor to
      // its successor, and the chain would spin without progress.
      if (i > 0 && Date.now() - start > TIME_BUDGET_MS) break;
      const chunk = recipients.slice(i, i + CHUNK_SIZE);

      // ── CROSS-VERSION DEDUP (transition only), and why it is ONE-WAY ─────────────────────
      // The pre-cutover handler CLAIMED `notification_sends` before sending and DELETED the
      // claim when the send failed; this one relies on the resolver's idempotency key in
      // `notification_outbox`. Two ledgers that cannot see each other.
      //
      // Reading the legacy ledger to skip a recipient is UNSOUND, and deliberately not done: a
      // legacy row records an INTENT to send, not a send. A pre-cutover invocation that claimed
      // and was then torn down — which is exactly what a deploy does to an in-flight isolate —
      // leaves a claim with no email behind it. Honouring that claim would silently drop the
      // follower AND report the run successful, which is the failure class this whole slice
      // exists to remove. There is no send ledger to corroborate against: send-email records
      // nothing durable for these types (only notification_queue, for daily/weekly).
      //
      // Writing is different, and safe: after enqueueing we KNOW v2 owns this recipient, so
      // recording the legacy key means a ROLLBACK to the old handler finds it claimed and does
      // not send a second copy. That direction can only prevent a duplicate, never cause a miss.
      //
      // The remaining exposure is therefore one-directional and bounded: an old-handler send
      // followed by a retry of the SAME batch that lands on the new handler notifies twice. It
      // is closed operationally by the deploy ordering in ADR 0008 ("10c-b D"), and a duplicate
      // is the failure we are willing to carry — never a silent miss.
      const legacyKeys = new Map<string, string>();
      for (const p of chunk) {
        const k = legacyDedupKey(notify, trainerId, p.id);
        if (k) legacyKeys.set(p.id, k);
      }

      const results: Array<{ outcome: EnqueueOutcome; id: string; err?: string }> =
        await Promise.all(chunk.map(async (player) => {
          const { data, error } = await supabase.rpc("enqueue_notification", {
            p_event_key: "open_slots_player",
            p_recipient_user_id: player.user_id,
            p_tenant_trainer_id: trainerId,
            p_idempotency_subject: subject,
            p_occurred_at: occurredAt,
            p_payload: payload,
          });
          if (error) {
            return {
              outcome: "failed" as EnqueueOutcome,
              id: player.id,
              err: `enqueue failed for follower: ${error.message}`,
            };
          }
          return {
            outcome: classifyEnqueue(data as Array<{ status?: string | null }>),
            id: player.id,
          };
        }));

      for (let k = 0; k < results.length; k++) {
        const r = results[k];
        tally(counts, r.outcome);
        if (r.err) errors.push(r.err);
        if (r.outcome === "failed") {
          anyFailure = true;
          if (!chunk[k].isRetry) freshFailureIds.push(r.id);
        }
      }
      // Record what v2 has taken ownership of. A `failed` recipient is never recorded — nobody
      // notified it, and claiming the key would suppress the retry meant to reach it.
      const handledKeys = markableLegacyKeys(results, legacyKeys);
      if (handledKeys.length > 0) {
        // REPAIR HERE OR NOT AT ALL. A later attempt cannot fix this: on any re-run the resolver
        // returns zero rows for an already-enqueued recipient (`no_row`), which is deliberately
        // NOT markable, so nothing downstream would ever write the missing key. The only place
        // that still knows a durable v2 row was just created is right here — so a transient
        // failure is retried in-run, and what survives that is reported, not quietly re-labelled
        // as something a retry will sort out.
        let markError: { message: string } | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          const { error } = await supabase
            .from("notification_sends")
            .upsert(handledKeys.map((dedup_key) => ({ dedup_key })), {
              onConflict: "dedup_key",
              ignoreDuplicates: true,
            });
          markError = error;
          if (!error) break;
        }
        // The enqueue already happened and is itself idempotent, so a failed marker must not turn
        // a successful enqueue into a failure — but it does leave those recipients without
        // rollback protection, so it is counted and returned rather than only logged.
        if (markError) {
          console.error("Legacy dedup marker write failed after 3 attempts:", markError.message);
          legacyMarkerFailures += handledKeys.length;
        }
      }

      processed = Math.min(i + CHUNK_SIZE, recipients.length);
    }

    // ── EXACT, RESUMABLE INCOMPLETENESS ────────────────────────────────────────────────────
    // Everything from the first failure onward is owed, as is everything discovery never
    // reached. Both parts are counted exactly: no `Math.max(x, 1)` fudge, which used to report
    // "1 deferred" both when exactly the cap was reached (nothing was actually omitted) and when
    // tens of thousands were.
    let beyondDiscovery = 0;
    let beyondUnknown = false;
    if (discoveryStoppedEarly && lastDiscovered) {
      const { count: remainingCount, error: remainingError } = await supabase
        .from("trainer_followers")
        .select("player_id", { count: "exact", head: true })
        .eq("trainer_id", trainerId)
        .eq("notify_new_availability", true)
        .gt("player_id", lastDiscovered);
      if (remainingError) {
        // FAIL CLOSED. Treating an unreadable count as zero turned a run with an undiscovered
        // tail into a clean 200: no continuation, and a pre-cutover caller — which never reads
        // the body — would never retry either. Not knowing how big the tail is does not make it
        // absent.
        console.error("Remaining-follower count failed:", remainingError.message);
        errors.push(`remaining follower count failed: ${remainingError.message}`);
        beyondUnknown = true;
      } else {
        beyondDiscovery = remainingCount ?? 0;
      }
    }
    const plan = planRunOutcome({
      discoveredIds: discovered.map((r) => r.id),
      freshFailureIds,
      // The split of `processed` across the two segments is production logic with its own tests
      // (splitProcessed); doing it inline here would put the one piece of arithmetic that decides
      // both the cursor and the owed retries in the file the suite cannot import.
      ...splitProcessed({
        discoveredCount: discovered.length,
        retryIds: retrying.map((r) => r.id),
        processed,
      }),
      anyFailure,
      beyondDiscovery,
      beyondUnknown,
      lastDiscovered,
      incomingCursor: resumeState.afterPlayerId,
    });
    if (plan.droppedRetries > 0) {
      // No silent caps. These recipients got ONE attempt rather than two, and the run says so
      // rather than quietly promising a retry the chain will not make.
      console.error(`notify-followers: ${plan.droppedRetries} failed recipients exceeded the retry carry cap`);
      errors.push(`${plan.droppedRetries} failed recipients could not be carried for a retry`);
    }
    const nextCursor = plan.nextCursor;
    counts.deferred = plan.deferred;

    // ── SERVER-SIDE CONTINUATION ───────────────────────────────────────────────────────────
    // The tail must not depend on the CALLER retrying. A pre-cutover bundle ignores a non-2xx
    // response entirely, so an incomplete run reached through a cached page was simply lost —
    // and no cron re-invokes this function. So the run chains itself, exactly as
    // send-campaign-emails does, carrying its own cursor. The caller's Authorization header is
    // forwarded rather than a service key, so the continuation re-derives the same trainer from
    // the same user and gains no privilege the original request did not have. (This route sets
    // `verify_jwt = false`, so the gateway needs no separate apikey; the handler's own
    // getUser(token) is the gate, on the first hop and on every later one alike.)
    //
    // The forwarded token's own lifetime bounds the chain in practice — the hop cap is well
    // inside a standard access-token life, and an expired token simply 401s the next hop, which
    // is logged and leaves the caller's bounded retry as the remaining path.
    //
    // TERMINATION: each hop processes at least one chunk and the cursor is strictly increasing,
    // so `deferred` shrinks monotonically; MAX_CONTINUATION_DEPTH bounds it regardless.
    let continued = false;
    if (shouldContinue({
      deferred: counts.deferred,
      // Reading follower rows advances the cursor even when none of them was deliverable.
      madeProgress: processed > 0 || followerRowsRead > 0,
      depth: resumeState.depth,
      beyondUnknown,
    })) {
      const chain = fetch(`${supabaseUrl}/functions/v1/notify-followers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          ...(rawBody as Record<string, unknown>),
          // A null cursor is meaningful — "resume from the beginning" — so it is sent as an
          // explicit absence rather than a bogus id.
          resume_after_player_id: nextCursor,
          continuation_depth: resumeState.depth + 1,
          resume_retry_player_ids: plan.retryIds,
        }),
      })
        .then(async (r) => {
          if (!r.ok) console.error("notify-followers self-reinvoke returned", r.status);
          // A continuation hop's OWN marker gap can never reach the app: this parent has already
          // answered, and a later app retry sees `no_row` for those recipients. The function log
          // is the only place it can land, so the parent reads the child's body and says so
          // rather than discarding it.
          try {
            const body = await r.json() as Record<string, unknown> | null;
            const gap = body && typeof body.legacy_marker_failed === "number" ? body.legacy_marker_failed : 0;
            if (gap > 0) console.error(`notify-followers continuation reported legacy_marker_failed=${gap}`);
          } catch { /* a body we cannot read tells us nothing; the child logged it itself */ }
        })
        .catch((e) => console.error("notify-followers self-reinvoke failed:", e));
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(chain);
      else await chain;
      continued = true;
    }

    console.log(
      `open_slots_player ${notify.subtype} (hop ${resumeState.depth}, retries=${retrying.length}): ` +
      `enqueued=${counts.enqueued} ` +
      `skipped=${counts.skipped} no_row=${counts.no_row} failed=${counts.failed} ` +
      `deferred=${counts.deferred}${beyondUnknown ? "+unknown" : ""} ` +
      `markerFailures=${legacyMarkerFailures} carriedRetries=${plan.retryIds.length} ` +
      `droppedRetries=${plan.droppedRetries} continued=${continued}`,
    );
    if (errors.length > 0) console.error("Enqueue errors:", errors);

    // Truthful reporting: these are ENQUEUE outcomes, not deliveries.
    //
    // An INCOMPLETE run must not return 200 even when it has chained a continuation. The chain is
    // a best effort — the isolate can be torn down, the hop cap can be hit — so the caller keeps
    // its own bounded retry as the second line of defence. Retrying is free of duplicates: the
    // resolver's idempotency key collapses an already-enqueued recipient into a no-op.
    //
    // `incomplete` comes from the plan, so an UNREADABLE remaining count keeps the run
    // incomplete instead of reporting a clean zero it cannot substantiate.
    // A failed marker is NOT incompleteness. Every one of those recipients was enqueued, and no
    // further pass can repair the marker — a re-run returns `no_row` for them, which is not
    // markable. Reporting it as incomplete would send the caller into a retry that provably
    // cannot help. It is surfaced instead: `legacy_marker_failed` in the body, which the caller
    // logs, so the weakened rollback window is visible without pretending it is recoverable.
    const incomplete = plan.incomplete || counts.failed > 0;
    return json({
      message: `Enqueued ${counts.enqueued} follower notification(s)`,
      subtype: notify.subtype,
      incomplete,
      continued,
      ...counts,
      ...(beyondUnknown ? { deferred_unknown: true } : {}),
      ...(legacyMarkerFailures > 0 ? { legacy_marker_failed: legacyMarkerFailures } : {}),
      ...(plan.droppedRetries > 0 ? { retries_not_carried: plan.droppedRetries } : {}),
      errors: errors.length > 0 ? errors : undefined,
    }, incomplete ? 500 : 200);
  } catch (error: unknown) {
    console.error("Error in notify-followers function:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ error: message }, 500);
  }
};

serve(handler);
