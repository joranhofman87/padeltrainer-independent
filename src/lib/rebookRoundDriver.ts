/**
 * ABC-27 / D7 — the OPERATOR COMMAND DRIVER.
 *
 * It drives the four-hop protocol against the five `*_as_actor` wrappers and returns a closed
 * result. It holds no policy: every authorization, bound, canonicalization and receipt decision is
 * the database's, and this file's whole job is to speak the protocol correctly and to be honest
 * about what came back.
 *
 * IT CALLS POSTGREST DIRECTLY, AS THE SIGNED-IN OPERATOR, AND IT MUST.
 * `supabase/functions/_shared/auth.ts`'s `requireUser` returns a SERVICE-ROLE client on every path,
 * so inside an edge function `auth.uid()` is NULL — and every wrapper answers its closed `refused`
 * row to a NULL actor. Routing the operator surface through an edge function does not merely add a
 * hop, it makes the surface unusable, and `service_role` holds EXECUTE on none of the five wrappers
 * anyway. The tenant fence is the exact `academy_managers` pair predicate INSIDE each wrapper body,
 * evaluated against the JWT's own subject.
 *
 * WHAT THIS FILE MUST NEVER DO, and each of these is a real failure mode rather than a style rule:
 *
 *   • NEVER pass an actor id. The wrapper derives the actor from the JWT; a parameter would be a
 *     caller-chosen identity and the pair fence would be checking a claim against itself.
 *   • NEVER perform a client-side permission check standing in for that fence. A UI that decides
 *     who may act is a second, weaker authority that the server does not consult.
 *   • NEVER mint a fresh `command_id` to retry. Same UUID + same payload replays the stored
 *     receipt; a fresh one is how one operator action becomes two rounds.
 *   • NEVER infer "created" from an incomplete response. An unreadable row is `unknown`, and
 *     `unknown` is not a failure either — the command may well have applied.
 *   • NEVER guess `occurrence_count`. The PROBE exists precisely so the SERVER says how many
 *     target-slot identities to mint.
 */

import {
  ABC27_WIRE_VERSION,
  type ApplyEligibility,
  type ApplyRow,
  type ApplyStatus,
  type ByteaHex,
  type CommandKind,
  type CommandLookupRow,
  type CommandStatusRow,
  decodeApplyRow,
  decodeCommandLookupRow,
  decodeCommandStatusRow,
  decodePreviewRow,
  decodeSingle,
  isApplySuccess,
  type PreviewRow,
  readCommandReceipt,
  readReviewFingerprint,
  type CommandReceipt,
} from './rebookRoundCommand';

/** A PostgREST RPC call. Injected so every test drives the real driver with a scripted server. */
export interface RoundCommandRpc {
  (name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export interface RoundDriverDeps {
  rpc: RoundCommandRpc;
  /** UUID minting, injected so a test can assert the EXACT identities the driver used. */
  newUuid: () => string;
}

/**
 * The complete typed intent of one round command, in the wrappers' own field order.
 *
 * It is a mirror of the signature and nothing more. The driver interprets none of it — the whole
 * point of the normalized surface is that the SERVER canonicalizes the operator's intent, so a
 * field massaged on the way out would be a second, undeclared authority over what was reviewed.
 */
export interface RoundCommandIntent {
  academyProfileId: string;
  commandKind: CommandKind;
  roundId: string | null;
  expectedVersion: number | null;
  label: string | null;
  targetStart: string | null;
  targetEnd: string | null;
  termWeeks: number | null;
  priorityDays: number | null;
  memberDays: number | null;
  paymentMode: string | null;
  strictMollie: boolean | null;
  publicOpenMode: string | null;
  publicOpenSplit: boolean | null;
  requireAdminReview: boolean | null;
  sessionPrice: number | null;
  autoReminder: boolean | null;
  reminderLeadHours: number | null;
  invitationSubject: string | null;
  invitationBody: string | null;
  reminderSubject: string | null;
  reminderBody: string | null;
  rebookRules: string | null;
  claimInfo: string | null;
  holidayFrom: string[];
  holidayTo: string[];
  holidayLabel: string[];
  sourceSlotIds: string[];
  childCycleIds: string[];
}

/** The wrapper's positional arguments, built once so preview and apply cannot disagree. */
function previewArgs(intent: RoundCommandIntent, targetSlotIds: string[]): Record<string, unknown> {
  return {
    p_academy_profile_id: intent.academyProfileId,
    p_contract_version: ABC27_WIRE_VERSION,
    p_command_kind: intent.commandKind,
    p_round_id: intent.roundId,
    p_expected_version: intent.expectedVersion,
    p_label: intent.label,
    p_target_start: intent.targetStart,
    p_target_end: intent.targetEnd,
    p_term_weeks: intent.termWeeks,
    p_priority_days: intent.priorityDays,
    p_member_days: intent.memberDays,
    p_payment_mode: intent.paymentMode,
    p_strict_mollie: intent.strictMollie,
    p_public_open_mode: intent.publicOpenMode,
    p_public_open_split: intent.publicOpenSplit,
    p_require_admin_review: intent.requireAdminReview,
    p_session_price: intent.sessionPrice,
    p_auto_reminder: intent.autoReminder,
    p_reminder_lead_hours: intent.reminderLeadHours,
    p_invitation_subject: intent.invitationSubject,
    p_invitation_body: intent.invitationBody,
    p_reminder_subject: intent.reminderSubject,
    p_reminder_body: intent.reminderBody,
    p_rebook_rules: intent.rebookRules,
    p_claim_info: intent.claimInfo,
    p_holiday_from: intent.holidayFrom,
    p_holiday_to: intent.holidayTo,
    p_holiday_label: intent.holidayLabel,
    p_source_slot_ids: intent.sourceSlotIds,
    p_child_cycle_ids: intent.childCycleIds,
    p_target_slot_ids: targetSlotIds,
  };
}

/** Why the driver could not read what the server said. Never conflated with a server answer. */
export type RoundUnknownReason =
  | 'transport_error'
  | 'unreadable_probe'
  | 'unreadable_preview'
  | 'unreadable_apply'
  | 'unreadable_lookup'
  /** The probe answered something other than the expected `invalid_request`-with-a-count. */
  | 'probe_not_understood'
  /** A `previewed` row arrived without a well-formed 32-octet fingerprint. */
  | 'review_fingerprint_unreadable';

/**
 * THE REVIEW an operator approves, and the exact thing an apply must be given back.
 *
 * `commandId` and `targetSlotIds` are minted ONCE, during preview, and carried here. An apply that
 * re-mints either of them is applying a different command than the one that was reviewed.
 */
export interface RoundReview {
  intent: RoundCommandIntent;
  commandId: string;
  targetSlotIds: string[];
  reviewFingerprint: ByteaHex;
  applyEligibility: ApplyEligibility;
  preview: PreviewRow;
}

export type PreviewResult =
  | { phase: 'reviewed'; review: RoundReview }
  /** The server answered a CLOSED refusal. `status` names which; nothing was written. */
  | { phase: 'refused'; status: Exclude<PreviewStatusOrRefused, 'previewed'>; preview: PreviewRow | null }
  | { phase: 'unknown'; reason: RoundUnknownReason };

type PreviewStatusOrRefused = PreviewRow['status'];

export type ApplyResult =
  /** The round exists as reviewed. `replayed` is a SUCCESS: it is the stored receipt of the same command. */
  | { phase: 'applied'; status: 'applied' | 'replayed'; row: ApplyRow }
  | { phase: 'refused'; status: ApplyStatus; row: ApplyRow }
  | { phase: 'unknown'; reason: RoundUnknownReason; commandId: string };

export type RecoverResult =
  | {
      phase: 'found';
      row: CommandStatusRow | CommandLookupRow;
      /**
       * THE VERIFIED RECEIPT, when the row carried one that checked out.
       *
       * D7 TERMINAL CLOSURE. The row's bytes were only ever passed through before: nothing
       * confirmed they hashed to their own digest, and nothing parsed them into the child cycle
       * ids a caller needs to finish the send. The table's CHECK constraints make the stored
       * relationship unbreakable, so this is not distrust of the database — it is that the bytes
       * reach us over a transport, and a receipt that arrived corrupted would otherwise be turned
       * into confident, wrong child ids and drained against.
       *
       * `null` when the row could not be verified. A caller must treat that as "could not decide",
       * never as "found".
       */
      receipt: CommandReceipt | null;
    }
  | { phase: 'not_found' }
  | { phase: 'unknown'; reason: RoundUnknownReason };

/**
 * HOP 1+2+3 — probe, mint, preview.
 *
 * The probe submits an EMPTY target-slot pool, which the preview core refuses as `invalid_request`
 * while still reporting the `occurrence_count` it derived. That count is the number of identities
 * the caller must mint, and taking it from the server is what stops the browser from deriving
 * occurrences itself out of dates and holidays — a second, divergent generator over the operator's
 * intent.
 */
export async function previewRebookRoundCommand(
  intent: RoundCommandIntent,
  deps: RoundDriverDeps,
): Promise<PreviewResult> {
  // ── PROBE. Zero writes: the preview core is STABLE. ────────────────────────────────────────
  const probe = await callPreview(intent, [], deps);
  if (probe.kind === 'unknown') return { phase: 'unknown', reason: probe.reason };
  const probed = probe.row;

  if (probed.status === 'previewed') {
    // A `previewed` answer to an EMPTY identity pool would mean the server accepted a round with
    // zero occurrences. Nothing downstream is safe to build on that, so it is not "understood".
    return { phase: 'unknown', reason: 'probe_not_understood' };
  }
  if (probed.status !== 'invalid_request' || probed.occurrenceCount <= 0) {
    // Any other refusal is a REAL refusal of the operator's intent, reported as it stands. The
    // probe is not retried and nothing is minted: there is nothing to mint identities for.
    return { phase: 'refused', status: probed.status, preview: probed };
  }

  // ── MINT. Exactly `occurrence_count` target identities, plus ONE command identity. ─────────
  const targetSlotIds = Array.from({ length: probed.occurrenceCount }, () => deps.newUuid());
  const commandId = deps.newUuid();

  // ── PREVIEW. The same intent, now carrying the identities the server asked for. ────────────
  const previewed = await callPreview(intent, targetSlotIds, deps);
  if (previewed.kind === 'unknown') return { phase: 'unknown', reason: previewed.reason };
  const row = previewed.row;
  if (row.status !== 'previewed') return { phase: 'refused', status: row.status, preview: row };

  const fingerprint = readReviewFingerprint(row.reviewFingerprint);
  if (fingerprint === null || row.applyEligibility === null) {
    return { phase: 'unknown', reason: 'review_fingerprint_unreadable' };
  }
  return {
    phase: 'reviewed',
    review: {
      intent,
      commandId,
      targetSlotIds,
      reviewFingerprint: fingerprint,
      applyEligibility: row.applyEligibility,
      preview: row,
    },
  };
}

type PreviewCall = { kind: 'row'; row: PreviewRow } | { kind: 'unknown'; reason: RoundUnknownReason };

async function callPreview(
  intent: RoundCommandIntent,
  targetSlotIds: string[],
  deps: RoundDriverDeps,
): Promise<PreviewCall> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await deps.rpc('rebook_round_preview_command_as_actor',
      previewArgs(intent, targetSlotIds)));
  } catch {
    // A THROW IS A RESULT, NOT AN EXCEPTION TO HAND UPWARD — but the preview is STABLE and writes
    // nothing, so unlike an apply there is nothing that could have half-happened.
    return { kind: 'unknown', reason: 'transport_error' };
  }
  if (error) return { kind: 'unknown', reason: 'transport_error' };
  const row = decodeSingle(data, decodePreviewRow);
  if (row === null) {
    return { kind: 'unknown', reason: targetSlotIds.length === 0 ? 'unreadable_probe' : 'unreadable_preview' };
  }
  return { kind: 'row', row };
}

/**
 * HOP 4 — apply the reviewed command.
 *
 * IT TAKES THE REVIEW, NOT AN INTENT. That is the whole guarantee: the arguments, the minted
 * identities, the command UUID and the fingerprint are the ones the operator approved. Re-deriving
 * any of them here would apply something that was never reviewed and the server would say so
 * (`source_drift`), which is a message about the operator's sources for a defect in this file.
 *
 * RETRY BY CALLING THIS AGAIN WITH THE SAME REVIEW. It is idempotent by the command UUID: the
 * second call returns `replayed` with the stored receipt.
 */
export async function applyRebookRoundCommand(
  review: RoundReview,
  deps: RoundDriverDeps,
): Promise<ApplyResult> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await deps.rpc('rebook_round_apply_command_as_actor', {
      ...previewArgs(review.intent, review.targetSlotIds),
      p_command_id: review.commandId,
      p_review_fingerprint: review.reviewFingerprint,
    }));
  } catch {
    // THE COMMAND MAY HAVE APPLIED. A transport failure says nothing about the server's state, so
    // this is `unknown` and it carries the command id — which is the ONLY thing that can resolve
    // it, through `recoverRebookRoundCommand`.
    return { phase: 'unknown', reason: 'transport_error', commandId: review.commandId };
  }
  if (error) return { phase: 'unknown', reason: 'transport_error', commandId: review.commandId };
  const row = decodeSingle(data, decodeApplyRow);
  if (row === null) {
    return { phase: 'unknown', reason: 'unreadable_apply', commandId: review.commandId };
  }
  if (isApplySuccess(row.status)) {
    return { phase: 'applied', status: row.status as 'applied' | 'replayed', row };
  }
  return { phase: 'refused', status: row.status, row };
}

/**
 * RECOVERY — what to do about an `unknown`.
 *
 * Two actor-scoped surfaces, in preference order: by the command UUID the browser still holds, and
 * failing that by the reviewed fingerprint, which survives a lost UUID. Neither is a general read:
 * both are scoped to the calling actor inside the core, so a manager cannot recover a peer's
 * receipt.
 *
 * IT IS NEVER A RE-APPLY. Recovery reads; if the command applied it says so, and if it did not the
 * caller may apply again WITH THE SAME REVIEW.
 */
export async function recoverRebookRoundCommand(
  review: {
    intent: Pick<RoundCommandIntent, 'academyProfileId'>;
    commandId: string;
    reviewFingerprint: string;
  },
  // `newUuid` is deliberately NOT required: recovery reads a decision and can never mint one, and a
  // signature that asked for a UUID minter would suggest otherwise.
  deps: { rpc: RoundCommandRpc },
): Promise<RecoverResult> {
  const byId = await lookup(
    'rebook_round_command_status_as_actor',
    { p_academy_profile_id: review.intent.academyProfileId, p_command_id: review.commandId },
    decodeCommandStatusRow, deps, review.commandId,
  );
  if (byId.phase !== 'not_found') return byId;
  return lookup(
    'rebook_round_command_lookup_by_review_as_actor',
    {
      p_academy_profile_id: review.intent.academyProfileId,
      p_contract_version: ABC27_WIRE_VERSION,
      p_review_fingerprint: review.reviewFingerprint,
    },
    decodeCommandLookupRow, deps, null,
  );
}

async function lookup<T extends CommandStatusRow>(
  fn: string,
  args: Record<string, unknown>,
  decode: (row: unknown) => T | null,
  deps: { rpc: RoundCommandRpc },
  expectCommandId: string | null,
): Promise<RecoverResult> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await deps.rpc(fn, args));
  } catch {
    return { phase: 'unknown', reason: 'transport_error' };
  }
  if (error) return { phase: 'unknown', reason: 'transport_error' };
  const row = decodeSingle(data, decode);
  if (row === null) return { phase: 'unknown', reason: 'unreadable_lookup' };
  // `refused` here means "no such command FOR THIS ACTOR" — and it is the SAME row a wrong academy
  // produces, deliberately, so the surface cannot be used to probe for other people's commands.
  if (row.status !== 'found') return { phase: 'not_found' };

  // The status surface was ASKED for a command id and does not echo it; the lookup surface returns
  // the one it found. Neither is inferred.
  const found: CommandLookupRow | null = 'commandId' in row ? row as CommandLookupRow : null;
  const commandId: string | null = found?.commandId ?? expectCommandId;
  const receipt = row.roundId && commandId && row.receiptCanonical && row.receiptDigest
    ? await readCommandReceipt(row.receiptCanonical, row.receiptDigest,
      { roundId: row.roundId, commandId })
    : null;
  return { phase: 'found', row, receipt };
}
