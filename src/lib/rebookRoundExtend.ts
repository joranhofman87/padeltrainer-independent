// Prefill for the "add groups to an existing rebook round" flow (RebookCohortWizard extend mode).
// The extension inherits the round's shape — label, dates, price, payment mode, holidays, email
// texts, rules, locations — from the round's existing cycles; every field stays editable in the
// wizard before sending (the send itself carries the full body, the server only pins label + id).
import { supabase } from '@/lib/supabaseClient';
import type { RebookPaymentMode } from '@/lib/priorityClaims';

export interface RebookRoundExtendPrefill {
  roundId: string;
  /** Round label (settings.rebook_round_label) — pinned server-side; shown read-only. */
  label: string;
  /** Any cycle of the round — its manage page aggregates the whole round (drill-in target). */
  anyCycleId: string;
  startDate: string | null; // yyyy-MM-dd
  endDate: string | null; // yyyy-MM-dd
  /** '' when the original run used the per-series source prices (no override). */
  sessionPrice: string;
  holidays: Array<{ name: string; from: string; to: string }>;
  paymentMode: RebookPaymentMode;
  strictMollie: boolean;
  autoReminder: boolean;
  invitationMessage: string;
  invitationSubject: string;
  reminderMessage: string;
  reminderSubject: string;
  rebookRules: string;
  /** Distinct locations of the round's cycles — preselects the wizard's location checkboxes. */
  locationIds: string[];
  /** Source cycles the round was built from — used to suggest the term-end date. */
  sourceCyclusIds: string[];
}

export interface RoundCycleRow {
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  location_id: string | null;
  settings: Record<string, unknown> | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Pure: fold the round's cycle rows into the wizard prefill. Null when the round has no cycles. */
export function mapRoundCyclesToPrefill(roundId: string, rows: RoundCycleRow[]): RebookRoundExtendPrefill | null {
  if (rows.length === 0) return null;
  // Settings are stamped identically on every cycle of a run; read from the first row that has
  // each key so a partially-extended round (older run + newer extension) still resolves.
  const allSettings = rows.map((r) => r.settings ?? {});
  const firstValue = (key: string): unknown => allSettings.map((s) => s[key]).find((v) => v != null);

  const label = allSettings
    .map((s) => s.rebook_round_label)
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const price = firstValue('rebook_session_price');
  const holidaysRaw = firstValue('rebook_holidays');
  const holidays = Array.isArray(holidaysRaw)
    ? (holidaysRaw as Array<{ name?: unknown; from?: unknown; to?: unknown }>)
        .filter((h) => h && typeof h.from === 'string' && typeof h.to === 'string')
        .map((h) => ({ name: str(h.name), from: h.from as string, to: h.to as string }))
    : [];

  return {
    roundId,
    label: (label ?? rows[0].name).trim(),
    anyCycleId: rows[0].id,
    startDate: rows[0].start_date,
    endDate: rows[0].end_date,
    sessionPrice: typeof price === 'number' || (typeof price === 'string' && price !== '') ? String(price) : '',
    holidays,
    paymentMode: firstValue('rebook_payment_mode') === 'upfront' ? 'upfront' : 'deferred_split',
    strictMollie: firstValue('rebook_strict_mollie') === true,
    autoReminder: firstValue('rebook_auto_reminder') !== false,
    invitationMessage: str(firstValue('rebook_invitation_message')),
    invitationSubject: str(firstValue('rebook_invitation_subject')),
    reminderMessage: str(firstValue('rebook_reminder_message')),
    reminderSubject: str(firstValue('rebook_reminder_subject')),
    rebookRules: str(firstValue('rebook_rules')),
    locationIds: [...new Set(rows.map((r) => r.location_id).filter((x): x is string => !!x))],
    sourceCyclusIds: [
      ...new Set(
        allSettings
          .map((s) => s.rebook_source_cyclus_id)
          .filter((x): x is string => typeof x === 'string' && x.length > 0),
      ),
    ],
  };
}

/** The round's cycles (owner-scoped) folded into a wizard prefill; null when the round doesn't exist. */
export async function getRebookRoundExtendPrefill(
  academyProfileId: string,
  roundId: string,
): Promise<RebookRoundExtendPrefill | null> {
  const { data, error } = await supabase
    .from('cycles')
    .select('id, name, start_date, end_date, location_id, settings')
    .eq('owner_type', 'academy')
    .eq('owner_id', academyProfileId)
    .eq('settings->>rebook_round_id', roundId)
    .not('settings->>rebook_payment_mode', 'is', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return mapRoundCyclesToPrefill(roundId, (data ?? []) as unknown as RoundCycleRow[]);
}

/**
 * Suggested "current term ends" date for the extension: the last session of the round's SOURCE
 * cycles (yyyy-MM-dd, browser-local — a prefill suggestion, the owner can adjust). Null when the
 * sources are unknown (legacy data) or unreadable.
 */
export async function suggestTermEndFromSources(sourceCyclusIds: string[]): Promise<string | null> {
  if (sourceCyclusIds.length === 0) return null;
  const { data, error } = await supabase
    .from('availability_slots')
    .select('start_time')
    .in('cyclus_id', sourceCyclusIds)
    .order('start_time', { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const d = new Date(data[0].start_time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
