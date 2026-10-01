import { supabase } from '@/lib/supabaseClient';
// THE PRIORITY REFUSAL ARM SURVIVES, ITS PARSER DOES NOT.
//
// `parsePriorityRefusal` read a refusal out of the retired edge function's 409 body. The typed
// intent has no priority fields at ALL, so supplementary priority can no longer be submitted and
// therefore can no longer be refused — the runtime refusal became a structural impossibility,
// which is strictly stronger. The RESULT ARM and its notice are kept: removing an operator-facing
// outcome is a product decision, not a consequence of retiring a producer.
import type { PriorityRefusalReason } from '@/lib/priorityUnavailable';
import {
  applyReviewedSelection, askSelection, recoverSelectionApply, reviewSelection,
  selectionIntentFromBody,
  type ReviewedSelection, type SelectionFailure, type SelectionIntent, type SelectionProjection,
  type SelectionRpc,
} from '@/lib/rebookSelectionDriver';

// ── Decoders shared by the chunk sender and the orchestration boundary ───────────────────────
//
// Every one of these VALIDATES and returns null on a mismatch. None of them coerces (`Number(v)`)
// and none of them casts a value into a shape that was never checked — those two habits are how an
// unreadable response turned into confident, wrong accounting.

/** A finite, non-negative, exact integer, or null. Deliberately NOT `Number(v)`. */
function asSafeCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Resumable, client-driven rebook-invite sender.
 *
 * A first mass rebook blast can be 150-300+ invites. Sending them all inside one
 * `bulk-rebook-cycle` invocation risks the edge wall-clock (Resend throttling
 * balloons each send), and a killed parent silently partial-sends. Instead the
 * round is created with `skipInvites`, and the client drains invites here in
 * bounded chunks via `send-priority-claim-invitation` cycleId mode:
 *   - each call sends up to `limit` still-un-invited representative claims,
 *   - `invited_at` stamping keeps it idempotent (no double-send on re-run),
 *   - the fn reports `remaining`, so we loop until drained,
 *   - we stop on no-progress (a whole chunk failed) so a hard failure can't loop
 *     forever — the owner can re-run the drain later ("resume sending").
 */

export interface SendChunkResult {
  sent: number;
  failed: number;
  /** Emails that went out but whose invited_at stamp did NOT land — still need a retry to stamp, so
   *  a chunk of all-unresolved is NOT a completed drain (Codex round-7 #1). */
  /**
   * THE CLOSED, DISJOINT OUTCOME SET. Exactly one per attempted claim, summing to `attempted` —
   * asserted by the endpoint before it answers. Three review rounds in a row found a consumer that
   * had the arithmetic wrong because `sent` and `unresolved` overlapped; no consumer subtracts
   * anything any more, because there is nothing to subtract.
   */
  already: number;
  suppressed: number;
  held: number;
  unstamped: number;
  /** claims this chunk actually tried: queued + already + suppressed + held + unstamped + failed */
  attempted: number;
  remaining: number;
  failedClaimIds: string[];
  unresolvedClaimIds: string[];
  /** First per-send failure reason from the edge fn (e.g. a Resend rejection), if any. */
  sampleError?: string | null;
}

/** Injectable for tests; production hits the edge function. */
export type ChunkSender = (args: {
  cycleId: string;
  /**
   * The D7 round these cycles belong to. Threaded all the way to the edge because the invitation
   * is enqueued as a PROTECTED event whose subject triple is scoped to a round — the database
   * refuses one without it. Optional in the type only so a test sender may omit it.
   */
  roundId?: string;
  limit: number;
  customMessage?: string | null;
  customSubject?: string | null;
}) => Promise<SendChunkResult>;

export interface DrainProgress {
  /** Invites successfully sent so far this drain. */
  totalSent: number;
  /** Best-estimate invites still to send (untouched + this-chunk failures). */
  stillToSend: number;
  /** Sendable total for this drain, learned from the first chunk (sent+failed+remaining).
   *  Excludes emailless reps, so it can be < the round's representativeCount. */
  total: number;
}

export interface DrainResult {
  totalSent: number;
  /** Representative invites still not sent OR sent-but-un-stamped (0 ⇒ fully drained). `null` ⇒ UNKNOWN
   *  — a send THREW, so the authoritative remainder is genuinely unknown (a network error can land after
   *  the edge sent but before we saw the response) and must NOT be reported as a number (round-11 #1). */
  leftover: number | null;
  /** The last OBSERVED outstanding count (non-authoritative — on an error it's a stale upper bound, not
   *  the real remainder). `null` if no chunk was ever observed. For display only; never as truth. */
  lastKnownLeftover: number | null;
  /** 'unresolved' = a chunk's emails went out but their invited_at stamps didn't land; the claims stay
   *  eligible and a later drain re-stamps them (deduped by the idempotency key). 'iteration_limit' =
   *  the maxIterations backstop was hit with work still outstanding (a very large run). Only 'drained'
   *  means zero outstanding. */
  stoppedReason: 'drained' | 'no_progress' | 'error' | 'unresolved' | 'iteration_limit';
  failedClaimIds: string[];
  /** Claims still un-stamped at stop (sent but unresolved) — the retry set. */
  unresolvedClaimIds: string[];
  /** A sample failure reason (first Resend rejection / thrown error) — so the UI can show WHY, not
   *  just "N not sent". Null when nothing failed. */
  sampleError?: string | null;
}

/** Every string in an array, or null if the value is not an array of strings. Never filtered. */
function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const entry of v) {
    if (typeof entry !== 'string') return null;
    out.push(entry);
  }
  return out;
}

/**
 * Read one chunk answer from the sender.
 *
 * EXPORTED SO IT CAN BE TESTED AGAINST THE SHAPES THE SERVER ACTUALLY SENDS. Review round 1 of the
 * closure found three real terminal answers this rejected, and the reason nothing caught it was
 * that every test injected a fake sender: the decoder was only ever fed fixtures that already had
 * all six fields.
 */
export function readChunkResponse(data: Record<string, unknown>): SendChunkResult {
  // DECODED, not coerced. `Number(data.sent ?? 0)` turned a missing or mistyped count into NaN,
  // which then flowed silently into totalSent / leftover and rendered as "NaN invitations sent".
  // A chunk we cannot read is a chunk whose outcome is genuinely UNKNOWN, so it throws — the drain
  // records `error`, and `leftover` becomes null rather than a fabricated number.
  //
  // ABSENT IS NOT THE SAME AS MALFORMED, and conflating them broke three real answers.
  //
  // REVIEW ROUND 1 (P2): the sender has THREE terminal branches that return `{sent, skipped,
  // remaining}` and nothing else — "no drainable reps", "no claims", and "every claim already
  // invited or ineligible" (`send-priority-claim-invitation`). Requiring all six fields turned each
  // of those HTTP 200 answers into `send_chunk_unreadable`, so a round with nothing left to send
  // reported an interrupted delivery. The closure makes that path ordinary rather than rare: a
  // RECOVERED round is very often one whose invitations already went out.
  //
  // The rule is unchanged where it matters — a field that is PRESENT and mistyped is still
  // unreadable, because that is a server saying something we cannot read. A field the server does
  // not send at all is simply zero, which is what those branches mean.
  const sent = asSafeCount(data.sent);
  const remaining = asSafeCount(data.remaining);
  const failed = data.failed === undefined ? 0 : asSafeCount(data.failed);
  const already = data.already === undefined ? 0 : asSafeCount(data.already);
  const suppressed = data.suppressed === undefined ? 0 : asSafeCount(data.suppressed);
  const held = data.held === undefined ? 0 : asSafeCount(data.held);
  const unstamped = data.unstamped === undefined ? 0 : asSafeCount(data.unstamped);
  const failedClaimIds = data.failedClaimIds === undefined ? [] : asStringArray(data.failedClaimIds);
  const needsAttentionClaimIds = data.needsAttentionClaimIds === undefined
    ? [] : asStringArray(data.needsAttentionClaimIds);
  if (
    sent === null || failed === null || already === null || suppressed === null || held === null ||
    unstamped === null || remaining === null || failedClaimIds === null || needsAttentionClaimIds === null
  ) {
    throw new Error('send_chunk_unreadable');
  }
  // `attempted` is what the endpoint says it tried. An older endpoint that does not send it is
  // reconstructed from the disjoint buckets — which is exact, because they ARE disjoint.
  const attempted = data.attempted === undefined
    ? sent + already + suppressed + held + unstamped + failed
    : asSafeCount(data.attempted);
  if (attempted === null) throw new Error('send_chunk_unreadable');
  return {
    sent,
    failed,
    already,
    suppressed,
    held,
    unstamped,
    attempted,
    remaining,
    failedClaimIds,
    unresolvedClaimIds: needsAttentionClaimIds,
    sampleError: typeof data.sampleError === 'string' ? data.sampleError : null,
  };
}

const defaultSender: ChunkSender = async ({ cycleId, roundId, limit, customMessage, customSubject }) => {
  const { data, error } = await supabase.functions.invoke('send-priority-claim-invitation', {
    body: {
      cycleId,
      roundId,
      limit,
      customMessage: customMessage || undefined,
      customSubject: customSubject || undefined,
    },
  });
  if (error || !data) throw error ?? new Error('send_failed');
  return readChunkResponse(data as Record<string, unknown>);

};

export interface DrainOptions {
  /** The round the cycles belong to; required for a live send, see `ChunkSender`. */
  roundId?: string;
  limit?: number;
  maxIterations?: number;
  customMessage?: string | null;
  customSubject?: string | null;
  onProgress?: (p: DrainProgress) => void;
  sender?: ChunkSender;
}

export async function drainRebookInvites(
  cycleId: string,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const limit = opts.limit ?? 40;
  const maxIterations = opts.maxIterations ?? 500;
  const send = opts.sender ?? defaultSender;

  let totalSent = 0;
  let remaining = 0;
  let lastFailed = 0;
  let lastNeedsAttention = 0;
  let lastUnresolvedClaimIds: string[] = [];
  let total = 0; // sendable total, learned from the first chunk
  let sawChunk = false; // did at least one chunk return a count? (else an error leaves leftover UNKNOWN)
  const failedClaimIds = new Set<string>();
  // Default: if the loop runs to completion without a break, we hit the maxIterations backstop with
  // work still outstanding (Codex round-8 #1) — NOT a clean drain. A break below sets the real reason.
  let stoppedReason: DrainResult['stoppedReason'] = 'iteration_limit';
  let sampleError: string | null = null;

  for (let i = 0; i < maxIterations; i++) {
    let chunk: SendChunkResult;
    try {
      chunk = await send({ cycleId, roundId: opts.roundId, limit, customMessage: opts.customMessage, customSubject: opts.customSubject });
    } catch (e) {
      stoppedReason = 'error';
      if (!sampleError) sampleError = e instanceof Error ? e.message : String(e);
      break;
    }
    sawChunk = true;
    totalSent += chunk.sent;
    remaining = chunk.remaining;
    lastFailed = chunk.failed;
    lastNeedsAttention = chunk.suppressed + chunk.held + chunk.unstamped;
    lastUnresolvedClaimIds = chunk.unresolvedClaimIds;
    if (!sampleError && chunk.sampleError) sampleError = chunk.sampleError;
    // The first chunk reveals the full sendable set (this chunk's attempts + what's
    // left); pin it so a progress bar has a stable, emailless-excluded denominator.
    // `unresolved` is one of this chunk's ATTEMPTS — a zero-send or an un-stamped send — so it
    // belongs in the denominator exactly as `failed` does. Omitting it (round 5) made the
    // denominator smaller than the `stillToSend` numerator below, which counts it.
    // MINUS THE OVERLAP. `sent` and `unresolved` are not disjoint: an enqueue whose stamp failed is
    // in both, so adding them counted that claim twice and inflated the set the progress bar is
    // measured against — 40 queued plus 40 un-stamped of 100 read as 140 (review round 5).
    // NO SUBTRACTION. The buckets are disjoint, so the sendable set is simply what this chunk
    // attempted plus what is left. Every previous version of this line adjusted for an overlap
    // between `sent` and `unresolved`; that overlap no longer exists.
    if (i === 0) total = chunk.attempted + chunk.remaining;
    for (const id of chunk.failedClaimIds) failedClaimIds.add(id);
    opts.onProgress?.({
      totalSent,
      stillToSend: remaining + chunk.failed + chunk.suppressed + chunk.held + chunk.unstamped,
      total,
    });

    // Fully drained ONLY when nothing remains, nothing failed, AND nothing is unresolved (Codex
    // round-7 #1) — a chunk of sent-but-un-stamped emails is NOT a completed drain.
    if (chunk.remaining === 0 && chunk.failed === 0 && chunk.suppressed + chunk.held + chunk.unstamped === 0) { stoppedReason = 'drained'; break; }
    // Terminal all-unresolved: the emails went out but their stamps didn't land, and nothing else is
    // left. Stop as retryable 'unresolved' instead of looping to re-send (deduped) forever — a later
    // drain re-stamps them. (invited_at stays NULL, so they remain eligible.)
    if (chunk.remaining === 0 && chunk.failed === 0 && chunk.suppressed + chunk.held + chunk.unstamped > 0) { stoppedReason = 'unresolved'; break; }
    // NO forward progress on sending (chunk.sent === 0). We only reach here when work is still
    // outstanding (the drained/unresolved checks above already handled the all-clear cases), so this is
    // ALWAYS a stall, never 'drained' (Codex round-8 #1) — e.g. sent:0 with remaining>0. Failures never
    // stamped invited_at, so a later re-run retries.
    if (chunk.sent === 0) { stoppedReason = 'no_progress'; break; }
  }

  // Honest leftover (Codex round-11 #1): ANY thrown invocation makes the authoritative remainder
  // UNKNOWN — a network exception can land AFTER the edge sent messages but before we saw the response,
  // so even a prior chunk's count is only a stale UPPER BOUND, not the real remainder. So `error` ⇒
  // null. `lastKnownLeftover` exposes that prior observation separately, clearly non-authoritative.
  // Everything still needing action: what is left, plus this chunk's outcomes that are not done.
  const knownCount: number | null = sawChunk ? remaining + lastFailed + lastNeedsAttention : null;
  const leftover: number | null = stoppedReason === 'error' ? null : knownCount;
  return { totalSent, leftover, lastKnownLeftover: knownCount, stoppedReason, failedClaimIds: [...failedClaimIds], unresolvedClaimIds: lastUnresolvedClaimIds, sampleError };
}

/**
 * Drain the invites for a whole rebook ROUND — a per-series run now creates one cycle per series
 * (all sharing settings.rebook_round_id), so the invites live across N sibling cycles. Runs the
 * per-cycle drain for each id sequentially (each cycle's send-priority-claim-invitation is scoped
 * by cyclus_id) and merges the results into one round-level DrainResult, so nothing is stranded on
 * a sibling cycle. onProgress reports the running round total across all cycles.
 */
export async function drainRebookRoundInvites(
  cycleIds: string[],
  opts: DrainOptions = {},
): Promise<DrainResult> {
  let totalSent = 0;
  // null once ANY sibling cycle's leftover is unknown (an error before that cycle learned a count) —
  // the round total can't be honestly summed past an unknown (Codex round-10/11 #1).
  let leftover: number | null = 0;
  let lastKnownLeftover = 0; // best-effort observed sum (non-authoritative)
  // Round-wide progress denominator (Codex round-11 #2): sum of the denominators of the cycles that
  // have finished, so `total` is round-wide like the numerator — never a per-cycle "5 / 3".
  let completedTotal = 0;
  const failedClaimIds = new Set<string>();
  const unresolvedClaimIds = new Set<string>();
  // Worst reason wins across the round's cycles (higher rank = worse). 'drained' only survives if
  // EVERY cycle drained cleanly.
  const RANK: Record<DrainResult['stoppedReason'], number> = { drained: 0, unresolved: 1, iteration_limit: 2, no_progress: 3, error: 4 };
  let stoppedReason: DrainResult['stoppedReason'] = 'drained';
  let sampleError: string | null = null;

  for (const cycleId of cycleIds) {
    const before = totalSent;
    let cycleTotal = 0; // this cycle's denominator, learned from its first chunk
    const res = await drainRebookInvites(cycleId, {
      ...opts,
      // Rebase BOTH numerator and denominator onto the round: sent = finished cycles' sent + this
      // cycle's sent; total = finished cycles' totals + this cycle's total. Monotonic; total >= sent.
      onProgress: opts.onProgress
        ? (p) => {
            cycleTotal = p.total;
            opts.onProgress!({ totalSent: before + p.totalSent, stillToSend: p.stillToSend, total: completedTotal + p.total });
          }
        : undefined,
    });
    completedTotal += cycleTotal;
    totalSent += res.totalSent;
    if (res.leftover === null) leftover = null;
    else if (leftover !== null) leftover += res.leftover;
    lastKnownLeftover += res.lastKnownLeftover ?? 0;
    for (const id of res.failedClaimIds) failedClaimIds.add(id);
    for (const id of res.unresolvedClaimIds) unresolvedClaimIds.add(id);
    if (!sampleError && res.sampleError) sampleError = res.sampleError;
    if (RANK[res.stoppedReason] > RANK[stoppedReason]) stoppedReason = res.stoppedReason;
  }

  return { totalSent, leftover, lastKnownLeftover, stoppedReason, failedClaimIds: [...failedClaimIds], unresolvedClaimIds: [...unresolvedClaimIds], sampleError };
}

// ===== Shared create-then-drain orchestration (Codex round-9 #1/#2) =====
//
// BOTH round wizards (RebookCohortWizard, AcademyNewRoundWizard) must create the round WITHOUT sending
// (skipInvites + roundAware) and then drain invites in bounded, resumable chunks — never send inline,
// which at volume leaves a committed round with partially-sent invites and no response to interpret.
// This single helper is that orchestration, so the two wizards cannot diverge.
//
// ── The truth boundary ──────────────────────────────────────────────────────────────────────
//
// There are exactly FOUR things that can be true after asking the server to create a round, and the
// caller must be able to tell them apart:
//
//   priority_refused  the server refused the request in preflight. Nothing was created, nothing was
//                     read, and the refusal carries its own audited counts.
//   creation_failed   the server PROVED no round exists — it said so, with a reason.
//   created           a fully VERIFIED creation: every field the caller will act on was decoded and
//                     validated, so draining and navigating are safe.
//   unknown           anything else. The round may or may not exist. Zero invites are drained, no
//                     success is shown, nothing is navigated to, and a validated target-cycle id is
//                     preserved when one was present so the operator can go and look.
//
// The previous shape had three defects this union removes structurally:
//
//   1. `if (!targetCycleId) return creation_failed` INFERRED absence from an incomplete response. A
//      truncated body, a proxy error page or a drifted field produced a confident "the round was not
//      created" — the one claim we are least entitled to make after a write may have happened.
//   2. `if (error) throw error` discarded the typed body on every non-2xx. The preflight refusal is a
//      409, so the one response designed to be read was the one that could never be read.
//   3. `Number(d.groups ?? 0)` and `d.targetCycles as Array<{id: string}>` coerced and cast rather
//      than validating: `Number({}) === NaN`, and the cast produced `undefined` cycle ids that were
//      then handed to the drain.

/** Why a result could not be verified. Structured, so copy and tests key on a value, not a string. */
export type RoundUnknownReason =
  /** The response body could not be read or was not an object at all. */
  | 'unreadable_response'
  /** A body arrived, but a field the caller must act on was missing, mistyped or drifted. */
  | 'unverified_creation'
  /** A legacy/inline edge answered: it may have emailed people, with accounting we cannot verify. */
  | 'unsupported_inline_delivery'
  /** The call itself failed (non-2xx or transport), with no typed body to interpret. */
  | 'transport_error';

/**
 * Discriminated outcome. `created` is the ONLY arm that may drain, show success or navigate.
 */
export type RoundOrchestrationResult =
  | { phase: 'priority_refused'; reason: PriorityRefusalReason; totalSubmitted: number }
  | { phase: 'creation_failed'; reason: string }
  /** The same distinct outcome the preview has, for the same reason. Nothing was created. */
  | { phase: 'selection_moved' }
  | {
      phase: 'created';
      targetCycleId: string;
      roundId: string;
      groups: number;
      players: number;
      totalSent: number;
      /** Invites still not sent OR sent-but-un-stamped (0 ⇒ everything delivered). `null` ⇒ UNKNOWN (a
       *  send threw before any count was learned — Codex round-10 #1); the UI shows a no-numbers copy. */
      leftover: number | null;
      outcome: DrainResult['stoppedReason'];
      sampleError: string | null;
      /**
       * WHO WAS REACHABLE WHEN THE ROUND WAS WRITTEN, as the server counted them.
       *
       * OD1/OD2. The operator approved a projection taken at review time; contact data is a
       * mutable attribute and may have moved since. The apply proceeds either way — that is the
       * decision — and this is what makes the movement VISIBLE instead of silent. Null when the
       * round was recovered from the ledger rather than applied here, because a stored receipt
       * does not carry a fresh contact count and inventing one would be worse than admitting it.
       */
      contactableCount: number | null;
      uncontactableCount: number | null;
    }
  | {
      /**
       * THE ROUND EXISTS, AND WHETHER ITS INVITATIONS WENT OUT IS NOT KNOWABLE FROM HERE.
       *
       * `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1`. A provider send is durably recorded only by
       * `slot_priority_claims.invited_at`, which is written AFTER the send returns
       * (`send-priority-claim-invitation`: send-then-stamp). So an unstamped claim is genuinely
       * ambiguous — never sent, or sent with a failed stamp — and the ONLY thing standing between
       * a re-drain and a duplicate email is the provider's deterministic idempotency key, which
       * Resend dedupes for 24 hours. That is a provider contract with a time bound, not a durable
       * authority, and a round recovered a day later is outside it.
       *
       * So this path fails closed: the round is reported, and nothing is sent. Resuming remains
       * available to the operator as an EXPLICIT action from the round's own page, where the
       * unresolved counts are visible. It is reached two ways, both of which mean "an earlier
       * attempt may already have mailed people": a receipt recovered from the ledger, and an apply
       * the server answered `replayed`.
       */
      phase: 'recovered';
      roundId: string;
      targetCycleId: string;
      groups: number;
      commandId: string;
      /** `replay` — the apply itself said so. `ledger` — we had to go and look it up. */
      via: 'replay' | 'ledger';
    }
  | {
      phase: 'unknown';
      reason: RoundUnknownReason;
      /** Preserved when the response carried a valid one, so the operator can inspect/recover. Never
       *  navigated to automatically — a link the user chooses to follow is not a success claim. */
      targetCycleId: string | null;
      /** The command uuid, when one was in flight: the only thing that can resolve an ambiguous
       *  apply, because re-presenting it replays the stored receipt rather than creating a second
       *  round. Absent when nothing was ever sent. */
      commandId?: string;
      /**
       * WHAT THE COMMAND LEDGER SAID WHEN WE ASKED IT.
       *
       * REVIEW ROUND 1 (P1): NEITHER VALUE PROVES ABSENCE, and an earlier version of this field
       * claimed one did. `not_visible` means no command under either handle is visible to THIS
       * ACTOR — which the ledger reports identically for "no such command" and for "you are no
       * longer a manager here". `unreadable` means we asked and could not decide at all. Both are
       * reasons to go and look; only one of them is even weakly suggestive, and neither licenses
       * "start again".
       */
      recovery?: 'not_visible' | 'unreadable';
    };

export interface RoundOrchestrationDeps {
  /** Injected for tests; production passes `supabase.rpc`. */
  rpc: SelectionRpc;
  /** Injected for tests; production uses the real round drain. */
  drain?: typeof drainRebookRoundInvites;
  /** Injected for tests; production uses the real ledger lookup. Reads only; cannot write. */
  recover?: typeof recoverSelectionApply;
  onProgress?: (p: DrainProgress) => void;
}

// ── WHAT WAS HERE, AND WHY IT IS GONE ────────────────────────────────────────────────────────
//
// Three decoders for the retired edge producer's response shapes: `readTypedErrorBody` (pull the
// typed body off a supabase-js `FunctionsHttpError`), `decodeTerminalBody` (a 409 preflight refusal
// or a proven `phase: 'creation'` failure) and `verifyCreation` (validate a `phase: 'delivery'`
// body's every field before believing it).
//
// They are DELETED rather than kept for a rainy day. `LEGACY=NO_bulk-rebook-cycle_PRODUCER_NO
// _LEGACY_DRY_RUN_AND_NO_FALLBACK_PATH_RETAINED`: a decoder for a producer nothing calls is a
// fallback path waiting for someone to re-wire it, and the rules they enforced did not go with
// them — they are enforced above against the shapes that can actually arrive.

/**
 * The dry-run (preview/review) half of the same contract.
 *
 * IT NO LONGER ASKS AN EDGE FUNCTION. `bulk-rebook-cycle` decided which slots a selection meant,
 * clustered them, named the children and created the round; that authority now lives in the
 * database, and this asks it through `rebook_round_selection_preview_as_actor`. There is no
 * legacy dry run left to fall back to, deliberately — a fallback would be a second producer with a
 * different idea of what the operator selected.
 *
 * THE PROJECTION IS AN ARGUMENT, NOT AN INFERENCE. `counts` answers the auto-count, which fires on
 * locations and dates alone and which the typed core cannot judge at all (no label, no length, no
 * round id — three separate refusals). `review` calls the core and returns the fingerprint. The
 * caller knows which it is doing; guessing from how complete the body looks would make a
 * half-filled form silently ask the wrong question.
 *
 * `aborted` is reported separately from `unknown`: a superseded request carries no information
 * about the world, and must never clear or replace the authority held by the request that
 * superseded it.
 */
export type RoundPreviewResult =
  | { phase: 'priority_refused'; reason: PriorityRefusalReason; totalSubmitted: number }
  | {
      phase: 'preview';
      body: Record<string, unknown>;
      selectionDigest: string | null;
      /**
       * Present only for a `review` projection. It carries the fingerprint, the minted target
       * identities and the command uuid — everything the apply must present UNCHANGED, because the
       * fingerprint binds all three. A caller that discards it can display the review but cannot
       * send it, which is the right way round.
       */
      reviewed: ReviewedSelection | null;
    }
  | { phase: 'creation_failed'; reason: string }
  /**
   * The selection the caller echoed is not the selection the server now derives. A DISTINCT
   * outcome, not an `unknown`: nothing is uncertain about it, and the operator's recovery is
   * specific — look again at what has changed. Folding it into `unknown` would tell them we could
   * not confirm what happened, which is false, and folding it into `creation_failed` would tell
   * them there was nothing to rebook, which is also false.
   */
  | { phase: 'selection_moved' }
  /**
   * The server reviewed the intent and will not let it be sent.
   *
   * REVIEW ROUND 1 (P1). Two of these are reachable from the shipped wizards today and neither was
   * visible before:
   *
   *   • `session_price` — ABC-27 marks ANY non-null session price apply-ineligible. Both wizards
   *     have a price field and both PREFILL it from the source term, so this is the ordinary case,
   *     not an edge one.
   *   • `extend_unavailable` — an extend is fenced on the round's stored normalized policy, and
   *     only a typed apply ever writes one. Every round that exists today was created by the
   *     retired producer, so none of them can be extended through this path.
   *
   * Both are properties of the frozen contract, not of this client. What this client must not do is
   * arm a send that can only fail, so the review is shown and the send is withheld with the reason.
   */
  | {
      phase: 'not_permitted';
      reason: 'session_price' | 'extend_unavailable' | 'not_permitted';
      /** Present when a real review WAS produced: the send is withheld, the information is not. */
      body?: Record<string, unknown>;
      selectionDigest?: string | null;
    }
  | { phase: 'unknown'; reason: RoundUnknownReason }
  | { phase: 'aborted' };

export interface RoundPreviewDeps {
  /** Injected for tests; production passes `supabase.rpc`. */
  rpc: SelectionRpc;
  /**
   * Injected for tests; production passes `newSelectionUuid`.
   *
   * A REVIEW MINTS. The typed protocol has the caller mint one identity per generated slot, and the
   * fingerprint binds them, so identity is part of what a review IS — a test that cannot control it
   * cannot assert that a retry replays instead of creating a second round.
   */
  newUuid: () => string;
  signal?: AbortSignal;
}

/**
 * The two facts that belong to the CONVERSATION rather than to the operator's choices.
 *
 * Both are kept in refs by the wizards and passed in, never folded into the memoized body: each
 * wizard derives a `revision` from that body and blocks the send whenever it changes, so a digest
 * that arrived with a server answer and went back into the body would invalidate the very review it
 * had just produced — on every answer, forever.
 */
export interface RoundSelectionSession {
  /** Client-minted, stable for the life of the wizard. Never re-minted on a retry. */
  roundId: string;
  /** The digest the last answer carried, echoed on the next call so a moved selection is refused. */
  selectionDigest?: string | null;
}

/** Map a driver failure onto the outcome vocabulary the wizards already render. */
function fromSelectionFailure(reason: SelectionFailure): RoundPreviewResult {
  switch (reason) {
    case 'selection_moved':
      return { phase: 'selection_moved' };
    case 'refused':
      // The surface refuses an unauthorized caller and a caller speaking outside its closed
      // vocabularies with the SAME closed row, so this client cannot tell them apart — and must
      // not pretend to. Both are `unknown`, which is exactly what they are from here.
      return { phase: 'unknown', reason: 'unverified_creation' };
    case 'unreadable_response':
      return { phase: 'unknown', reason: 'unreadable_response' };
    default:
      return { phase: 'unknown', reason: 'transport_error' };
  }
}

export async function previewRebookRound(
  body: Record<string, unknown>,
  deps: RoundPreviewDeps,
  session: RoundSelectionSession,
  projection: SelectionProjection,
): Promise<RoundPreviewResult> {
  const intent = selectionIntentFromBody(body, session);
  if (!intent) return { phase: 'unknown', reason: 'unverified_creation' };

  // COUNTS IS ONE CALL; REVIEW IS THREE. `review` with an empty identity pool is refused by design
  // — that is how the caller learns how many identities to mint — so a review that stopped at the
  // first answer could only ever display a refusal.
  if (projection === 'counts') {
    const result = await askSelection(intent, 'counts', [], deps);
    if (result.phase === 'aborted') return { phase: 'aborted' };
    if (result.phase === 'failed') return fromSelectionFailure(result.reason);
    return {
      phase: 'preview',
      body: result.answer.legacy,
      selectionDigest: result.answer.selectionDigest,
      reviewed: null,
    };
  }

  const result = await reviewSelection(intent, deps);
  if (result.phase === 'aborted') return { phase: 'aborted' };
  if (result.phase === 'extend_unavailable') {
    // Decided by the driver WITHOUT asking, because the typed contract cannot accept an extend
    // today. Labelling a server refusal from the outside was the previous shape, and it guessed
    // wrong: the real answer is `invalid_request`, which reads to the operator as "nothing to
    // rebook".
    return { phase: 'not_permitted', reason: 'extend_unavailable' };
  }
  if (result.phase === 'failed') return fromSelectionFailure(result.reason);
  if (result.phase === 'apply_ineligible') {
    // REVIEW ROUND 2 (P2): THE REVIEW BODY COMES WITH IT. The stated mitigation is that the
    // operator SEES the review and the send is withheld — discarding the body made that false, and
    // both wizards then cleared the screen. What is withheld is the send authority, not the
    // information.
    return {
      phase: 'not_permitted',
      reason: result.eligibility === 'refused_session_price' ? 'session_price' : 'not_permitted',
      body: result.answer.legacy,
      selectionDigest: result.answer.selectionDigest,
    };
  }
  if (result.phase === 'refused') {
    // THE CORE JUDGED IT AND SAID NO, which is proof of absence in its own vocabulary — the review
    // core is STABLE and writes nothing, so there is nothing uncertain here.
    return { phase: 'creation_failed', reason: result.answer.status };
  }
  return {
    phase: 'preview',
    body: result.answer.legacy,
    selectionDigest: result.answer.selectionDigest,
    reviewed: result.reviewed,
  };
}

export async function createAndDrainRebookRound(
  body: Record<string, unknown>,
  deps: RoundOrchestrationDeps,
  session: RoundSelectionSession,
  reviewed: ReviewedSelection,
): Promise<RoundOrchestrationResult> {
  const intent = selectionIntentFromBody(body, { roundId: session.roundId, selectionDigest: reviewed.selectionDigest });
  if (!intent) return { phase: 'unknown', reason: 'unverified_creation', targetCycleId: null };

  // IT APPLIES THE REVIEW, IT DOES NOT RE-REVIEW. The fingerprint binds the minted target
  // identities, so anything re-derived here would be something the operator never approved — and
  // the server would report that as source drift, a message about their sources for a defect in
  // this file.
  const applied = await applyReviewedSelection(intent, reviewed, deps);

  if (applied.phase === 'failed') {
    const mapped = fromSelectionFailure(applied.reason);
    if (mapped.phase === 'selection_moved') return { phase: 'selection_moved' };
    return {
      phase: 'unknown',
      reason: mapped.phase === 'unknown' ? mapped.reason : 'transport_error',
      targetCycleId: null,
    };
  }
  if (applied.phase === 'unknown') {
    // THE COMMAND MAY HAVE COMMITTED. A transport failure says nothing about the server's state, so
    // this is never "nothing was created", and no invite is drained against a round whose
    // existence was not established.
    //
    // D7 TERMINAL CLOSURE: SO GO AND FIND OUT. Round 1 made this branch carry the command uuid,
    // which was the only handle that could resolve it — and then nothing ever used the handle. The
    // ledger has held the answer the whole time, actor-scoped and granted; asking it costs two
    // STABLE reads and cannot create anything.
    return finishFromRecovery(body, deps, intent, reviewed, 'transport_error');
  }
  if (applied.phase === 'refused') {
    // REVIEW ROUND 1 (P2): `selection_moved` KEEPS ITS OWN OUTCOME HERE TOO. The apply surface can
    // answer it — the selection can move between the review and the send — and collapsing it into
    // `creation_failed` made both wizards' dedicated recovery branches unreachable, leaving a stale
    // review and digest on screen with a generic error beside them.
    if (applied.status === 'selection_moved') return { phase: 'selection_moved' };
    // `invalid_request` MAY BE THE DUPLICATE-INTENT REFUSAL, WHICH IS NOT AN ABSENCE.
    //
    // D7 TERMINAL CLOSURE. `uq_rebook_round_commands_actor_review` makes one actor's reviewed
    // intent applicable exactly once, and the writer's own refusal detail says what to do about
    // it: "this actor already applied this exact reviewed intent under another command UUID;
    // recover it by review fingerprint". A round WAS created — under a uuid this tab never saw —
    // so reporting `creation_failed` here told the operator the opposite of the truth and invited
    // them to try again.
    //
    // When the ledger shows nothing visible, the typed refusal is reported exactly as before —
    // the core refuses before it writes, so that word is the server's own and does not depend on
    // the ledger having proved anything.
    if (applied.status === 'invalid_request') {
      return finishFromRecovery(body, deps, intent, reviewed, 'unverified_creation',
        { phase: 'creation_failed', reason: applied.status });
    }
    // A TYPED REFUSAL IS PROOF OF ABSENCE, and the only place this contract may claim it. The core
    // answers `source_drift`, `round_not_found` and their siblings BEFORE it writes anything, so
    // nothing was created and the reason is the server's own word for why.
    return { phase: 'creation_failed', reason: applied.status };
  }

  const { roundId, childCycleIds, claimCount } = applied;
  if (childCycleIds.length === 0) {
    return { phase: 'unknown', reason: 'unverified_creation', targetCycleId: null };
  }
  // The first child is what the operator is shown; every child is what gets drained.
  const targetCycleId = childCycleIds[0];

  // A verified round with nothing to invite is a real, complete success — not an unknown. The
  // server counted zero claims; there is no send to be uncertain about.
  //
  // REVIEW ROUND 3 (P2): UNLESS IT CONTRADICTS THE REVIEW. Both wizards only send a review whose
  // cohort is non-empty, so a receipt claiming zero claims for an approved cohort of five is not a
  // quiet success — it is two statements about the same round that cannot both be true. Believing
  // it navigated the operator to a "created, nobody to invite" round while the claims may well
  // exist and never be drained.
  if (claimCount === 0 && reviewed.cohortTotal > 0) {
    return {
      phase: 'unknown',
      reason: 'unverified_creation',
      targetCycleId,
      commandId: reviewed.commandId,
    };
  }
  if (claimCount === 0) {
    return {
      phase: 'created',
      targetCycleId,
      roundId,
      groups: applied.childCount,
      players: 0,   // no claims means nobody to invite
      totalSent: 0,
      leftover: 0,
      outcome: 'drained',
      sampleError: null,
      contactableCount: applied.contactableCount,
      uncontactableCount: applied.uncontactableCount,
    };
  }

  // A REPLAY IS AN EARLIER COMMAND'S ROUND, and an earlier command may have drained it. The server
  // answers from stored bytes without re-deriving anything, so this call learned only that the
  // round exists — not whether anyone has been mailed. Same ambiguity, same fail-closed answer.
  if (applied.replayed) {
    return {
      phase: 'recovered',
      roundId,
      targetCycleId,
      groups: applied.childCount,
      commandId: reviewed.commandId,
      via: 'replay',
    };
  }
  return drainAndReport(body, deps, reviewed, roundId, childCycleIds, applied.childCount,
    applied.contactableCount, applied.uncontactableCount);
}

/**
 * Drain the round's invitations and report what happened.
 *
 * Shared by the ordinary apply and by a RECOVERED one, deliberately: a recovered round must be
 * finished exactly as an acknowledged one is, or recovery would be a second, less-tested code path
 * doing the most consequential half of the work.
 */
async function drainAndReport(
  body: Record<string, unknown>,
  deps: RoundOrchestrationDeps,
  reviewed: ReviewedSelection,
  roundId: string,
  childCycleIds: string[],
  groups: number,
  contactableCount: number | null,
  uncontactableCount: number | null,
): Promise<RoundOrchestrationResult> {
  const drainRes = await (deps.drain ?? drainRebookRoundInvites)(childCycleIds, {
    // THE ROUND TRAVELS WITH THE CYCLES. An invitation is enqueued as a protected event whose
    // subject is scoped to a round; the child cycles alone no longer identify what is being sent.
    roundId,
    customMessage: typeof body.invitationMessage === 'string' ? body.invitationMessage : null,
    customSubject: typeof body.invitationSubject === 'string' ? body.invitationSubject : null,
    onProgress: deps.onProgress,
  });
  return {
    phase: 'created',
    targetCycleId: childCycleIds[0],
    roundId,
    groups,
    // REVIEW ROUND 2 (P2): CLAIMS ARE NOT PLAYERS. `claim_count` is occurrences × subjects — a
    // five-player group over eight sessions is forty claims — so reporting it as `players` told
    // the operator they had invited forty people. The headcount is the REVIEW's distinct cohort
    // total, which is the number they approved.
    players: reviewed.cohortTotal,
    totalSent: drainRes.totalSent,
    leftover: drainRes.leftover,
    outcome: drainRes.stoppedReason,
    sampleError: drainRes.sampleError ?? null,
    contactableCount,
    uncontactableCount,
  };
}

/**
 * Ask the command ledger what became of an apply we could not read, and finish accordingly.
 *
 * RE-DRAINING IS SAFE IN THE ORDINARY CASE, AND THE EXCEPTION IS WORTH NAMING.
 *
 * The sender reads only `status = 'pending'` claims and then skips any whose `invited_at` is
 * already stamped (`send-priority-claim-invitation`), so a claim that was invited is not invited
 * again. That covers a recovered round being finished, which is what this path does.
 *
 * REVIEW ROUND 1 (P3) sharpened it: sending does not change `status`, and the stamp is a separate
 * write. If a provider send SUCCEEDS and its stamp then fails, the claim stays pending and
 * unstamped, and a later resume will send it again — protected only by the provider's own
 * idempotency key, which Resend documents as a 24-hour window. So this is "no duplicate within the
 * window the provider guarantees", not "no duplicate, ever", and an earlier version of this comment
 * claimed the stronger thing.
 */
async function finishFromRecovery(
  body: Record<string, unknown>,
  deps: RoundOrchestrationDeps,
  intent: SelectionIntent,
  reviewed: ReviewedSelection,
  unknownReason: RoundUnknownReason,
  whenNotVisible?: RoundOrchestrationResult,
): Promise<RoundOrchestrationResult> {
  const found = await (deps.recover ?? recoverSelectionApply)(intent, reviewed, deps);
  if (found.phase === 'applied') {
    // IT REPORTS. IT DOES NOT SEND.
    //
    // `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1`. An earlier attempt under this command may
    // already have mailed some of these people, and nothing durable records that: `invited_at` is
    // written after the provider returns, so an unstamped claim could be either. Draining here
    // would be an AUTOMATIC re-send of a possibly-successful provider call, arbitrarily long after
    // the 24-hour window in which the deterministic idempotency key would have deduped it.
    return {
      phase: 'recovered',
      roundId: found.roundId,
      targetCycleId: found.childCycleIds[0],
      groups: found.childCycleIds.length,
      commandId: found.commandId,
      via: 'ledger',
    };
  }
  // A LEDGER THAT SHOWS NOTHING DOES NOT CONTRADICT THE SERVER'S OWN TYPED REFUSAL, so on the
  // `invalid_request` branch that refusal is still reported verbatim — it came from the core, which
  // refuses before it writes. What the ledger adds there is only the DUPLICATE-INTENT case, which
  // it reports as `found`. It is not being used as proof of absence.
  if (found.phase === 'not_visible' && whenNotVisible) return whenNotVisible;
  return {
    phase: 'unknown',
    reason: unknownReason,
    targetCycleId: null,
    commandId: reviewed.commandId,
    recovery: found.phase === 'not_visible' ? 'not_visible' : 'unreadable',
  };
}
