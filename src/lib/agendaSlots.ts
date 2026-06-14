/**
 * Agenda data layer — "what's coming up today / this week" for trainers and
 * academy managers. A focused read of availability_slots + bookings (+ a
 * session_report existence flag for the "report needed" hint), mirroring the
 * calendar's enrichment but rendered as a list. Does NOT touch the calendars.
 */
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { getSlotCapacity } from '@/lib/lessons';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';

export interface AgendaPlayer {
  id: string;
  name: string;
  status: 'confirmed' | 'pending';
  isGuest: boolean;
  skillRating: number | null;
}

export interface AgendaSlot {
  id: string;
  start_time: string;
  end_time: string;
  trainer_id: string | null;
  trainer_name: string | null;   // resolved for the academy multi-trainer view; null for a single trainer
  location_name: string | null;
  location_logo: string | null;
  cyclus_name: string | null;
  max_participants: number;
  active_bookings: number;
  pending_bookings: number;
  booked_players: AgendaPlayer[];
  is_past: boolean;
  has_report: boolean;           // a trainer session_report exists (past sessions: !has_report ⇒ "report needed")
}

const SLOT_SELECT =
  'id, start_time, end_time, trainer_id, cyclus_name, location_id, locations:location_id ( name, logo_url )';

async function enrichSlots(
  rawSlots: Array<Record<string, unknown>>,
  resolveTrainerNames: boolean,
): Promise<AgendaSlot[]> {
  if (rawSlots.length === 0) return [];
  const slotIds = rawSlots.map((s) => s.id as string);

  const { data: bookingsData } = await supabase
    .from('bookings')
    .select(`
      id, slot_id, status, player_id, guest_player_id,
      profiles:player_id ( full_name, skill_rating ),
      guest_players:guest_player_id ( full_name, skill_rating )
    `)
    .in('slot_id', slotIds);

  const counts: Record<string, { confirmed: number; pending: number; players: AgendaPlayer[] }> = {};
  for (const b of bookingsData ?? []) {
    const row = b as Record<string, unknown>;
    const slotId = row.slot_id as string;
    if (!counts[slotId]) counts[slotId] = { confirmed: 0, pending: 0, players: [] };
    const status = row.status as string;
    if (status === 'confirmed') counts[slotId].confirmed++;
    else if (status === 'pending') counts[slotId].pending++;
    if (status === 'confirmed' || status === 'pending') {
      const prof = row.profiles as { full_name: string | null; skill_rating: number | null } | null;
      const guest = row.guest_players as { full_name: string | null; skill_rating: number | null } | null;
      counts[slotId].players.push({
        id: (row.player_id as string) || (row.guest_player_id as string) || (row.id as string),
        name: prof?.full_name || guest?.full_name || 'Unknown',
        status: status as 'confirmed' | 'pending',
        isGuest: !!row.guest_player_id,
        skillRating: prof?.skill_rating ?? guest?.skill_rating ?? null,
      });
    }
  }

  // which slots already have a trainer session report (for the "report needed" hint)
  const { data: reports } = await supabase
    .from('session_reports')
    .select('slot_id')
    .in('slot_id', slotIds)
    .eq('reporter_role', 'trainer');
  const reported = new Set((reports ?? []).map((r) => (r as { slot_id: string }).slot_id));

  let trainerNames: Record<string, string> = {};
  if (resolveTrainerNames) {
    const trainerIds = [...new Set(rawSlots.map((s) => s.trainer_id as string).filter(Boolean))];
    if (trainerIds.length > 0) {
      trainerNames = await fetchTrainerDisplayNamesByProfileIds(trainerIds, supabase, 'Agenda');
    }
  }

  const now = Date.now();
  return rawSlots.map((slot) => {
    const loc = slot.locations as { name: string | null; logo_url: string | null } | null;
    const c = counts[slot.id as string] || { confirmed: 0, pending: 0, players: [] };
    const trainerId = (slot.trainer_id as string) || null;
    return {
      id: slot.id as string,
      start_time: slot.start_time as string,
      end_time: slot.end_time as string,
      trainer_id: trainerId,
      trainer_name: resolveTrainerNames && trainerId ? trainerNames[trainerId] ?? null : null,
      location_name: loc?.name ?? null,
      location_logo: loc?.logo_url ?? null,
      cyclus_name: (slot.cyclus_name as string) || null,
      max_participants: getSlotCapacity(slot as { max_participants?: number | null }),
      active_bookings: c.confirmed,
      pending_bookings: c.pending,
      booked_players: c.players,
      is_past: new Date(slot.end_time as string).getTime() < now,
      has_report: reported.has(slot.id as string),
    };
  });
}

export async function fetchTrainerAgenda(userId: string, fromISO: string, toISO: string): Promise<AgendaSlot[]> {
  const { data: tp } = await supabase
    .from('trainer_profiles')
    .select('id')
    .eq('user_id', userId)
    .single();
  if (!tp) return [];
  const { data: slots, error } = await supabase
    .from('availability_slots')
    .select(SLOT_SELECT)
    .eq('trainer_id', (tp as { id: string }).id)
    .gte('start_time', fromISO)
    .lte('start_time', toISO)
    .order('start_time');
  if (error) throw error;
  return enrichSlots((slots ?? []) as Array<Record<string, unknown>>, false);
}

export async function fetchAcademyAgenda(
  academyProfileId: string,
  fromISO: string,
  toISO: string,
  trainerFilterId?: string | null,
): Promise<AgendaSlot[]> {
  const { data: ats } = await supabase
    .from('academy_trainers')
    .select('trainer_profile_id')
    .eq('academy_profile_id', academyProfileId)
    .eq('status', 'active');
  let trainerIds = (ats ?? []).map((a) => (a as { trainer_profile_id: string }).trainer_profile_id);
  if (trainerFilterId) trainerIds = trainerIds.filter((id) => id === trainerFilterId);
  if (trainerIds.length === 0) return [];
  const { data: slots, error } = await supabase
    .from('availability_slots')
    .select(SLOT_SELECT)
    .in('trainer_id', trainerIds)
    .gte('start_time', fromISO)
    .lte('start_time', toISO)
    .order('start_time');
  if (error) throw error;
  return enrichSlots((slots ?? []) as Array<Record<string, unknown>>, true);
}

export function useTrainerAgenda(userId: string | undefined, fromISO: string, toISO: string) {
  return useQuery({
    queryKey: ['trainer-agenda', userId, fromISO, toISO],
    queryFn: () => fetchTrainerAgenda(userId!, fromISO, toISO),
    enabled: Boolean(userId),
    placeholderData: keepPreviousData,
  });
}

export function useAcademyAgenda(
  academyProfileId: string | undefined | null,
  fromISO: string,
  toISO: string,
  trainerFilterId?: string | null,
) {
  return useQuery({
    queryKey: ['academy-agenda', academyProfileId, fromISO, toISO, trainerFilterId ?? null],
    queryFn: () => fetchAcademyAgenda(academyProfileId!, fromISO, toISO, trainerFilterId),
    enabled: Boolean(academyProfileId),
    placeholderData: keepPreviousData,
  });
}
