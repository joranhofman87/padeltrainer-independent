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
//   * The old per-follower filter read notification_preferences.email_new_availability — a
//     column dropped in 20260210090026, whose error was discarded, so that filter had been
//     silently inert. Preference is now enforced inside enqueue_notification against
//     notification_preferences_v2, which slice C backfilled from the legacy open_slots_digest.
//   * Dates arrive as validated ISO fields, never display text.
//
// Trainer identity is still taken from the authenticated user's trainer_profiles row and is
// never read from the request body.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  classifyEnqueue,
  deferredCount,
  digestPayload,
  type EnqueueOutcome,
  eventSubject,
  legacyDedupKey,
  markableLegacyKeys,
  newCounts,
  parseNotifyRequest,
  parseResumeState,
  partitionLegacyClaims,
  resumeCursorAfter,
  shouldContinue,
  tally,
} from "../_shared/open-slots-notify.ts";

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
    const recipients: Array<{ id: string; user_id: string }> = [];

    // KEYSET paging, not offset. With `.range(from, …)` a follower deleted between pages shifts
    // every later row left, silently skipping one — and the run would still report success.
    // Paging from the last seen player_id cannot skip a row that was never read.
    let cursor: string | null = resumeState.afterPlayerId;
    let lastDiscovered: string | null = cursor;
    let discoveryStoppedEarly = false;
    for (;;) {
      if (recipients.length >= MAX_PER_RUN) { discoveryStoppedEarly = true; break; }
      // `recipients.length > 0` keeps every hop monotonic: a hop always discovers at least one
      // page, so the chain cannot stall on a cursor it never advances.
      if (recipients.length > 0 && Date.now() - start > DISCOVERY_BUDGET_MS) {
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
        if (p.user_id) recipients.push({ id: p.id, user_id: p.user_id });
      }
      if (followerPage.length < PAGE) break;
    }

    if (recipients.length === 0) {
      return json({ message: "No followers with an account", ...newCounts() }, 200);
    }

    const subject = eventSubject(notify, trainerId);
    const payload = digestPayload(notify, trainerName);
    const counts = newCounts();
    const errors: string[] = [];

    // Bounded processing: a large follower set must not blow the edge timeout. Un-processed
    // recipients are reported as `deferred` and continued — safely, because the resolver's
    // idempotency key makes an already-enqueued recipient a no-op rather than a duplicate.
    const CHUNK_SIZE = 10;
    let processed = 0;

    for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
      // The FIRST chunk always runs. A hop that enqueued nobody would hand the same cursor to
      // its successor, and the chain would spin without progress.
      if (i > 0 && Date.now() - start > TIME_BUDGET_MS) break;
      const chunk = recipients.slice(i, i + CHUNK_SIZE);

      // ── CROSS-VERSION DEDUP (transition only) ───────────────────────────────────────────
      // The pre-cutover handler claimed `notification_sends` before sending; this one relies on
      // the resolver's idempotency key in `notification_outbox`. While both versions are
      // reachable those are two ledgers that do not see each other, so a lost response + client
      // retry across the deploy flip notifies a follower twice. Consulting the legacy ledger —
      // and recording into it below — collapses that back to ONE notion of "already handled",
      // in both deploy directions. See legacyDedupKey() for the exact key shape.
      const legacyKeys = new Map<string, string>();
      for (const p of chunk) {
        const k = legacyDedupKey(notify, trainerId, p.id);
        if (k) legacyKeys.set(p.id, k);
      }
      let claimedKeys = new Set<string>();
      if (legacyKeys.size > 0) {
        const { data: claimed, error: claimError } = await supabase
          .from("notification_sends")
          .select("dedup_key")
          .in("dedup_key", [...legacyKeys.values()]);
        if (claimError) {
          // Fail CLOSED for this chunk rather than risk a duplicate send: an unreadable legacy
          // ledger means we cannot tell whether the old handler already mailed these people.
          // They are deferred, not dropped, so a later hop or retry picks them up.
          console.error("Legacy dedup lookup failed:", claimError.message);
          errors.push(`legacy dedup lookup failed: ${claimError.message}`);
          break;
        }
        claimedKeys = new Set((claimed ?? []).map((r) => r.dedup_key as string));
      }
      const { toEnqueue, alreadySent } = partitionLegacyClaims(chunk, legacyKeys, claimedKeys);

      const results: Array<{ outcome: EnqueueOutcome; id: string; err?: string }> = [
        ...alreadySent.map((p) => ({ outcome: "already_sent_legacy" as const, id: p.id })),
        ...await Promise.all(toEnqueue.map(async (player) => {
          const { data, error } = await supabase.rpc("enqueue_notification", {
            p_event_key: "open_slots_player",
            p_recipient_user_id: player.user_id,
            p_tenant_trainer_id: trainerId,
            p_idempotency_subject: subject,
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
        })),
      ];

      for (const r of results) {
        tally(counts, r.outcome);
        if (r.err) errors.push(r.err);
      }
      // Publish "handled" back into the legacy ledger for every recipient this version dealt
      // with, so a ROLLBACK to the old handler finds the key claimed and does not send a second
      // copy. A `failed` recipient is deliberately never recorded — it still needs notifying.
      const handledKeys = markableLegacyKeys(results, legacyKeys);
      if (handledKeys.length > 0) {
        const { error: markError } = await supabase
          .from("notification_sends")
          .upsert(handledKeys.map((dedup_key) => ({ dedup_key })), {
            onConflict: "dedup_key",
            ignoreDuplicates: true,
          });
        // Best-effort: the enqueue already happened and is itself idempotent, so a failed marker
        // only weakens rollback protection. It must not turn a successful enqueue into a failure.
        if (markError) console.error("Legacy dedup marker write failed:", markError.message);
      }

      processed = Math.min(i + CHUNK_SIZE, recipients.length);
    }

    // ── EXACT, RESUMABLE INCOMPLETENESS ────────────────────────────────────────────────────
    // Everything after the last processed recipient is deferred, including followers discovery
    // never reached. Both parts are counted exactly: no `Math.max(x, 1)` fudge, which used to
    // report "1 deferred" both when exactly the cap was reached (nothing was actually omitted)
    // and when tens of thousands were.
    const nextCursor = resumeCursorAfter(recipients.map((r) => r.id), processed, lastDiscovered);
    let beyondDiscovery = 0;
    if (discoveryStoppedEarly && lastDiscovered) {
      const { count: remainingCount, error: remainingError } = await supabase
        .from("trainer_followers")
        .select("player_id", { count: "exact", head: true })
        .eq("trainer_id", trainerId)
        .eq("notify_new_availability", true)
        .gt("player_id", lastDiscovered);
      if (remainingError) {
        console.error("Remaining-follower count failed:", remainingError.message);
        errors.push(`remaining follower count failed: ${remainingError.message}`);
      }
      beyondDiscovery = remainingCount ?? 0;
    }
    counts.deferred = deferredCount({
      discovered: recipients.length,
      processed,
      beyondDiscovery,
    });

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
    if (shouldContinue({ deferred: counts.deferred, processed, nextCursor, depth: resumeState.depth })) {
      const chain = fetch(`${supabaseUrl}/functions/v1/notify-followers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          ...(rawBody as Record<string, unknown>),
          resume_after_player_id: nextCursor,
          continuation_depth: resumeState.depth + 1,
        }),
      })
        .then((r) => { if (!r.ok) console.error("notify-followers self-reinvoke returned", r.status); })
        .catch((e) => console.error("notify-followers self-reinvoke failed:", e));
      const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(chain);
      else await chain;
      continued = true;
    }

    console.log(
      `open_slots_player ${notify.subtype} (hop ${resumeState.depth}): enqueued=${counts.enqueued} ` +
      `skipped=${counts.skipped} no_row=${counts.no_row} legacy=${counts.already_sent_legacy} ` +
      `failed=${counts.failed} deferred=${counts.deferred} continued=${continued}`,
    );
    if (errors.length > 0) console.error("Enqueue errors:", errors);

    // Truthful reporting: these are ENQUEUE outcomes, not deliveries.
    //
    // An INCOMPLETE run must not return 200 even when it has chained a continuation. The chain is
    // a best effort — the isolate can be torn down, the hop cap can be hit — so the caller keeps
    // its own bounded retry as the second line of defence. Retrying is free of duplicates: the
    // resolver's idempotency key and the legacy bridge both collapse a repeat into a no-op.
    const incomplete = counts.failed > 0 || counts.deferred > 0;
    return json({
      message: `Enqueued ${counts.enqueued} follower notification(s)`,
      subtype: notify.subtype,
      incomplete,
      continued,
      ...counts,
      errors: errors.length > 0 ? errors : undefined,
    }, incomplete ? 500 : 200);
  } catch (error: unknown) {
    console.error("Error in notify-followers function:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ error: message }, 500);
  }
};

serve(handler);
