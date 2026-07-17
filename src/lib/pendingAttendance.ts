// Phase 3.3-attendance part 2 (person-unification): the PLAYER-side pending-attendance reader,
// person-keyed. Part 1 (migration 20260831100000) person-keyed the session_reports RLS so a
// guest-seated session is now WRITABLE; this surfaces those sessions so the player can report.
//
// The direct bookings read is PURE-PROFILE (player_id = me AND guest_player_id IS NULL — the 3.1 r3
// / FAM-02 rule: a dual-keyed row is the GUEST person's), and the player's guest-side sessions
// arrive via the frozen SECURITY DEFINER RPC exactly like the bookings pages
// (fetchLinkedGuestBookingRows: person-first + twin-precedence bridge + split-pending freeze).
// The attendance report writes to session_reports keyed by (slot_id, reporter_id = profile id) —
// identical for both seat kinds, and now RLS-permitted for guest seats (part 1).
import { supabase } from '@/lib/supabaseClient';
import { fetchLinkedGuestBookingRows } from '@/lib/playerBookings';
import { fetchTrainerSlotSummaries } from '@/lib/sessionReports';

export interface PendingPlayerSlot {
  slotId: string;
  startTime: string;
  cyclusName: string | null;
  locationName: string | null;
  players: Array<{ id: string; name: string }>;
  bookingId?: string;
  trainerSummary?: string | null;
}

interface PendingBookingRow {
  id: string;
  slot_id: string;
  availability_slots: {
    start_time: string;
    cyclus_name: string | null;
    locations: { name: string } | null;
  };
}

const REPORTABLE_STATUSES = ['confirmed', 'completed'];

export async function fetchPendingPlayerSlots(profileId: string): Promise<PendingPlayerSlot[]> {
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const now = new Date();

  const [direct, linkedRows] = await Promise.all([
    supabase
      .from('bookings')
      .select(`
        id, status, slot_id,
        availability_slots!inner (id, start_time, cyclus_name, location_id, locations:location_id (name))
      `)
      .eq('player_id', profileId)
      .is('guest_player_id', null) // FAM-02: dual-keyed rows are the GUEST person's
      .in('status', REPORTABLE_STATUSES)
      .gte('availability_slots.start_time', fourteenDaysAgo.toISOString())
      .lt('availability_slots.start_time', now.toISOString())
      .order('created_at', { ascending: false })
      .limit(50),
    fetchLinkedGuestBookingRows(),
  ]);

  const bookings: PendingBookingRow[] = [...((direct.data ?? []) as unknown as PendingBookingRow[])];

  // Merge the player's guest-side sessions (RPC rows carry the same slot fields), applying the
  // same window + status filter the direct query does server-side.
  const lo = fourteenDaysAgo.getTime();
  const hi = now.getTime();
  for (const r of linkedRows) {
    const slot = r.availability_slots;
    if (!slot?.start_time || !r.status || !REPORTABLE_STATUSES.includes(r.status)) continue;
    const start = new Date(slot.start_time).getTime();
    if (Number.isNaN(start) || start < lo || start >= hi) continue;
    bookings.push({
      id: r.id,
      slot_id: r.slot_id,
      availability_slots: {
        start_time: slot.start_time,
        cyclus_name: slot.cyclus_name ?? null,
        locations: slot.locations ?? null,
      },
    });
  }
  if (bookings.length === 0) return [];

  // One prompt per SLOT — a merged person can hold seats under both keys on one session.
  const bySlot = new Map<string, PendingBookingRow>();
  for (const b of bookings) {
    if (!bySlot.has(b.slot_id)) bySlot.set(b.slot_id, b);
  }
  const slotIds = [...bySlot.keys()];

  const { data: reports } = await supabase
    .from('session_reports')
    .select('slot_id')
    .in('slot_id', slotIds)
    .eq('reporter_id', profileId);
  const reportedSlotIds = new Set(reports?.map((r) => r.slot_id) || []);

  const unreportedSlotIds = slotIds.filter((id) => !reportedSlotIds.has(id));
  const trainerSummaryMap = await fetchTrainerSlotSummaries(unreportedSlotIds);

  return unreportedSlotIds
    .map((slotId) => bySlot.get(slotId)!)
    .map((b) => ({
      slotId: b.slot_id,
      startTime: b.availability_slots.start_time,
      cyclusName: b.availability_slots.cyclus_name,
      locationName: b.availability_slots.locations?.name || null,
      players: [],
      bookingId: b.id,
      trainerSummary: trainerSummaryMap.get(b.slot_id) || null,
    }));
}
