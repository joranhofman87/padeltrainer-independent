import { supabase } from '@/lib/supabaseClient';

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
  unresolved: number;
  remaining: number;
  failedClaimIds: string[];
  unresolvedClaimIds: string[];
  /** First per-send failure reason from the edge fn (e.g. a Resend rejection), if any. */
  sampleError?: string | null;
}

/** Injectable for tests; production hits the edge function. */
export type ChunkSender = (args: {
  cycleId: string;
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
   *  — a send THREW before any chunk count was learned, so the outstanding count is genuinely unknown
   *  and must NOT be reported as 0 (Codex round-10 #1). */
  leftover: number | null;
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

const defaultSender: ChunkSender = async ({ cycleId, limit, customMessage, customSubject }) => {
  const { data, error } = await supabase.functions.invoke('send-priority-claim-invitation', {
    body: {
      cycleId,
      limit,
      customMessage: customMessage || undefined,
      customSubject: customSubject || undefined,
    },
  });
  if (error || !data) throw error ?? new Error('send_failed');
  return {
    sent: Number(data.sent ?? 0),
    failed: Number(data.failed ?? 0),
    unresolved: Number(data.unresolved ?? 0),
    remaining: Number(data.remaining ?? 0),
    failedClaimIds: Array.isArray(data.failedClaimIds) ? data.failedClaimIds : [],
    unresolvedClaimIds: Array.isArray(data.unresolvedClaimIds) ? data.unresolvedClaimIds : [],
    sampleError: typeof data.sampleError === 'string' ? data.sampleError : null,
  };
};

export interface DrainOptions {
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
  let lastUnresolved = 0;
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
      chunk = await send({ cycleId, limit, customMessage: opts.customMessage, customSubject: opts.customSubject });
    } catch (e) {
      stoppedReason = 'error';
      if (!sampleError) sampleError = e instanceof Error ? e.message : String(e);
      break;
    }
    sawChunk = true;
    totalSent += chunk.sent;
    remaining = chunk.remaining;
    lastFailed = chunk.failed;
    lastUnresolved = chunk.unresolved;
    lastUnresolvedClaimIds = chunk.unresolvedClaimIds;
    if (!sampleError && chunk.sampleError) sampleError = chunk.sampleError;
    // The first chunk reveals the full sendable set (this chunk's attempts + what's
    // left); pin it so a progress bar has a stable, emailless-excluded denominator.
    if (i === 0) total = chunk.sent + chunk.failed + chunk.remaining;
    for (const id of chunk.failedClaimIds) failedClaimIds.add(id);
    opts.onProgress?.({ totalSent, stillToSend: remaining + chunk.failed + chunk.unresolved, total });

    // Fully drained ONLY when nothing remains, nothing failed, AND nothing is unresolved (Codex
    // round-7 #1) — a chunk of sent-but-un-stamped emails is NOT a completed drain.
    if (chunk.remaining === 0 && chunk.failed === 0 && chunk.unresolved === 0) { stoppedReason = 'drained'; break; }
    // Terminal all-unresolved: the emails went out but their stamps didn't land, and nothing else is
    // left. Stop as retryable 'unresolved' instead of looping to re-send (deduped) forever — a later
    // drain re-stamps them. (invited_at stays NULL, so they remain eligible.)
    if (chunk.remaining === 0 && chunk.failed === 0 && chunk.unresolved > 0) { stoppedReason = 'unresolved'; break; }
    // NO forward progress on sending (chunk.sent === 0). We only reach here when work is still
    // outstanding (the drained/unresolved checks above already handled the all-clear cases), so this is
    // ALWAYS a stall, never 'drained' (Codex round-8 #1) — e.g. sent:0 with remaining>0. Failures never
    // stamped invited_at, so a later re-run retries.
    if (chunk.sent === 0) { stoppedReason = 'no_progress'; break; }
  }

  // Honest leftover (Codex round-10 #1): drained ⇒ 0; an error BEFORE any chunk count ⇒ null (UNKNOWN,
  // never a fabricated 0); otherwise the last known outstanding count.
  const leftover: number | null =
    stoppedReason === 'drained' ? 0
    : (stoppedReason === 'error' && !sawChunk) ? null
    : remaining + lastFailed + lastUnresolved;
  return { totalSent, leftover, stoppedReason, failedClaimIds: [...failedClaimIds], unresolvedClaimIds: lastUnresolvedClaimIds, sampleError };
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
  // the round total can't be honestly summed past an unknown (Codex round-10 #1).
  let leftover: number | null = 0;
  const failedClaimIds = new Set<string>();
  const unresolvedClaimIds = new Set<string>();
  // Worst reason wins across the round's cycles (higher rank = worse). 'drained' only survives if
  // EVERY cycle drained cleanly.
  const RANK: Record<DrainResult['stoppedReason'], number> = { drained: 0, unresolved: 1, iteration_limit: 2, no_progress: 3, error: 4 };
  let stoppedReason: DrainResult['stoppedReason'] = 'drained';
  let sampleError: string | null = null;

  for (const cycleId of cycleIds) {
    const before = totalSent;
    const res = await drainRebookInvites(cycleId, {
      ...opts,
      // Rebase this cycle's progress onto the round running total.
      onProgress: opts.onProgress
        ? (p) => opts.onProgress!({ totalSent: before + p.totalSent, stillToSend: p.stillToSend, total: p.total })
        : undefined,
    });
    totalSent += res.totalSent;
    if (res.leftover === null) leftover = null;
    else if (leftover !== null) leftover += res.leftover;
    for (const id of res.failedClaimIds) failedClaimIds.add(id);
    for (const id of res.unresolvedClaimIds) unresolvedClaimIds.add(id);
    if (!sampleError && res.sampleError) sampleError = res.sampleError;
    if (RANK[res.stoppedReason] > RANK[stoppedReason]) stoppedReason = res.stoppedReason;
  }

  return { totalSent, leftover, stoppedReason, failedClaimIds: [...failedClaimIds], unresolvedClaimIds: [...unresolvedClaimIds], sampleError };
}

// ===== Shared create-then-drain orchestration (Codex round-9 #1/#2) =====
//
// BOTH round wizards (RebookCohortWizard, AcademyNewRoundWizard) must create the round WITHOUT sending
// (skipInvites + roundAware) and then drain invites in bounded, resumable chunks — never send inline,
// which at volume leaves a committed round with partially-sent invites and no response to interpret.
// This single helper is that orchestration, so the two wizards cannot diverge.

/** Discriminated outcome: CREATION failed (no round exists) vs the round was CREATED (navigable via
 *  targetCycleId) with a delivery result that may be partial. Clients show partial-delivery recovery
 *  ONLY in the `created` phase. */
export type RoundOrchestrationResult =
  | { phase: 'creation_failed'; reason: string }
  | {
      phase: 'created';
      targetCycleId: string;
      roundId: string | null;
      groups: number;
      players: number;
      totalSent: number;
      /** Invites still not sent OR sent-but-un-stamped (0 ⇒ everything delivered). `null` ⇒ UNKNOWN (a
       *  send threw before any count was learned — Codex round-10 #1); the UI shows a no-numbers copy. */
      leftover: number | null;
      /** 'inline' when a legacy edge sent inline; otherwise the drain's stoppedReason. */
      outcome: DrainResult['stoppedReason'] | 'inline';
      sampleError: string | null;
    };

export interface RoundOrchestrationDeps {
  /** Injected for tests; production passes supabase.functions.invoke. */
  invoke: (fn: string, args: { body: Record<string, unknown> }) => Promise<{ data: unknown; error: unknown }>;
  /** Injected for tests; production uses the real round drain. */
  drain?: typeof drainRebookRoundInvites;
  onProgress?: (p: DrainProgress) => void;
}

export async function createAndDrainRebookRound(
  body: Record<string, unknown>,
  deps: RoundOrchestrationDeps,
): Promise<RoundOrchestrationResult> {
  const { data, error } = await deps.invoke('bulk-rebook-cycle', { body: { ...body, skipInvites: true, roundAware: true } });
  if (error) throw error;
  const d = (data ?? {}) as Record<string, unknown>;

  // Discriminate CREATION failure (no round → no targetCycleId) from a created round with partial
  // delivery. The authoritative signal is a valid targetCycleId; the `phase`/`reason` fields refine it.
  const targetCycleId = typeof d.targetCycleId === 'string' ? d.targetCycleId : null;
  if (!targetCycleId || d.phase === 'creation') {
    return { phase: 'creation_failed', reason: String(d.reason ?? 'unknown') };
  }

  const roundId = typeof d.roundId === 'string' ? d.roundId : null;
  const groups = Number(d.groups ?? 0);
  const players = Number(d.players ?? 0);
  const roundCycleIds: string[] = Array.isArray(d.targetCycles) && d.targetCycles.length > 0
    ? (d.targetCycles as Array<{ id: string }>).map((c) => c.id)
    : [targetCycleId];
  const total = Number(d.representativeCount ?? d.players ?? 0);

  // Deferred (current edge): create-then-drain — bounded + resumable.
  if (d.invitesDeferred === true && roundCycleIds.length > 0 && total > 0) {
    const drainRes = await (deps.drain ?? drainRebookRoundInvites)(roundCycleIds, {
      customMessage: (body.invitationMessage as string | undefined) ?? null,
      customSubject: (body.invitationSubject as string | undefined) ?? null,
      onProgress: deps.onProgress,
    });
    return { phase: 'created', targetCycleId, roundId, groups, players, totalSent: drainRes.totalSent, leftover: drainRes.leftover, outcome: drainRes.stoppedReason, sampleError: drainRes.sampleError ?? null };
  }

  // Inline path (an older edge that ignored skipInvites, or nothing to send): use its own accounting.
  const failed = Number(d.failed ?? (Array.isArray(d.failedClaimIds) ? d.failedClaimIds.length : 0));
  const unresolved = Number(d.unresolved ?? (Array.isArray(d.unresolvedClaimIds) ? d.unresolvedClaimIds.length : 0));
  return { phase: 'created', targetCycleId, roundId, groups, players, totalSent: Number(d.invitesSent ?? 0), leftover: failed + unresolved, outcome: 'inline', sampleError: null };
}
