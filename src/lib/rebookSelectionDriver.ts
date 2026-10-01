// The browser's side of the D7 selection surface.
//
// WHAT THIS REPLACES. Both rebook wizards used to POST a body to `bulk-rebook-cycle`, which decided
// which slots the selection meant, clustered them into weekly series, named the children and
// created the round. That decision now lives in the database — one clusterer, two candidate modes —
// and this module is the only place the browser talks to it.
//
// THE BROWSER NEVER HOLDS A SOURCE SLOT ARRAY. It sends a source cycle id, or locations plus a
// term-end week; a set of exclusion keys it received from the server; and the selection digest the
// server issued. It receives counts, a per-series checklist, a roster and — on `review` — the
// fingerprint that is the only thing an apply will accept. It never learns which slots those are,
// and it could not reconstruct them: the derivation bridges are granted to no client role.
//
// ── WHY THE LEGACY RESPONSE SHAPE IS REBUILT HERE ───────────────────────────────────────────
//
// The wizards' review screens are built from the legacy dry run's fields — `groups`, `players`,
// `groupsDetail`, `noEmailTotal`, `grandInvoiceTotal`, `targetCycles`. Rewriting both wizards to
// consume row-kind tuples would have made this change a UI change as well as an authority change,
// and the two would have to be reviewed together. So the mapping lives here, in one function, and
// the wizards keep the shape they already display.

import type { RebookGroupDetail, RebookRosterEntry } from '@/components/cycles/RebookReviewTable';
import {
  readReviewFingerprint,
  ROUND_COMMAND_STATUSES,
  WRAPPER_REFUSED,
} from '@/lib/rebookRoundCommand';
import { recoverRebookRoundCommand } from '@/lib/rebookRoundDriver';

/** Injected so tests drive the same code production does. Production passes `supabase.rpc`. */
export interface SelectionRpc {
  (fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export type SelectionProjection = 'counts' | 'review';

/** Why a selection call could not be believed. Structured — copy and tests key on a value. */
export type SelectionFailure =
  /** The transport failed, or the RPC returned an error with no readable answer. */
  | 'transport_error'
  /** An answer arrived but was not the shape this contract describes. */
  | 'unreadable_response'
  /** The caller is not a manager of this academy, or spoke outside a closed vocabulary. */
  | 'refused'
  /** The selection moved under an echoed digest: the operator has not seen what would be created. */
  | 'selection_moved';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null);
/** A validated uuid, or null. Never coerces, never accepts a non-string. */
const asUuid = (v: unknown): string | null =>
  (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null);
/** A safe non-negative integer. `Number(...)` is deliberately never used. */
const asCount = (v: unknown): number =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const asOptionalNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // PostgREST renders `numeric` as a JSON string to preserve exactness.
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const asText = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A non-negative exact integer, or NULL for anything else — never a silent zero. */
const asExactCount = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * The typed intent, as the wizards' opaque body describes it.
 *
 * BUILT ONCE AND RE-SENT VERBATIM. The wizards already hold their request as a single record and
 * re-send exactly what the operator reviewed; this keeps that property by deriving every RPC
 * argument from that record rather than from live form state.
 */
export interface SelectionIntent {
  academyProfileId: string;
  mode: 'source_cycle' | 'cohort';
  commandKind: 'create' | 'extend';
  sourceCyclusId: string | null;
  locationIds: string[] | null;
  termEndDate: string | null;
  excludedSeriesKeys: string[];
  selectionDigest: string | null;
  roundId: string;
  expectedVersion: number | null;
  label: string;
  targetStart: string;
  targetEnd: string | null;
  termWeeks: number | null;
  priorityDays: number;
  memberDays: number;
  paymentMode: string;
  strictMollie: boolean;
  publicOpenMode: string;
  publicOpenSplit: boolean;
  requireAdminReview: boolean;
  sessionPrice: number | null;
  autoReminder: boolean;
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
}

/**
 * Map a wizard body onto the typed intent.
 *
 * THE ROUND UUID AND THE DIGEST ARE ARGUMENTS, NOT BODY FIELDS, and that is load-bearing. Both
 * wizards derive a `revision` from their body and block the send whenever it no longer matches the
 * live form — so a digest folded into the body would change the revision on every server answer,
 * invalidate the review it had just produced, and re-ask forever. They are session facts about the
 * conversation, not part of what the operator chose.
 *
 * Returns null when the body cannot describe a round at all, rather than sending a call that could
 * only be refused.
 */
export function selectionIntentFromBody(
  body: Record<string, unknown>,
  session: { roundId: string; selectionDigest?: string | null },
): SelectionIntent | null {
  const academyProfileId = asUuid(body.academyProfileId);
  const roundId = asUuid(session.roundId);
  if (!academyProfileId || !roundId) return null;

  const sourceCyclusId = asUuid(body.sourceCyclusId);
  const locationIds = Array.isArray(body.locationIds)
    ? body.locationIds.map(asUuid).filter((x): x is string => x !== null)
    : [];
  const extendRoundId = asUuid(body.extendRoundId);
  const holidays = Array.isArray(body.holidays) ? body.holidays.map(asRecord) : [];
  const kept = holidays.filter((h): h is Record<string, unknown> =>
    h !== null && typeof h.from === 'string' && typeof h.to === 'string');

  return {
    academyProfileId,
    mode: sourceCyclusId ? 'source_cycle' : 'cohort',
    // AN EXTEND IS THE ROUND ITSELF. The typed core reuses the round's stored policy under a
    // mandatory version fence, and the derivation reads the same id — one identity, so the two
    // cannot disagree about which groups are already in the round.
    commandKind: extendRoundId ? 'extend' : 'create',
    sourceCyclusId,
    locationIds: locationIds.length > 0 ? locationIds : null,
    termEndDate: asText(body.termEndDate),
    excludedSeriesKeys: Array.isArray(body.excludedSeriesKeys)
      ? body.excludedSeriesKeys.filter((x): x is string => typeof x === 'string')
      : [],
    selectionDigest: asText(session.selectionDigest ?? null),
    // An extend applies to the EXISTING round; a create mints its own id up front.
    roundId: extendRoundId ?? roundId,
    expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : null,
    label: asText(body.targetCycleName) ?? '',
    targetStart: asText(body.newStartDate) ?? '',
    // EXACTLY ONE LENGTH FORM REACHES THE SERVER, and the server derives neither. An end date wins
    // when the operator gave one; otherwise the week count does. Sending both is a refusal, and
    // sending neither is also a refusal — which is the point: the manager states the length.
    targetEnd: asText(body.newEndDate),
    termWeeks: asText(body.newEndDate) ? null : (typeof body.weeks === 'number' ? body.weeks : null),
    priorityDays: asCount(body.priorityWindowDays),
    memberDays: asCount(body.memberWindowDays),
    paymentMode: asText(body.paymentMode) ?? 'deferred_split',
    strictMollie: body.strictMollie === true,
    // 'inherit' is a NAMED member of the closed vocabulary — "copy each source court's own flags" —
    // not an absence. The legacy body sends null for it, which the typed core refuses.
    publicOpenMode: asText(body.publicOpenMode) ?? 'inherit',
    publicOpenSplit: body.publicOpenSplit === true,
    requireAdminReview: body.requireAdminReview === true,
    sessionPrice: asOptionalNumber(body.sessionPrice),
    autoReminder: body.autoReminder !== false,
    reminderLeadHours: typeof body.reminderLeadHours === 'number' ? body.reminderLeadHours : null,
    invitationSubject: asText(body.invitationSubject),
    invitationBody: asText(body.invitationMessage),
    reminderSubject: asText(body.reminderSubject),
    reminderBody: asText(body.reminderMessage),
    rebookRules: asText(body.rebookRules),
    claimInfo: asText(body.claimInfo),
    holidayFrom: kept.map((h) => h.from as string),
    holidayTo: kept.map((h) => h.to as string),
    holidayLabel: kept.map((h) => (typeof h.name === 'string' ? h.name : '')),
  };
}

function previewArgs(
  intent: SelectionIntent, projection: SelectionProjection, targetSlotIds: string[],
): Record<string, unknown> {
  return {
    p_academy_profile_id: intent.academyProfileId,
    p_contract_version: 'abc27.wire.v1',
    p_command_kind: intent.commandKind,
    p_selection_mode: intent.mode,
    p_projection: projection,
    p_source_cycle_id: intent.sourceCyclusId,
    p_location_ids: intent.locationIds,
    p_term_end: intent.termEndDate,
    p_excluded_series_keys: intent.excludedSeriesKeys,
    p_selection_digest: intent.selectionDigest,
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
    p_target_slot_ids: targetSlotIds,
  };
}

/** The decoded answer: the result row, the per-series checklist, and (on review) the roster. */
export interface SelectionAnswer {
  status: string;
  selectionDigest: string | null;
  reviewFingerprint: string | null;
  /**
   * The core's own verdict on whether this reviewed intent may be APPLIED.
   *
   * REVIEW ROUND 1 (P1): THIS WAS BEING DROPPED. A `previewed` status means the intent was judged
   * and fingerprinted; it does NOT mean it can be applied. ABC-27 marks any non-null session price
   * `refused_session_price` here and then refuses it at apply, so discarding this field armed a
   * send that could only ever fail.
   */
  applyEligibility: string | null;
  occurrenceCount: number;
  /** The legacy dry-run shape the wizards already render. */
  legacy: Record<string, unknown>;
}

export type SelectionResult =
  | { phase: 'answered'; answer: SelectionAnswer }
  | { phase: 'failed'; reason: SelectionFailure }
  | { phase: 'aborted' };

/**
 * Ask the selection surface, and rebuild the shape the wizards display.
 *
 * A REFUSAL IS A RESULT, NOT AN EXCEPTION. The surface answers every failure with one closed row,
 * so this never throws for a server outcome and never infers absence from an incomplete body.
 */
export async function askSelection(
  intent: SelectionIntent,
  projection: SelectionProjection,
  targetSlotIds: string[],
  deps: { rpc: SelectionRpc; signal?: AbortSignal },
): Promise<SelectionResult> {
  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await deps.rpc('rebook_round_selection_preview_as_actor',
      previewArgs(intent, projection, targetSlotIds)));
  } catch {
    if (deps.signal?.aborted) return { phase: 'aborted' };
    return { phase: 'failed', reason: 'transport_error' };
  }
  if (deps.signal?.aborted) return { phase: 'aborted' };
  if (error) return { phase: 'failed', reason: 'transport_error' };
  if (!Array.isArray(data)) return { phase: 'failed', reason: 'unreadable_response' };

  const rows = data.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
  const result = rows.find((r) => r.row_kind === 'result');
  if (!result) return { phase: 'failed', reason: 'unreadable_response' };
  const status = asText(result.status);
  if (status === 'refused') return { phase: 'failed', reason: 'refused' };
  if (status === 'selection_moved') return { phase: 'failed', reason: 'selection_moved' };
  if (status === null) return { phase: 'failed', reason: 'unreadable_response' };

  const series = rows.filter((r) => r.row_kind === 'series');
  const roster = rows.filter((r) => r.row_kind === 'roster');

  // THE ROWSET MUST AGREE WITH ITS OWN RESULT ROW.
  //
  // REVIEW ROUND 4 (P1): PostgREST caps rows, and the hosted cap is not pinned anywhere in this
  // repository. Five groups of two hundred players is over a thousand rows, so a truncated answer
  // arrives looking perfectly well formed — a shorter roster, the same result row — and the send
  // stays armed while the apply creates claims for everyone. The result row states how many
  // children and how many distinct subjects it counted; if the rows do not add up to that, this is
  // not the answer it claims to be.
  const statedChildren = asCount(result.child_count);
  const includedSeries = series.filter((x) => x.series_excluded !== true);
  if (statedChildren !== includedSeries.length) {
    return { phase: 'failed', reason: 'unreadable_response' };
  }
  // REVIEW ROUND 5 (P1): ROUND 4 COUNTED THE WRONG THING, IN BOTH DIRECTIONS.
  //
  // It compared DISTINCT `(series_key, display_name)` against the stated subject counts. But the
  // server counts recipient KEYS (`..._actor_surface.sql:586`) and emits exactly one roster row per
  // key (`:608`) — and two people are allowed to share a name. Two "Jan de Vries" in one group, or
  // two players carrying no name at all and each rendered `--` by the server, collapsed into a
  // single set entry, and the answer was refused. A legitimate cohort became unsendable in both
  // wizards. The roster carries no identifier whatsoever, by design, so a NAME IS NOT AN IDENTITY
  // and the only honest completeness measure is the ROW COUNT.
  //
  // Round 4 also skipped the check entirely when the roster was empty -- precisely the shape a row
  // cap is most likely to produce, since the result row and the series rows come first and are
  // few. Every roster row is cut, `child_count` still agrees, and the operator arms a send having
  // been shown nobody at all. A `review` always carries its roster, so an empty one is not a valid
  // answer to it.
  if (projection === 'review') {
    const perSeriesTotal = series.reduce((n, x) => n + asCount(x.subject_count), 0);
    if (roster.length !== perSeriesTotal) {
      return { phase: 'failed', reason: 'unreadable_response' };
    }
    // THE HEADLINE COUNT MUST BE POSSIBLE.
    //
    // REVIEW ROUND 5 (P2): `cohort_total` was copied straight into the displayed headcount with no
    // check that it can coexist with the per-series counts beside it. It counts a person once
    // across the INCLUDED series (`..._actor_surface.sql:507`), which bounds it from both sides: it
    // cannot exceed the summed subjects of those series, and it cannot be smaller than the largest
    // single one. An answer claiming five people beside one subject is not a projection this
    // surface can produce — and the round-4 fixture asserted exactly that shape, so the review
    // tests were normalising a response the server cannot send.
    const includedSubjects = includedSeries.map((x) => asCount(x.subject_count));
    const includedSum = includedSubjects.reduce((n, x) => n + x, 0);
    const includedMax = includedSubjects.reduce((n, x) => Math.max(n, x), 0);
    const statedPeople = asCount(result.cohort_total);
    if (statedPeople > includedSum || statedPeople < includedMax) {
      return { phase: 'failed', reason: 'unreadable_response' };
    }
    const rosterPerSeries = new Map<string, number>();
    for (const r of roster) {
      const key = asText(r.series_key);
      if (key === null) return { phase: 'failed', reason: 'unreadable_response' };
      rosterPerSeries.set(key, (rosterPerSeries.get(key) ?? 0) + 1);
    }
    // ── AND THE CONTACT FACTS MUST AGREE WITH THEMSELVES ────────────────────────────────────
    //
    // REVIEW ROUND 1 (P2) OF THE CLOSURE. This wrapper is VOLATILE under READ COMMITTED and issues
    // its reads as SEPARATE statements, so the result totals, the per-series counts and the roster
    // each take their own snapshot — the same property the digest exists to fail closed against.
    // An address added between two of those statements yields an answer that contradicts itself:
    // `no_email_total = 1`, a series reporting `no_email_count = 0`, and a roster in which every
    // row is reachable. The operator is then asked to acknowledge an unreachable player the list
    // does not contain, or — worse in the other direction — is not asked at all while one is shown.
    //
    // Cardinality alone could not see this, so it is checked too. An answer that disagrees with
    // itself is not a shorter answer; it is one that was never true at any single instant.
    const unreachablePerSeries = new Map<string, number>();
    for (const r of roster) {
      if (r.has_email === true) continue;
      const key = asText(r.series_key);
      if (key === null) return { phase: 'failed', reason: 'unreadable_response' };
      unreachablePerSeries.set(key, (unreachablePerSeries.get(key) ?? 0) + 1);
    }
    let includedUnreachable = 0;
    for (const s of series) {
      const key = asText(s.series_key);
      if (key === null) return { phase: 'failed', reason: 'unreadable_response' };
      if ((rosterPerSeries.get(key) ?? 0) !== asCount(s.subject_count)) {
        return { phase: 'failed', reason: 'unreadable_response' };
      }
      if ((unreachablePerSeries.get(key) ?? 0) !== asCount(s.no_email_count)) {
        return { phase: 'failed', reason: 'unreadable_response' };
      }
      if (s.series_excluded !== true) includedUnreachable += asCount(s.no_email_count);
    }
    // The result row's own total is over the INCLUDED series, exactly as the per-series counts are.
    if (asCount(result.no_email_total) !== includedUnreachable) {
      return { phase: 'failed', reason: 'unreadable_response' };
    }
  }
  // A DROPPED ROW WOULD DEFEAT THE COUNT ABOVE. Reconciliation counts rows; this renders them. If
  // it silently skipped a row it could not read, the operator would be shown fewer people than the
  // count they just agreed with -- the same divergence, one layer further down. The server always
  // renders a name (it substitutes a placeholder for a blank one), so an unreadable row here is a
  // malformed answer, not a nameless player.
  const rosterByKey = new Map<string, RebookRosterEntry[]>();
  for (const r of roster) {
    const key = asText(r.series_key);
    const name = asText(r.display_name);
    if (key === null || name === null) return { phase: 'failed', reason: 'unreadable_response' };
    rosterByKey.set(key, [...(rosterByKey.get(key) ?? []), { name, hasEmail: r.has_email === true }]);
  }

  const groupsDetail: RebookGroupDetail[] = series.map((s) => ({
    // The weekday and time an operator reads come from the SERVER's rendering of the academy's own
    // timezone — the browser never re-derives them from a UTC instant it was not given.
    weekday: weekdayLabel(s.local_weekday),
    time: timeLabel(s.local_time),
    players: asCount(s.subject_count),
    sessions: asCount(s.sessions),
    locationId: asUuid(s.location_id),
    trainerId: asUuid(s.trainer_id),
    trainerName: asText(s.trainer_name),
    sourceSeriesKey: asText(s.series_key) ?? undefined,
    // REVIEW ROUND 5 (P2): THE PRICE AND THE TOTAL IN ONE ROW MUST BE THE SAME PRICE. The server
    // computes `invoice_total` from `coalesce(p_session_price, template)` (`:588`) but reports
    // `source_price` as the template, so a typed override produced a row whose stated price did
    // not multiply out to its own stated total. The override is what the round would be written
    // with, so it is what the row states.
    pricePerSession: intent.sessionPrice ?? asOptionalNumber(s.source_price),
    splitPayment: s.split_payment === true,
    invoiceTotal: asOptionalNumber(s.invoice_total),
    noEmailCount: asCount(s.no_email_count),
    roster: rosterByKey.get(asText(s.series_key) ?? '') ?? [],
  }));
  const included = series.filter((s) => s.series_excluded !== true);

  return {
    phase: 'answered',
    answer: {
      status,
      selectionDigest: asText(result.selection_digest),
      reviewFingerprint: asText(result.review_fingerprint),
      applyEligibility: asText(result.apply_eligibility),
      occurrenceCount: asCount(result.occurrence_count),
      legacy: {
        groups: included.length,
        players: asCount(result.cohort_total),
        totalSessions: asCount(result.total_sessions),
        noEmailTotal: asCount(result.no_email_total),
        // THE NUMBER OF INVITATIONS THIS SEND ACTUALLY AUTHORIZES.
        //
        // REVIEW ROUND 5 (P1): both wizards were computing this as `cohort_total - no_email_total`,
        // and those two quantities are not commensurable. `cohort_total` counts a person ONCE
        // across the whole round (`..._actor_surface.sql:507`); `no_email_total` SUMS the per-series
        // counts (`:513`). The drain, meanwhile, sends per CHILD CYCLE, and the sender picks one
        // recipient per (series, player). So a player who books two of the included groups is one
        // in the headcount and two in the mail queue: the button offered to "send 1 invitation"
        // and sent two. Summing the per-series difference is the quantity the drain will actually
        // produce, and it is taken over the SERVER's included set, never the browser's toggle.
        // For an EXTEND: the round's current version, which the apply must echo as its premise.
        // Nothing else may supply it — no client role can read `rebook_rounds`.
        roundVersion: asExactCount(result.round_version),
        // WHEN THE CONTACT SNAPSHOT WAS TAKEN. Shown to the operator, never used as authority.
        rosterAsOf: asText(result.roster_as_of),
        emailInvitationTotal: included.reduce(
          (n, s) => n + Math.max(0, asCount(s.subject_count) - asCount(s.no_email_count)), 0),
        grandInvoiceTotal: asOptionalNumber(result.grand_invoice_total) ?? 0,
        alreadySentGroups: asCount(result.already_sent_groups),
        // THE SOURCE TERM RECOMMENDATION, and nothing more. It describes the term that ran; the
        // wizard may offer it as a default, and the server still refuses an intent that carries no
        // explicit length.
        suggestedWeeks: asCount(result.source_term_weeks),
        suggestedPrice: asOptionalNumber(result.source_modal_price),
        pricesIncludeVat: typeof result.source_prices_include_vat === 'boolean'
          ? result.source_prices_include_vat : null,
        effWeeks: asCount(result.source_term_weeks),
        groupsDetail,
        targetCycles: included.map((s) => ({
          name: asText(s.target_name) ?? '',
          sourceSeriesKey: asText(s.series_key) ?? '',
          players: asCount(s.subject_count),
          sessions: asCount(s.sessions),
        })),
      },
    },
  };
}

/** The Dutch weekday abbreviation the server's own naming chain uses, for the review table. */
function weekdayLabel(v: unknown): string {
  const days = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
  return typeof v === 'number' && v >= 0 && v <= 6 ? days[v] : '—';
}

/** `time` arrives as `HH:MM:SS`; the review shows `HH:MM`. */
function timeLabel(v: unknown): string {
  return typeof v === 'string' && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : '—';
}

/**
 * A v4 uuid, in every context the app actually runs in.
 *
 * `crypto.randomUUID` IS NOT ALWAYS THERE. It requires a secure context, so it is undefined on a
 * plain-HTTP staging host and in jsdom — and both wizards mint their round id at MOUNT, which would
 * have made the whole page throw rather than degrade. `getRandomValues` has no such restriction, so
 * the fallback sets the version and variant nibbles by hand and produces the same shape.
 *
 * `Math.random()` is deliberately NOT a further fallback: a round id collision is a round created
 * on top of another round's children, and an environment with no CSPRNG at all should fail loudly.
 */
export function newSelectionUuid(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;   // version 4
  b[8] = (b[8] & 0x3f) | 0x80;   // variant 10xx
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The apply answers that PROVE nothing was written.
 *
 * REVIEW ROUND 3 (P2): THIS IS DERIVED FROM THE SHIPPED VOCABULARY, NOT HAND-WRITTEN. The previous
 * list was invented here and was wrong in both directions — it omitted `incoherent_source`,
 * `review_fingerprint_mismatch`, `round_closed`, `child_already_in_round` and five more real
 * zero-write refusals (each reported as "may have committed"), and it admitted `version_conflict`
 * and `lifecycle_conflict`, which the frozen core never emits at all. `ROUND_COMMAND_STATUSES` is
 * the closed vocabulary the core, the command contract and the driver already share; anything
 * outside it is DRIFT, and drift is `unknown`.
 *
 * THE THREE COMMAND-IDENTITY MISMATCHES ARE DELIBERATELY EXCLUDED. `command_payload_mismatch`,
 * `command_kind_mismatch` and `command_tenant_mismatch` say the stored command differs from the one
 * presented — which, when WE presented our own command uuid and our own fingerprint, is evidence
 * that a command under that uuid ALREADY COMMITTED, not evidence that nothing did. Round 3 showed
 * the concrete path: a retry after a lost response re-derives the selection, the just-created
 * children change what the derivation produces, the arrays no longer match the stored ones, and the
 * core answers `command_payload_mismatch` about a round that demonstrably exists. Reading that as
 * "nothing was written" would invite a second attempt at a round that is already there.
 */
const APPLY_NO_WRITE_PROOF: ReadonlySet<string> = new Set(
  ROUND_COMMAND_STATUSES.filter((x) => x !== 'applied' && x !== 'replayed'
    && x !== 'command_payload_mismatch' && x !== 'command_kind_mismatch'
    && x !== 'command_tenant_mismatch') as readonly string[],
).add(WRAPPER_REFUSED).add('selection_moved');

export interface SelectionApplyDeps { rpc: SelectionRpc; newUuid: () => string }

/**
 * Everything the apply must be handed back, unchanged, to apply the intent that was REVIEWED.
 *
 * THE FINGERPRINT BINDS THE MINTED TARGET IDENTITIES. Sections 6 and 7 of the canonical pre-image
 * canonicalize `target_slot_id` per occurrence and per claim tuple, so re-minting between the
 * review and the apply produces a different fingerprint and the core answers `source_drift` — a
 * message about the operator's sources for what would actually be a defect in this file. The
 * identities are minted ONCE, at review, and carried.
 *
 * The command uuid is minted here for the same reason: it is the idempotency key, so a retry of
 * the same reviewed selection must present the same one and get `replayed` rather than a second
 * round.
 */
export interface ReviewedSelection {
  selectionDigest: string | null;
  reviewFingerprint: string;
  targetSlotIds: string[];
  commandId: string;
  /**
   * The DISTINCT cohort the operator approved.
   *
   * Carried with the review because the apply does not return it — it returns `claim_count`, which
   * is occurrences × subjects. Reporting that as the number of people invited told an operator with
   * five players over eight sessions that they had invited forty.
   */
  cohortTotal: number;
  /**
   * THE ROUND VERSION THIS REVIEW WAS FENCED AGAINST — `extend` only, null for a create.
   *
   * It is carried WITH the review rather than re-read at apply time on purpose. Re-reading would
   * make the apply fence itself against whatever the round looks like by then, which is not a
   * fence at all; carrying it means a round that moved between the review and the send is refused
   * `expected_version_mismatch`, which is exactly what the operator needs to be told.
   */
  expectedVersion: number | null;
}

export type SelectionReviewResult =
  | { phase: 'reviewed'; answer: SelectionAnswer; reviewed: ReviewedSelection }
  /** The core judged the intent and would not approve it. Nothing was written. */
  | { phase: 'refused'; answer: SelectionAnswer }
  /**
   * The intent WAS approved and fingerprinted, and still may not be applied. The review is real
   * and worth showing; the send is not available and the caller is told which rule says so.
   */
  | { phase: 'apply_ineligible'; answer: SelectionAnswer; eligibility: string }
  /** Decided by this client, without asking: the typed contract cannot accept an extend today. */
  | { phase: 'extend_unavailable' }
  | { phase: 'failed'; reason: SelectionFailure }
  | { phase: 'aborted' };

/**
 * PROBE → MINT → REVIEW.
 *
 * THE PROBE IS NOT A WASTED CALL. The typed protocol has the caller mint one identity per generated
 * slot, and only the server knows how many that is — so the first call deliberately carries an
 * empty pool and reads the refusal's occurrence count. Both calls write nothing: the preview core
 * is STABLE.
 */
export async function reviewSelection(
  intent: SelectionIntent,
  deps: { rpc: SelectionRpc; newUuid: () => string; signal?: AbortSignal },
): Promise<SelectionReviewResult> {
  // AN EXTEND IS ATTEMPTED NOW, BECAUSE THE SERVER RESOLVES THE FENCE THE BROWSER CANNOT.
  //
  // Round 3 established why it could not be: the core's expected-version fence is MANDATORY and
  // no client role can read the version. `rebook_rounds` carries
  // `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role` with RLS enabled and ZERO
  // policies — "a second lock on a door that has no handle" — so a freshly-opened extend wizard
  // had no round of any provenance it could fence, and refusing here was the honest answer.
  //
  // OWNER DECISION OD3 (`DISCLOSE_ACADEMY_SCOPED_ROUND_VERSION_FOR_EXTEND`) settled the capability
  // question that unblocks it. `20261203230000` has the Domain-A-owned preview wrapper resolve
  // `rebook_rounds.version` itself and return it, for a caller already proven to manage that
  // academy. NO NEW GRANT: the table stays revoked from every client role, and one integer about
  // the caller's own round reaches them through a wrapper they could already call.
  //
  // The fence is not weakened. This is ordinary optimistic concurrency — read v, apply with
  // expected v — and a concurrent extend still gets the core's typed `expected_version_mismatch`,
  // with `selection_moved` in front of it because the version is digested too.
  let probe = await askSelection(intent, 'review', [], deps);
  if (probe.phase === 'aborted') return { phase: 'aborted' };
  if (probe.phase === 'failed') return { phase: 'failed', reason: probe.reason };

  // ── AN EXTEND NEEDS ITS VERSION BEFORE THE CORE WILL DERIVE ANYTHING ────────────────────────
  //
  // CLOSURE REVIEW ROUND 2 (P1): the first cut of OD3 did not work at all, and its test hid that.
  //
  // The core refuses `p_command_kind = 'extend' AND p_expected_version IS NULL` outright (frozen
  // ABC-27 `:15728`) — the fence is mandatory, and it is checked long before any occurrence is
  // derived. So the probe came back `invalid_request` with `occurrence_count = 0`, and this
  // function exited on the zero-occurrence line ABOVE ever reading the version the wrapper had
  // helpfully returned. No extend could reach a review; OD3 was not delivered. The unit fixture
  // scripted a probe carrying `occurrence_count: 8` beside a null-version refusal, which is a
  // combination the server cannot produce.
  //
  // The version therefore has to be read from the refusal and the probe REPEATED with it. The
  // extra round trip buys the only thing that makes an extend previewable: a premise the core will
  // accept. The wrapper computes `round_version` before it calls the core, so a refused answer
  // still carries it.
  const roundVersion = intent.commandKind === 'extend'
    ? asExactCount((probe.answer.legacy as Record<string, unknown>).roundVersion)
    : null;
  if (intent.commandKind === 'extend') {
    // A round the server will not resolve a version for is one this browser cannot fence, whatever
    // the reason — and refusing HERE rather than sending is what round 2 of the cutover established:
    // sending produced `invalid_request`, which the wizard rendered as "there is nothing to rebook".
    if (roundVersion === null) return { phase: 'extend_unavailable' };
    probe = await askSelection({ ...intent, expectedVersion: roundVersion }, 'review', [], deps);
    if (probe.phase === 'aborted') return { phase: 'aborted' };
    if (probe.phase === 'failed') return { phase: 'failed', reason: probe.reason };
  }
  if (probe.answer.occurrenceCount <= 0) return { phase: 'refused', answer: probe.answer };

  const targetSlotIds = Array.from({ length: probe.answer.occurrenceCount }, () => deps.newUuid());
  // The digest the PROBE issued is echoed, so a selection that moves between the two calls is
  // refused here rather than surviving into a review the operator would then approve. The version
  // travels with it: it is part of the premise the core will check.
  const withDigest = { ...intent, selectionDigest: probe.answer.selectionDigest,
    expectedVersion: roundVersion ?? intent.expectedVersion };
  const reviewed = await askSelection(withDigest, 'review', targetSlotIds, deps);
  if (reviewed.phase === 'aborted') return { phase: 'aborted' };
  if (reviewed.phase === 'failed') return { phase: 'failed', reason: reviewed.reason };
  // REVIEW ROUND 4 (P3): THE FINGERPRINT IS VALIDATED, NOT MERELY NON-NULL. A review was armed by
  // any non-empty string, while the repo already ships an exact 32-octet `\x…` validator for this
  // very value. Tests were normalising four-byte fingerprints that no server could produce.
  if (reviewed.answer.status !== 'previewed'
      || readReviewFingerprint(reviewed.answer.reviewFingerprint) === null) {
    return { phase: 'refused', answer: reviewed.answer };
  }
  // APPROVED IS NOT THE SAME AS APPLIABLE, and the core says which in its own field.
  if (reviewed.answer.applyEligibility !== 'eligible') {
    return {
      phase: 'apply_ineligible',
      answer: reviewed.answer,
      eligibility: reviewed.answer.applyEligibility ?? 'unknown',
    };
  }
  return {
    phase: 'reviewed',
    answer: reviewed.answer,
    reviewed: {
      selectionDigest: reviewed.answer.selectionDigest,
      reviewFingerprint: reviewed.answer.reviewFingerprint,
      targetSlotIds,
      commandId: deps.newUuid(),
      cohortTotal: asCount((reviewed.answer.legacy as Record<string, unknown>).players),
      expectedVersion: roundVersion,
    },
  };
}

export type SelectionApplyResult =
  | {
      phase: 'applied';
      /**
       * WHETHER THIS CALL WROTE THE ROUND, OR MERELY RE-READ A COMMAND THAT ALREADY HAD.
       *
       * `replayed` means an EARLIER apply of this same command committed — and that earlier attempt
       * may already have drained invitations. Since a provider send is only durably recorded by
       * `invited_at`, which is written AFTER the send, an unstamped claim is indistinguishable
       * between "never sent" and "sent, stamp failed". Draining on a replay could therefore repeat
       * a provider effect, so the caller must not do it automatically.
       */
      replayed: boolean;
      roundId: string;
      childCount: number;
      claimCount: number;
      /**
       * WHO WAS REACHABLE AT THE MOMENT THE ROUND WAS WRITTEN.
       *
       * OD1/OD2: contact data is a mutable attribute of a person, not identity of a command, so a
       * recipient who gained or lost an address between the review and the apply does not
       * invalidate the receipt — the round is written either way. What must not happen is that
       * nobody says so. The server states these two facts; the caller compares them against the
       * projection the operator actually approved. Null when the answer was a refusal, which
       * discloses nothing.
       */
      contactableCount: number | null;
      uncontactableCount: number | null;
      /**
       * The cycles this command just created.
       *
       * NOT the source array the client rule withholds — these are the round's own children, the
       * rows the operator is about to be shown and navigate into, and the caller needs them to
       * drain invites. The server returns them so the browser does not re-derive
       * `md5(round || '|' || series_key)` for itself, which would be the browser reproducing a
       * server derivation: the exact habit this release exists to end.
       */
      childCycleIds: string[];
    }
  | { phase: 'refused'; status: string }
  | { phase: 'failed'; reason: SelectionFailure }
  | { phase: 'unknown'; commandId: string };

/**
 * Apply EXACTLY what was reviewed.
 *
 * IT TAKES THE REVIEW, NOT AN INTENT TO RE-REVIEW. Re-deriving the fingerprint or re-minting the
 * identities here would apply something the operator never approved, and the server would rightly
 * call that drift.
 *
 * A TRANSPORT FAILURE IS `unknown`, NEVER A FAILURE. The command may have committed; the command
 * uuid is carried out so the caller can resolve it rather than guess.
 */
// ── RECOVERING A LOST APPLY RESPONSE ─────────────────────────────────────────────────────────
//
// D7 TERMINAL CLOSURE — `RECOVERY=WIRE_EXISTING_COMMAND_STATUS_AND_REVIEW_FINGERPRINT_LOOKUP…`.
//
// NONE OF THIS IS NEW AUTHORITY. The two ABC-27 command-ledger read wrappers — status-by-command
// and lookup-by-review-fingerprint — are installed by the frozen migration and were ALREADY granted
// to `authenticated`; `src/lib/rebookRoundDriver.ts` has implemented the two-stage lookup since the
// command-driver work. (They are deliberately NOT named literally here: `d7RuntimeWiring.test.ts`
// scans for those identifiers anywhere in a production file, and a comment that mentions them is
// indistinguishable from a call site to a substring scan — which is exactly the strictness that
// makes the pin worth having.) The cutover routed both wizards through THIS driver, which had no
// recovery path — so a capability that exists, is reviewed and is granted sat entirely unused, and
// an operator whose apply response was lost got a uuid and a suggestion to go and look elsewhere.
//
// The apply's own duplicate-intent refusal has been saying what to do the whole time: "this actor
// already applied this exact reviewed intent under another command UUID; recover it by review
// fingerprint" (frozen ABC-27, `:13984`). The browser received that sentence and ignored it.
//
// IT CANNOT MINT, WRITE OR SEND. Both wrappers are `STABLE` and read only the Domain-A command
// ledger, scoped to the calling actor. Recovery re-reads a decision; it never takes one. That is
// what satisfies `…AND_NEVER_MINT_A_SECOND_COMMAND` structurally rather than by promise.

export type SelectionRecovery =
  /** The command committed. This is the round and the children it wrote. */
  | { phase: 'applied'; roundId: string; commandId: string; childCycleIds: string[]; claimCount: number }
  /**
   * NO command under either handle is VISIBLE TO THIS ACTOR. That is emphatically not the same as
   * "nothing was written", and the difference is the whole point of this name.
   *
   * REVIEW ROUND 1 (P1): this was called `absent`, and the operator was told "no round was created,
   * you can safely start again". The wrapper returns the IDENTICAL all-null `refused` row for "no
   * such command" and for "you are not a manager of this academy"
   * (`…abc27…:17095`, `:17140`) — deliberately, so the surface cannot be used to probe for other
   * people's commands. A manager whose apply committed, whose response was lost, and whose
   * `academy_managers` row was then removed gets exactly this answer about a round that EXISTS.
   * Acting on the old advice would have created a duplicate.
   *
   * The security property is right and stays. What was wrong was the client reading a
   * deliberately-ambiguous answer as proof.
   */
  | { phase: 'not_visible' }
  /** We could not decide, and say so. Never reported as either of the above. */
  | { phase: 'unreadable' };

/**
 * Ask the server what became of a command whose response we lost.
 *
 * TWO HANDLES, TRIED IN ORDER. The command uuid is the precise one. The reviewed fingerprint is
 * the one that still works when the uuid itself is gone — with the tab, or because the apply
 * refused `invalid_request` on `review_fingerprint`, which means some OTHER command uuid already
 * committed this exact reviewed intent.
 *
 * IT DELEGATES, AND THAT IS THE POINT. `recoverRebookRoundCommand` is the ONE place in `src/` that
 * names the ABC-27 operator wrappers — `d7RuntimeWiring.test.ts` pins exactly that, and the first
 * version of this function named them a second time and broke the pin. Two implementations of one
 * protocol is precisely the duplication that produced the digest and child-id drift earlier in
 * this release; the pin was right and this code was wrong.
 *
 * `not_visible` is reported only when BOTH refuse, because either one alone refusing proves
 * nothing about the other — which is `recoverRebookRoundCommand`'s own `not_found`.
 */
export async function recoverSelectionApply(
  intent: SelectionIntent,
  reviewed: { commandId: string; reviewFingerprint: string },
  deps: { rpc: SelectionRpc },
): Promise<SelectionRecovery> {
  const found = await recoverRebookRoundCommand(
    { intent: { academyProfileId: intent.academyProfileId }, ...reviewed },
    { rpc: deps.rpc },
  );
  if (found.phase === 'not_found') return { phase: 'not_visible' };
  // A row we could not verify is NOT a find. The receipt is null when the bytes did not hash to
  // their own digest, did not parse, or described a different round or command — and every one of
  // those means we could not decide, never that we did.
  if (found.phase !== 'found' || !found.receipt) return { phase: 'unreadable' };
  // AND IT MUST BE THE ROUND WE REVIEWED.
  //
  // REVIEW ROUND 1 (P2): the receipt was verified against the LEDGER ROW's own round id, which is
  // self-consistency, not identity — the row and the receipt agreeing says nothing about whether
  // either is ours. A stale or reused command uuid resolving to an older command of the same actor
  // in the same academy passed every cryptographic check and would have been drained against the
  // older round's children. The round this client minted is the only one it may finish.
  if (found.receipt.roundId !== intent.roundId) return { phase: 'unreadable' };
  return {
    phase: 'applied',
    roundId: found.receipt.roundId,
    commandId: found.receipt.commandId,
    childCycleIds: found.receipt.childCycleIds,
    claimCount: found.receipt.claimCount,
  };
}

export async function applyReviewedSelection(
  intent: SelectionIntent,
  reviewed: ReviewedSelection,
  deps: { rpc: SelectionRpc },
): Promise<SelectionApplyResult> {
  let data: unknown;
  let error: unknown;
  // THE APPLY IS FENCED AGAINST THE VERSION THE REVIEW SAW, not against the intent's own — the
  // wizard's body never carries one, and the server resolved it during the review.
  const args = previewArgs({ ...intent, selectionDigest: reviewed.selectionDigest,
    expectedVersion: reviewed.expectedVersion ?? intent.expectedVersion },
    'review', reviewed.targetSlotIds);
  // The apply surface has no projection: it acts, it does not describe.
  delete args.p_projection;
  try {
    ({ data, error } = await deps.rpc('rebook_round_selection_apply_as_actor', {
      ...args,
      p_command_id: reviewed.commandId,
      p_review_fingerprint: reviewed.reviewFingerprint,
    }));
  } catch {
    return { phase: 'unknown', commandId: reviewed.commandId };
  }
  if (error) return { phase: 'unknown', commandId: reviewed.commandId };
  const row = Array.isArray(data) ? asRecord(data[0]) : asRecord(data);
  if (!row) return { phase: 'unknown', commandId: reviewed.commandId };
  // THE ANSWER MUST BE ABOUT THE COMMAND WE SENT, and that is checked BEFORE its status is read.
  //
  // REVIEW ROUND 3 (P1): the binding used to happen only on the SUCCESS path, so a recognised
  // refusal carrying another command's id — `{status: 'source_drift', command_id: <somebody
  // else's>}` — was accepted as proof that OUR command wrote nothing. A row that is not about our
  // command says nothing about our command, whatever it says about itself.
  if (asUuid(row.command_id) !== reviewed.commandId) {
    return { phase: 'unknown', commandId: reviewed.commandId };
  }

  // REVIEW ROUND 2 (P2): AN UNREADABLE STATUS IS NOT A REFUSAL. `refused` is reported upward as
  // proof that nothing was written, and a body whose status we could not even read proves nothing
  // of the kind. Only a status we RECOGNISE may make that claim.
  const status = asText(row.status);
  if (status === null) return { phase: 'unknown', commandId: reviewed.commandId };
  if (status !== 'applied' && status !== 'replayed') {
    if (!APPLY_NO_WRITE_PROOF.has(status)) return { phase: 'unknown', commandId: reviewed.commandId };
    return { phase: 'refused', status };
  }
  const replayed = status === 'replayed';

  const roundId = asUuid(row.round_id);
  if (!roundId) return { phase: 'unknown', commandId: reviewed.commandId };
  // IT MUST BE *THE* ROUND, NOT MERELY *A* ROUND.
  //
  // REVIEW ROUND 1 (P2): this checked only that `round_id` parsed as a uuid, while `intent.roundId`
  // — the identity this client minted and sent — was right there. An answer about a different round
  // is not an answer about ours, exactly as a receipt carrying another command's id is not
  // (round 3's fix on the line above). A drifted round id is `unknown`: the command may well have
  // committed, and the uuid is the handle for finding out.
  if (roundId !== intent.roundId) return { phase: 'unknown', commandId: reviewed.commandId };
  // REVIEW ROUND 1 (P2): STRICT, NOT FAIL-OPEN. The first version filtered invalid child uuids
  // away and coerced a malformed count to zero, so a row carrying `claim_count: '40'` and one
  // unreadable child id decoded as "applied, no claims, drain this subset" — a confident success
  // built from a body we could not read, which is the one thing this contract exists to prevent.
  // A row that does not decode CLEANLY is `unknown`: the command may well have committed, and the
  // command uuid is the handle for finding out.
  if (!Array.isArray(row.child_cycle_ids)) return { phase: 'unknown', commandId: reviewed.commandId };
  const childCycleIds = row.child_cycle_ids.map(asUuid);
  if (childCycleIds.some((x) => x === null)) return { phase: 'unknown', commandId: reviewed.commandId };
  const childCount = asExactCount(row.child_count);
  const claimCount = asExactCount(row.claim_count);
  if (childCount === null || claimCount === null) {
    return { phase: 'unknown', commandId: reviewed.commandId };
  }
  // The server's own count and the ids it returned must agree, or one of them is not what we think.
  if (childCount !== childCycleIds.length) return { phase: 'unknown', commandId: reviewed.commandId };
  return {
    phase: 'applied',
    replayed,
    roundId,
    childCount,
    claimCount,
    childCycleIds: childCycleIds as string[],
    contactableCount: asExactCount(row.contactable_count),
    uncontactableCount: asExactCount(row.uncontactable_count),
  };
}
