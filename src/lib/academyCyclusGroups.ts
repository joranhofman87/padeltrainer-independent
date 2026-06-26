import { format, parseISO } from 'date-fns';
import type { Locale } from 'date-fns';
import type { CyclusGroupPaymentStatus } from './cyclusGroupPayment';

/**
 * One grouped cyclus-overview row as the academy page renders it. Produced two ways that MUST stay
 * in parity: (a) the server `get_academy_cyclus_groups` RPC (mapped via `mapCyclusGroupRow`), and
 * (b) the legacy client-side aggregation in AcademyCyclusOverview (graceful fallback while the RPC
 * is not yet deployed). The RPC does the heavy grouping/payment/PII aggregation; the CLIENT keeps
 * the locale formatting (`day_time`, the registration `cyclus_name` label) — a hybrid split.
 */
export interface CyclusGroup {
  group_key: string; // composite: cyclus_id + group_suffix (trainer, or trainer::dow::HH:MM-HH:MM)
  cyclus_id: string;
  cyclus_name: string;
  trainer_name: string;
  trainer_id: string;
  location_name: string | null;
  day_time: string;
  period_start: string;
  period_end: string;
  sessions: number;
  player_names: string[];
  player_count: number;
  price_per_session: number | null;
  max_participants: number;
  max_booked: number;
  /** True when any slot in the cyclus is public (showcased as bookable on the profile). */
  is_public: boolean;
  first_slot_id: string | null;
  status: string;
  type: string;
  has_slots: boolean;
  /** True when a real `cycles` row backs this group — false for orphan cyclus_id groups (slots only,
   * no cycles row). Drives row-click: real cycle → cycle-detail view; orphan → its first session. */
  has_cycle_row: boolean;
  payment_status_summary: CyclusGroupPaymentStatus;
}

/** Shape of one row returned by the `get_academy_cyclus_groups(p_academy_id)` RPC. */
export interface AcademyCyclusGroupRow {
  cyclus_id: string;
  group_suffix: string;
  trainer_id: string | null;
  trainer_name: string | null;
  has_cycle_row: boolean;
  is_registration: boolean;
  cycle_name: string | null;
  cyclus_name_fallback: string | null;
  location_name: string | null;
  sessions: number;
  max_booked: number;
  player_names: string[] | null;
  player_count: number;
  price_per_session: number | null;
  max_participants: number | null;
  first_slot_id: string | null;
  is_public: boolean;
  status: string;
  group_type: string;
  period_start: string;
  period_end: string;
  payment_status_summary: string;
}

/** supabase-js returns code 'PGRST202' (function not in schema cache) / Postgres '42883'
 * (function does not exist) when the migration is not yet applied → fall back to the client path. */
export function isMissingCyclusGroupsRpc(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'PGRST202' || code === '42883';
}

/**
 * Map one RPC row → the CyclusGroup the page renders, reconstructing the two client-owned
 * locale-formatted fields:
 *   - `day_time`: the first slot's "EEEE HH:mm - HH:mm" in the viewer's locale. period_start is the
 *     first slot's start; its end_time is supplied via `firstSlotEndById` (a cheap supplemental
 *     fetch keyed on first_slot_id — the RPC's period_end is the LAST slot's start, not this).
 *   - registration `cyclus_name`: the per-series "EEEE HH:mm - {firstPlayer}" label.
 * Everything else is a straight passthrough of the server aggregation.
 */
export function mapCyclusGroupRow(
  row: AcademyCyclusGroupRow,
  firstSlotEndById: Record<string, string>,
  dateLocale: Locale,
): CyclusGroup {
  const playerNames = row.player_names ?? [];
  const hasSlots = row.sessions > 0;

  // day_time — only for groups with slots (no-slot cycles render "—", as the client does).
  let dayTime = '—';
  if (hasSlots) {
    try {
      const start = parseISO(row.period_start);
      const dayName = format(start, 'EEEE', { locale: dateLocale });
      const startHHMM = format(start, 'HH:mm');
      const endIso = row.first_slot_id ? firstSlotEndById[row.first_slot_id] : undefined;
      dayTime = endIso
        ? `${dayName} ${startHHMM} - ${format(parseISO(endIso), 'HH:mm')}`
        : `${dayName} ${startHHMM}`;
    } catch {
      /* keep "—" */
    }
  }

  // cyclus_name — registration series get a locale label; everything else uses the cycle/orphan name.
  let cyclusName: string;
  if (row.is_registration) {
    let dayName = '';
    let startHHMM = '';
    try {
      const start = parseISO(row.period_start);
      dayName = format(start, 'EEEE', { locale: dateLocale });
      startHHMM = format(start, 'HH:mm');
    } catch {
      /* keep empties */
    }
    const firstPlayer = playerNames[0];
    cyclusName = firstPlayer ? `${dayName} ${startHHMM} - ${firstPlayer}` : `${dayName} ${startHHMM}`;
  } else {
    cyclusName = row.cycle_name ?? row.cyclus_name_fallback ?? row.cyclus_id;
  }

  return {
    group_key: `${row.cyclus_id}::${row.group_suffix}`,
    cyclus_id: row.cyclus_id,
    cyclus_name: cyclusName,
    trainer_name: row.trainer_name ?? 'Unknown',
    trainer_id: row.trainer_id ?? '',
    location_name: row.location_name ?? null,
    day_time: dayTime,
    period_start: row.period_start,
    period_end: row.period_end,
    sessions: row.sessions,
    player_names: playerNames,
    player_count: row.player_count,
    price_per_session: row.price_per_session ?? null,
    max_participants: row.max_participants ?? 4,
    max_booked: row.max_booked,
    is_public: row.is_public,
    first_slot_id: row.first_slot_id ?? null,
    status: row.status,
    type: row.group_type,
    has_slots: hasSlots,
    has_cycle_row: row.has_cycle_row,
    payment_status_summary: row.payment_status_summary as CyclusGroupPaymentStatus,
  };
}
