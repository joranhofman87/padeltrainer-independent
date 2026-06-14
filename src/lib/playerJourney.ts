/**
 * Player "My Journey" — paginated timeline of past sessions with the trainer's
 * shared feedback, the player's own notes, attendance and the per-session rating
 * snapshot. Reads the get_player_journey RPC (mirror of playersOverview.ts:
 * total_count + keepPreviousData). Player self-notes are written via
 * playerSelfNotes.ts; the trainer's coaching notes are read-only here.
 */
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import type { Database } from '@/integrations/supabase/types';

export type JourneyRow = Database['public']['Functions']['get_player_journey']['Returns'][number];

export interface SharedCoachingNote {
  id: string;
  author_role: 'trainer' | 'academy';
  body: string;
  media: unknown | null;
  created_at: string;
}
export interface OwnNote {
  id: string;
  visibility: 'private' | 'shared';
  body: string;
  created_at: string;
}

/** Typed accessors for the RPC's jsonb columns (generator types them as Json). */
export function sharedCoachingNotes(row: JourneyRow): SharedCoachingNote[] {
  return Array.isArray(row.shared_coaching_notes) ? (row.shared_coaching_notes as unknown as SharedCoachingNote[]) : [];
}
export function ownNotes(row: JourneyRow): OwnNote[] {
  return Array.isArray(row.own_notes) ? (row.own_notes as unknown as OwnNote[]) : [];
}

export const JOURNEY_PAGE_SIZE = 20;

export async function fetchPlayerJourney(
  profileId: string,
  page = 0,
  pageSize = JOURNEY_PAGE_SIZE,
): Promise<{ rows: JourneyRow[]; total: number }> {
  const { data, error } = await supabase.rpc('get_player_journey', {
    p_profile_id: profileId,
    p_limit: pageSize,
    p_offset: page * pageSize,
  });
  if (error) throw error;
  const rows = (data ?? []) as JourneyRow[];
  return { rows, total: Number(rows[0]?.total_count ?? 0) };
}

export function usePlayerJourney(profileId: string | undefined | null, page: number, pageSize = JOURNEY_PAGE_SIZE) {
  return useQuery({
    queryKey: ['player-journey', profileId, page, pageSize],
    queryFn: () => fetchPlayerJourney(profileId!, page, pageSize),
    enabled: Boolean(profileId),
    placeholderData: keepPreviousData,
  });
}

/** Mark shared coaching notes as seen (clears the in-app "new feedback" indicator). */
export function useMarkFeedbackSeen(profileId: string | undefined | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (noteIds: string[]) => {
      if (!profileId || noteIds.length === 0) return;
      const { error } = await supabase
        .from('coaching_note_views')
        .upsert(noteIds.map((note_id) => ({ profile_id: profileId, note_id })), {
          onConflict: 'profile_id,note_id',
          ignoreDuplicates: true,
        });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['unseen-feedback', profileId] }),
  });
}

export function useUnseenFeedbackCount(profileId: string | undefined | null) {
  return useQuery({
    queryKey: ['unseen-feedback', profileId],
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc('get_unseen_shared_feedback_count', { p_profile_id: profileId! });
      if (error) throw error;
      return Number(data ?? 0);
    },
    enabled: Boolean(profileId),
  });
}
