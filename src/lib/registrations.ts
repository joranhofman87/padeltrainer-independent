import { supabase } from '@/lib/supabaseClient';

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

// `registrations` is a brand-new table not yet in the generated Database types — `types.ts` is
// regenerated from the live project after the migration is applied (Docker isn't available locally
// to gen types). Until then, route its queries through this untyped handle; the `Registration`
// interface restores type-safety at the boundary. Swap to `supabase.from('registrations')` post-regen.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registrationsTable = () => (supabase as any).from('registrations');

/**
 * Resolve a registration by EITHER its own id (the new canonical id) OR a legacy cycle id (the
 * `source_cycle_id` it was split from). The legacy path keeps already-distributed `/register/:cycleId`
 * links and printed QR codes working after the split. Returns null if neither matches.
 */
export async function getRegistration(idOrSourceCycleId: string): Promise<Registration | null> {
  const direct = await registrationsTable().select('*').eq('id', idOrSourceCycleId).maybeSingle();
  if (direct.data) return direct.data as Registration;
  const legacy = await registrationsTable().select('*').eq('source_cycle_id', idOrSourceCycleId).maybeSingle();
  return (legacy.data as Registration | null) ?? null;
}

/** All registrations owned by a trainer/club/academy (newest first). */
export async function listRegistrations(
  ownerType: Registration['owner_type'],
  ownerId: string,
): Promise<Registration[]> {
  const { data, error } = await registrationsTable()
    .select('*')
    .eq('owner_type', ownerType)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Registration[];
}
