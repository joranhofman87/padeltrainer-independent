/**
 * Pure logic for the merge-players dialog (merge_guest_players RPC).
 *
 * Given the full guest_players rows of the TARGET (kept) and SOURCE (deleted)
 * players, this module decides per personal field whether the admin must
 * choose (conflict), whether the source's value is carried over automatically
 * (target empty), or whether nothing needs to happen — and builds the
 * `p_fields` payload the RPC applies to the target.
 */

export type MergeChoice = 'target' | 'source';

/** Comparable personal fields. `skill` is composite: skill_rating + rating_system. */
export type MergeComparisonKey =
  | 'full_name'
  | 'email'
  | 'phone'
  | 'skill'
  | 'birth_date'
  | 'notes'
  | 'billing_business_name'
  | 'billing_address'
  | 'billing_btw_number';

export const MERGE_COMPARISON_KEYS: MergeComparisonKey[] = [
  'full_name',
  'email',
  'phone',
  'skill',
  'birth_date',
  'notes',
  'billing_business_name',
  'billing_address',
  'billing_btw_number',
];

/** The slice of a guest_players row the merge logic needs (structural subset of the Supabase Row). */
export interface MergeGuestFields {
  full_name: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email: string | null;
  phone: string | null;
  skill_rating: number | null;
  rating_system: string | null;
  birth_date: string | null;
  notes: string | null;
  billing_business_name: string | null;
  billing_address: string | null;
  billing_btw_number: string | null;
}

export type MergeFieldKind =
  /** Both sides have a (different) value — the admin picks via radio. */
  | 'conflict'
  /** Only the source has a value — kept automatically, listed quietly. */
  | 'carry_from_source'
  /** Only the target has a value — nothing to do. */
  | 'target_only'
  /** Identical values — skipped entirely. */
  | 'equal'
  /** Neither side has a value. */
  | 'empty';

export interface MergeFieldState {
  key: MergeComparisonKey;
  kind: MergeFieldKind;
  /** Display value for the target side (null when empty). */
  targetValue: string | null;
  /** Display value for the source side (null when empty). */
  sourceValue: string | null;
}

function norm(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function formatSkill(rating: number | null, system: string | null): string | null {
  if (rating == null || Number.isNaN(Number(rating))) return null;
  const sys = (norm(system) ?? 'knltb').toUpperCase();
  return `${Number(rating).toFixed(1)} ${sys}`;
}

function fieldValues(
  key: MergeComparisonKey,
  row: MergeGuestFields,
): { display: string | null; comparable: string | null } {
  if (key === 'skill') {
    const display = formatSkill(row.skill_rating, row.rating_system);
    return { display, comparable: display };
  }
  const raw = norm(row[key]);
  if (key === 'email') {
    return { display: raw, comparable: raw ? raw.toLowerCase() : null };
  }
  return { display: raw, comparable: raw };
}

/**
 * Compare target vs source per personal field. Order follows
 * MERGE_COMPARISON_KEYS so the UI is stable.
 */
export function compareMergeFields(
  target: MergeGuestFields,
  source: MergeGuestFields,
): MergeFieldState[] {
  return MERGE_COMPARISON_KEYS.map((key) => {
    const t = fieldValues(key, target);
    const s = fieldValues(key, source);
    let kind: MergeFieldKind;
    if (t.comparable == null && s.comparable == null) kind = 'empty';
    else if (t.comparable != null && s.comparable == null) kind = 'target_only';
    else if (t.comparable == null && s.comparable != null) kind = 'carry_from_source';
    else if (t.comparable === s.comparable) kind = 'equal';
    else kind = 'conflict';
    return { key, kind, targetValue: t.display, sourceValue: s.display };
  });
}

/** jsonb-safe p_fields payload for the merge_guest_players RPC. */
export type MergeRpcFields = Record<string, string | number | null>;

function applySourceValue(
  fields: MergeRpcFields,
  key: MergeComparisonKey,
  source: MergeGuestFields,
): void {
  if (key === 'skill') {
    if (source.skill_rating != null) {
      fields.skill_rating = Number(source.skill_rating);
      fields.rating_system = norm(source.rating_system) ?? 'knltb';
    }
    return;
  }
  if (key === 'full_name') {
    const name = norm(source.full_name);
    if (name != null) {
      fields.full_name = name;
      // Keep the name parts consistent with the chosen full name (the RPC
      // null-clears '' / null values, so passing them through is safe).
      fields.first_name = norm(source.first_name ?? null);
      fields.last_name = norm(source.last_name ?? null);
    }
    return;
  }
  const value = norm(source[key]);
  if (value != null) fields[key] = value;
}

/**
 * Build p_fields for the RPC:
 * - conflicts where the admin chose the SOURCE value → included
 * - source-only values (auto-carry) → included
 * - everything else omitted (the target keeps its own value).
 *
 * `choices` defaults every conflict to 'target' when a key is absent.
 */
export function buildMergeFields(
  target: MergeGuestFields,
  source: MergeGuestFields,
  choices: Partial<Record<MergeComparisonKey, MergeChoice>> = {},
): MergeRpcFields {
  const fields: MergeRpcFields = {};
  for (const state of compareMergeFields(target, source)) {
    if (state.kind === 'carry_from_source') {
      applySourceValue(fields, state.key, source);
    } else if (state.kind === 'conflict' && (choices[state.key] ?? 'target') === 'source') {
      applySourceValue(fields, state.key, source);
    }
  }
  return fields;
}

export interface MergeResultCounts {
  bookingsMoved: number;
  invoicesMoved: number;
  intakeRequestsMoved: number;
  priorityClaimsMoved: number;
  priorityClaimsDeduped: number;
  metadataRowsMoved: number;
  metadataRowsMerged: number;
}

/** Safely read the jsonb counts the RPC returns (missing/odd shapes → zeros). */
export function parseMergeCounts(result: unknown): MergeResultCounts {
  const obj = (result && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const num = (key: string): number => {
    const v = Number(obj[key]);
    return Number.isFinite(v) ? v : 0;
  };
  return {
    bookingsMoved: num('bookings_moved'),
    invoicesMoved: num('invoices_moved'),
    intakeRequestsMoved: num('intake_requests_moved'),
    priorityClaimsMoved: num('priority_claims_moved'),
    priorityClaimsDeduped: num('priority_claims_deduped'),
    metadataRowsMoved: num('metadata_rows_moved'),
    metadataRowsMerged: num('metadata_rows_merged'),
  };
}

/** The RPC's "two different linked accounts" rejection, mapped for a friendly toast. */
export function isLinkedAccountsMergeError(message: string): boolean {
  return message.toLowerCase().includes('two different accounts');
}
