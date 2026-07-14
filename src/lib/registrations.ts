import { supabase } from '@/lib/supabaseClient';
import { attachCycleLocations, type Cycle, type CycleSettings, type CycleInput } from '@/lib/cycles';

/**
 * The intake-FORM half of the registration↔cycle split (Phase 2).
 *
 * A `registrations` row holds only the public intake-form config; the TRAINING (slots/bookings/
 * pricing) stays on the `cycles` row it was split from (`source_cycle_id`). See
 * docs/PHASE2_REGISTRATIONS_SPLIT.md.
 */
export interface Registration {
  id: string;
  /**
   * LEGACY-URL ALIAS only (decouple 2f): the id of the cycle shell this form was originally split
   * from, kept so already-distributed /register/:cycleId links + QR codes still resolve. The shell
   * itself is deleted; standalone forms have NULL here. Never treat this as a live cycle reference.
   */
  source_cycle_id: string | null;
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
 * Set a registration form's status (the public /register form obeys `registrations.status`; anon RLS
 * shows only status='open'). Accepts the registration's own id OR its legacy source-cycle alias so
 * every caller works regardless of which id its row carries. Post-decouple there is no cycle shell to
 * keep in lockstep — this is THE status write. No-op for a genuine training cyclus id (no form matches).
 */
export async function syncRegistrationStatus(idOrSourceCycleId: string, status: Registration['status']): Promise<void> {
  const { count } = await supabase
    .from('registrations')
    .update({ status } as never, { count: 'exact' })
    .eq('id', idOrSourceCycleId);
  if (!count) {
    await supabase.from('registrations').update({ status } as never).eq('source_cycle_id', idOrSourceCycleId);
  }
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
  /** Settings from the editor — the RPC stores only the whitelisted FORM keys. */
  settings?: Record<string, unknown>;
}

/**
 * Map the `CycleInput` the editor (CycleForm) already builds → `RegistrationInput`. The shapes are
 * 1:1 except: `type` → `format` (a registration is only 'registration' | 'event');
 * `price_per_session` is dropped (registrations have no per-session price; the form already nulls it);
 * `terms`/`is_always_open` are dropped (write-only dead plumbing on the old shell — the public form
 * reads owner-level terms, and always-open is encoded as a NULL enrollment_deadline).
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
  };
}

/**
 * Canonical "create a registration form" write. Calls create_registration (decouple 2c,
 * migration 20260823110000): a registration is a STANDALONE form — no cycle shell is minted.
 * The RPC owns the owner-authorization check and stores only whitelisted form settings.
 */
export async function createRegistration(input: RegistrationInput): Promise<Registration> {
  const { data, error } = await supabase.rpc('create_registration' as never, {
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
  } as never);
  if (error) throw error;
  return data as unknown as Registration;
}

/**
 * Canonical "edit a registration form" write, keyed on the registration's OWN id (decouple 2c).
 * Calls update_registration, which authorizes against the row's existing owner — no owner fields
 * are accepted from the caller — and touches ONLY the registrations table (no cycle shell).
 * Accepts a legacy source-cycle alias too (resolves it first) so stale navigation state that still
 * carries a shell id cannot mis-write.
 */
export async function updateRegistration(
  registrationIdOrLegacy: string,
  input: Omit<RegistrationInput, 'owner_type' | 'owner_id'>,
): Promise<Registration> {
  // Resolve the canonical id (handles a legacy source_cycle_id alias transparently).
  const existing = await getRegistration(registrationIdOrLegacy);
  if (!existing) throw new Error('registration_not_found');
  const { data, error } = await supabase.rpc('update_registration' as never, {
    p_registration_id: existing.id,
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
    // Decouple 2b: the registration's OWN id is the canonical handle everywhere (links, detail
    // routes, intake counts, submits). Legacy /register/:sourceCycleId URLs still resolve because
    // getRegistration also matches the source_cycle_id alias.
    id: reg.id,
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
 * Per-registration intake counts via the count_registrations_intakes RPC (decouple: intakes key on
 * registration_id; cycle_id is "planned into" and may be NULL). RLS-scoped (SECURITY INVOKER).
 */
export async function countRegistrationsIntakes(registrationIds: string[]): Promise<Map<string, number>> {
  if (registrationIds.length === 0) return new Map();
  const { data, error } = await supabase.rpc('count_registrations_intakes' as never, {
    _registration_ids: registrationIds,
  } as never);
  if (error) throw error;
  const rows = (data ?? []) as unknown as { registration_id: string; n: number }[];
  return new Map(rows.map((r) => [r.registration_id, Number(r.n)]));
}

/**
 * The academy/trainer/club "registrations" list: registrations are STANDALONE forms (decouple 2f
 * deleted the cycle shells and migrated every legacy form into the registrations table), so this
 * reads ONE table + one count RPC. Rows keep the `Cycle` shape the list UI consumes, with
 * id = the registration's own id (canonical everywhere).
 */
export async function listRegistrationCycles(
  ownerType: Registration['owner_type'],
  ownerId: string,
): Promise<Cycle[]> {
  const registrations = await listRegistrations(ownerType, ownerId);
  const mapped = registrations.map(registrationToCycle);
  if (mapped.length > 0) {
    const counts = await countRegistrationsIntakes(mapped.map((c) => c.id));
    mapped.forEach((c) => {
      c._intakeCount = counts.get(c.id) ?? 0;
    });
  }
  // registrationToCycle carries only location_id (no joined name) — attach {id,name,city}
  // so the Locatie column renders.
  return attachCycleLocations(mapped);
}
