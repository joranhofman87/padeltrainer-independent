import { supabase } from '@/lib/supabaseClient';
import { getCyclesWithCounts, countCyclesIntakesWithFallback, attachCycleLocations, type Cycle, type CycleSettings, type CycleInput } from '@/lib/cycles';
import { isMissingRpc } from '@/lib/deployDrift';

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

export interface RegistrationEditTarget {
  writeTarget: 'cycle' | 'registration';
  formType: 'registration' | 'event';
}

/**
 * Decide how the cycle editor must SAVE — by OVERLAY EXISTENCE, not the shell's `type`.
 *
 * A registration created via create_registration_with_cycle has a `cycles` shell born `type='cyclus'`
 * PLUS a `registrations` overlay. The old rule (`writeTarget = type==='cyclus' ? 'cycle' : 'registration'`)
 * therefore sent every post-split registration's edits to the CYCLE row — never the overlay that the
 * public /register form renders and the invoice path prices — so price/close changes silently never
 * reached players (architecture audit 2026-07-11, Theme 1 / §3.1). Rule now: an overlay row (or a
 * LEGACY `type` of 'registration'/'event') ⇒ write the registration; a genuine training cyclus with no
 * overlay ⇒ write the cycle. `formType` comes from the overlay when present, else the legacy cycle type
 * — otherwise a split EVENT (shell `type='cyclus'`) would mis-render as a registration.
 */
export function resolveRegistrationEditTarget(args: {
  isEdit: boolean;
  cycleType?: string | null;
  overlayFormat?: Registration['format'] | null;
  requestedType: Registration['format'];
}): RegistrationEditTarget {
  const { isEdit, cycleType, overlayFormat, requestedType } = args;
  if (!isEdit) return { writeTarget: 'registration', formType: requestedType };
  const isRegistrationRow = overlayFormat != null || cycleType === 'registration' || cycleType === 'event';
  const formType: Registration['format'] = overlayFormat ?? (cycleType === 'event' ? 'event' : 'registration');
  return { writeTarget: isRegistrationRow ? 'registration' : 'cycle', formType };
}

/**
 * Keep a split registration's overlay status in lockstep with its cycle shell. The public /register
 * form of a split registration obeys `registrations.status` (anon RLS: only status='open' is visible),
 * so closing/opening must update BOTH rows — writing only `cycles.status` left the form live and still
 * minting invoices (audit Theme 1). No-op when the cycle has no overlay (a legacy form's status lives
 * on the cycle; a training cyclus has no overlay row), so it is safe to call for any cycle.
 */
export async function syncRegistrationStatus(sourceCycleId: string, status: Registration['status']): Promise<void> {
  await supabase.from('registrations').update({ status } as never).eq('source_cycle_id', sourceCycleId);
}

/** Form fields for creating / editing a registration via the canonical RPCs. */
export interface RegistrationInput {
  owner_type: Registration['owner_type'];
  owner_id: string;
  format: Registration['format'];
  name: string;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  enrollment_deadline?: string | null;
  status?: Registration['status'];
  total_price?: number | null;
  currency?: string | null;
  price_table?: unknown | null;
  location_id?: string | null;
  /** FULL settings — the RPC keeps the FORM-only subset on the registration and the rest on the cycle. */
  settings?: Record<string, unknown>;
  terms?: string | null;
  is_always_open?: boolean;
}

/**
 * True when an RPC failed because the function isn't in PostgREST's schema cache yet — i.e. the
 * write-path migration (20260630130000) hasn't been applied to the DB. supabase-js surfaces this as
 * PostgrestError `PGRST202` (and Postgres `42883`). The editor uses this to fall back to the legacy
 * cycle write during the window where the FE has auto-deployed but the owner hasn't applied the
 * migration. (Same shape as the documented fallback in src/lib/invoicesList.ts.)
 */
export function isMissingRegistrationRpc(error: unknown): boolean {
  return isMissingRpc(error);
}

/**
 * Map the `CycleInput` the editor (CycleForm) already builds → `RegistrationInput`. The shapes are
 * 1:1 except: `type` → `format` (a registration is only 'registration' | 'event'), and
 * `price_per_session` is dropped (registrations have no per-session price; the form already nulls it).
 * The FULL settings pass through — the RPC keeps the FORM-only subset on the registration.
 */
export function cycleInputToRegistrationInput(input: CycleInput): RegistrationInput {
  return {
    owner_type: input.owner_type,
    owner_id: input.owner_id,
    format: input.type === 'event' ? 'event' : 'registration',
    name: input.name,
    description: input.description ?? null,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    enrollment_deadline: input.enrollment_deadline ?? null,
    status: (input.status as Registration['status']) ?? 'draft',
    total_price: input.total_price ?? null,
    currency: input.currency,
    price_table: input.price_table ?? null,
    location_id: input.location_id ?? null,
    settings: (input.settings ?? {}) as Record<string, unknown>,
    terms: input.terms ?? null,
    is_always_open: input.is_always_open,
  };
}

/**
 * Canonical "create a registration form" write. Calls create_registration_with_cycle
 * (migration 20260630130000) which atomically mints the type='cyclus' training-cycle
 * shell + the registration overlay (source_cycle_id → shell) and returns the row.
 * The RPC owns the form/training settings split + the owner-authorization check.
 * INERT until the editor (Slice 3) adopts it.
 */
export async function createRegistration(input: RegistrationInput): Promise<Registration> {
  const { data, error } = await supabase.rpc('create_registration_with_cycle' as never, {
    p_owner_type: input.owner_type,
    p_owner_id: input.owner_id,
    p_format: input.format,
    p_name: input.name,
    p_description: input.description ?? null,
    p_start_date: input.start_date ?? null,
    p_end_date: input.end_date ?? null,
    p_enrollment_deadline: input.enrollment_deadline ?? null,
    p_status: input.status ?? 'draft',
    p_total_price: input.total_price ?? null,
    p_currency: input.currency ?? 'EUR',
    p_price_table: (input.price_table ?? null) as never,
    p_location_id: input.location_id ?? null,
    p_settings: (input.settings ?? {}) as never,
    p_terms: input.terms ?? null,
    p_is_always_open: input.is_always_open ?? false,
  } as never);
  if (error) throw error;
  return data as unknown as Registration;
}

/**
 * Canonical "edit a registration form" write, keyed on the SOURCE training cycle id.
 * Calls update_registration_with_cycle which updates the cycle's shared fields and
 * UPSERTs the registration (ON CONFLICT (source_cycle_id)) — so editing a legacy
 * not-yet-backfilled cycle ADOPTS it (creates its registration row). Authorizes
 * against the existing cycle's owner; no owner_type/owner_id is accepted from the caller.
 */
export async function updateRegistration(
  sourceCycleId: string,
  input: Omit<RegistrationInput, 'owner_type' | 'owner_id'>,
): Promise<Registration> {
  const { data, error } = await supabase.rpc('update_registration_with_cycle' as never, {
    p_source_cycle_id: sourceCycleId,
    p_format: input.format,
    p_name: input.name,
    p_description: input.description ?? null,
    p_start_date: input.start_date ?? null,
    p_end_date: input.end_date ?? null,
    p_enrollment_deadline: input.enrollment_deadline ?? null,
    p_status: input.status ?? null,
    p_total_price: input.total_price ?? null,
    p_currency: input.currency ?? null,
    p_price_table: (input.price_table ?? null) as never,
    p_location_id: input.location_id ?? null,
    p_settings: (input.settings ?? null) as never,
    p_terms: input.terms ?? null,
    p_is_always_open: (input.is_always_open ?? null) as never,
  } as never);
  if (error) throw error;
  return data as unknown as Registration;
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
    // Count via the indexed count_cycles_intakes RPC (same path getCyclesWithCounts uses),
    // not a client-side scan of intake_requests. The helper falls back to the JS count only
    // when the RPC isn't deployed (PGRST202), so behaviour is identical pre-deploy.
    const counts = await countCyclesIntakesWithFallback(mapped.map((c) => c.id));
    mapped.forEach((c) => {
      c._intakeCount = counts.get(c.id) ?? 0;
    });
  }

  const byId = new Map<string, Cycle>();
  for (const c of legacy) byId.set(c.id, c);
  for (const c of mapped) byId.set(c.id, c); // migrated registration wins
  const merged = Array.from(byId.values()).sort((a, b) =>
    (b.created_at ?? '').localeCompare(a.created_at ?? ''),
  );
  // registrationToCycle carries only location_id (no joined name), and it OVERWRITES the
  // legacy cycle that had `.location` embedded — so the migrated rows would render a blank
  // Locatie column. Attach `{id,name,city}` to the whole set (idempotent for legacy rows).
  return attachCycleLocations(merged);
}
