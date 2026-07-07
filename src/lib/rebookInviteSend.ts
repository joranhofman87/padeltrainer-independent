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
  remaining: number;
  failedClaimIds: string[];
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
  /** Representative invites still not sent (0 ⇒ fully drained). */
  leftover: number;
  stoppedReason: 'drained' | 'no_progress' | 'error';
  failedClaimIds: string[];
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
    remaining: Number(data.remaining ?? 0),
    failedClaimIds: Array.isArray(data.failedClaimIds) ? data.failedClaimIds : [],
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
  let total = 0; // sendable total, learned from the first chunk
  const failedClaimIds = new Set<string>();
  let stoppedReason: DrainResult['stoppedReason'] = 'drained';

  for (let i = 0; i < maxIterations; i++) {
    let chunk: SendChunkResult;
    try {
      chunk = await send({ cycleId, limit, customMessage: opts.customMessage, customSubject: opts.customSubject });
    } catch {
      stoppedReason = 'error';
      break;
    }
    totalSent += chunk.sent;
    remaining = chunk.remaining;
    lastFailed = chunk.failed;
    // The first chunk reveals the full sendable set (this chunk's attempts + what's
    // left); pin it so a progress bar has a stable, emailless-excluded denominator.
    if (i === 0) total = chunk.sent + chunk.failed + chunk.remaining;
    for (const id of chunk.failedClaimIds) failedClaimIds.add(id);
    opts.onProgress?.({ totalSent, stillToSend: remaining + chunk.failed, total });

    // Fully drained: nothing left and this chunk had no failures.
    if (chunk.remaining === 0 && chunk.failed === 0) { stoppedReason = 'drained'; break; }
    // No forward progress (a whole chunk failed, or nothing was eligible) — stop
    // instead of looping. Failures rolled invited_at back, so a later re-run retries.
    if (chunk.sent === 0) { stoppedReason = chunk.failed > 0 ? 'no_progress' : 'drained'; break; }
  }

  const leftover = stoppedReason === 'drained' ? 0 : remaining + lastFailed;
  return { totalSent, leftover, stoppedReason, failedClaimIds: [...failedClaimIds] };
}
