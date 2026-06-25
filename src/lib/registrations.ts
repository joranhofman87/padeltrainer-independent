import { supabase } from '@/lib/supabaseClient';
import { getCyclesWithCounts, type Cycle, type CycleSettings } from '@/lib/cycles';

/**
 * The intake-FORM half of the registration↔cycle split (Phase 2).
 *
 * A `registrations` row holds only the public intake-form config; the TRAINING (slots/bookings/
 * pricing) stays on the `cycles` row it was split from (`source_cycle_id`). See
 * docs/PHASE2_REGISTRATIONS_SPLIT.md.
 */
export interface Registration {
  id: string;
  /** The training cycle this form was split out of (owns the slots/bookings). */
  source_cycle_id: string;
  owner_type: 'trainer' | 'club' | 'academy';
  owner_id: string;
  format: 'registration' | 'event';
  name: string;
  description: string | null;
  /** Training span, copied from the source cycle — drives (price × weeks) per-lesson pricing. */
  start_date: string | null;
  end_date: string | null;
  enrollment_deadline: string | null;
  status: 'draft' | 'open' | 'closed' | 'archived';
  total_price: number | null;
  currency: string;
  price_table: unknown | null;
  location_id: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve a registration by EITHER its own id (the new canonical id) OR a legacy cycle id (the
 * `source_cycle_id` it was split from). The legacy path keeps already-distributed `/register/:cycleId`
 * links and printed QR codes working after the split. Returns null if neither matches.
 */
export async function getRegistration(idOrSourceCycleId: string): Promise<Registration | null> {
  const direct = await supabase.from('registrations').select('*').eq('id', idOrSourceCycleId).maybeSingle();
  if (direct.data) return direct.data as unknown as Registration;
  const legacy = await supabase.from('registrations').select('*').eq('source_cycle_id', idOrSourceCycleId).maybeSingle();
  return (legacy.data as unknown as Registration | null) ?? null;
}

/** All registrations owned by a trainer/club/academy (newest first). */
export async function listRegistrations(
  ownerType: Registration['owner_type'],
  ownerId: string,
): Promise<Registration[]> {
  const { data, error } = await supabase
    .from('registrations')
    .select('*')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as Registration[];
}

/**
 * Present a registration as the `Cycle` shape the existing public form + cards already consume, so
 * the dual-read consuming layer needs no changes to those components. The mapped `id` is the
 * registration's SOURCE training cycle (`source_cycle_id`) — i.e. what `intake_requests.cycle_id`
 * must keep pointing at — so the existing submit path writes the correct cycle_id unchanged. The
 * registration's own id is used separately (by the caller) for canonical links + redirects.
 */
export function registrationToCycle(reg: Registration): Cycle {
  return {
    id: reg.source_cycle_id,
    owner_type: reg.owner_type,
    owner_id: reg.owner_id,
    name: reg.name,
    description: reg.description,
    start_date: reg.start_date,
    end_date: reg.end_date,
    enrollment_deadline: reg.enrollment_deadline,
    is_always_open: false,
    settings: (reg.settings ?? {}) as CycleSettings,
    status: reg.status,
    type: reg.format,
    location_id: reg.location_id,
    price_per_session: null,
    total_price: reg.total_price,
    currency: reg.currency,
    terms: null,
    price_table: (reg.price_table as Cycle['price_table']) ?? null,
    created_at: reg.created_at,
    updated_at: reg.updated_at,
  };
}

/**
 * The academy/trainer "registrations" list during the split: legacy registration/event cycles
 * (still on `cycles`) UNION the new `registrations` rows, deduped by the training (source) cycle id
 * so a form appears exactly once whether or not it has been migrated. A migrated registration wins
 * over its legacy cycle. Each row is the `Cycle` shape the existing list UI already consumes, and
 * the id stays the SOURCE cycle so existing detail / QR / intake-count links keep working
 * unchanged. Pre-backfill (empty registrations table) this is identical to
 * getCyclesWithCounts(ownerType, ownerId, ['registration', 'event']).
 */
export async function listRegistrationCycles(
  ownerType: Registration['owner_type'],
  ownerId: string,
): Promise<Cycle[]> {
  const [legacy, registrations] = await Promise.all([
    getCyclesWithCounts(ownerType, ownerId, ['registration', 'event']),
    listRegistrations(ownerType, ownerId),
  ]);

  const mapped = registrations.map(registrationToCycle); // id = source_cycle_id
  // Intake counts for the migrated registrations, keyed on the source/training cycle id — the
  // same key getCyclesWithCounts counts on, since intake_requests.cycle_id stays the source cycle.
  if (mapped.length > 0) {
    const ids = mapped.map((c) => c.id);
    const { data: intakeRows } = await supabase
      .from('intake_requests')
      .select('cycle_id')
      .in('cycle_id', ids);
    const counts = new Map<string, number>();
    intakeRows?.forEach((r) => counts.set(r.cycle_id, (counts.get(r.cycle_id) ?? 0) + 1));
    mapped.forEach((c) => {
      c._intakeCount = counts.get(c.id) ?? 0;
    });
  }

  const byId = new Map<string, Cycle>();
  for (const c of legacy) byId.set(c.id, c);
  for (const c of mapped) byId.set(c.id, c); // migrated registration wins
  return Array.from(byId.values()).sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  );
}
