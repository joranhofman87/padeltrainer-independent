/**
 * Player self-notes — a player's own reflections on a past session
 * (session_player_notes, author_role 'player', subject = self). Per-note
 * private/share toggle (private = player only; shared = trainer + academy can
 * see). RLS enforces it. Mutations invalidate the journey so the timeline
 * refreshes (own_notes are embedded in the journey RPC rows).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

const invalidateJourney = (qc: ReturnType<typeof useQueryClient>) =>
  qc.invalidateQueries({ queryKey: ['player-journey'] });

export function useCreateSelfNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      slotId: string;
      authorId: string;        // current user's auth uid
      profileId: string;       // the player's own profile id (subject)
      visibility: 'private' | 'shared';
      body: string;
    }) => {
      const { error } = await supabase.from('session_player_notes').insert({
        slot_id: input.slotId,
        author_id: input.authorId,
        author_role: 'player',
        subject_profile_id: input.profileId,
        visibility: input.visibility,
        body: input.body,
      });
      if (error) throw error;
    },
    onSuccess: () => invalidateJourney(qc),
  });
}

export function useUpdateSelfNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; body?: string; visibility?: 'private' | 'shared' }) => {
      const patch: Record<string, unknown> = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.visibility !== undefined) patch.visibility = input.visibility;
      const { error } = await supabase.from('session_player_notes').update(patch).eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => invalidateJourney(qc),
  });
}

export function useDeleteSelfNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('session_player_notes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => invalidateJourney(qc),
  });
}
