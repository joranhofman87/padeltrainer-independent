/**
 * Per-player coaching notes (session_player_notes, author_role trainer|academy).
 * RLS scopes reads/writes; the editor lives on the trainer/academy slot-detail
 * pages. Player self-notes (author_role 'player') are handled separately on the
 * player "My Journey" page.
 */
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import type { Database } from '@/integrations/supabase/types';

export type CoachingNote = Database['public']['Tables']['session_player_notes']['Row'];
export type NoteAuthorRole = 'trainer' | 'academy';

/** All coaching notes on a slot the current user may see (RLS-scoped). */
export function usePlayerCoachingNotes(slotId: string | undefined) {
  return useQuery({
    queryKey: ['coaching-notes', slotId],
    queryFn: async (): Promise<CoachingNote[]> => {
      const { data, error } = await supabase
        .from('session_player_notes')
        .select('*')
        .eq('slot_id', slotId!)
        .in('author_role', ['trainer', 'academy'])
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as CoachingNote[];
    },
    enabled: Boolean(slotId),
    placeholderData: keepPreviousData,
  });
}

export interface CreateCoachingNoteInput {
  slotId: string;
  authorId: string;              // current user's auth uid (RLS WITH CHECK: author_id = auth.uid())
  authorRole: NoteAuthorRole;
  subjectProfileId?: string | null;
  subjectGuestPlayerId?: string | null;
  visibility: 'private' | 'shared';
  body: string;
}

export function useCreateCoachingNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCoachingNoteInput) => {
      const { error } = await supabase.from('session_player_notes').insert({
        slot_id: input.slotId,
        author_id: input.authorId,
        author_role: input.authorRole,
        subject_profile_id: input.subjectProfileId ?? null,
        subject_guest_player_id: input.subjectGuestPlayerId ?? null,
        visibility: input.visibility,
        body: input.body,
      });
      if (error) throw error;
    },
    onSuccess: (_d, input) => qc.invalidateQueries({ queryKey: ['coaching-notes', input.slotId] }),
  });
}

export function useUpdateCoachingNote(slotId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; body?: string; visibility?: 'private' | 'shared' }) => {
      const patch: Record<string, unknown> = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.visibility !== undefined) patch.visibility = input.visibility;
      const { error } = await supabase.from('session_player_notes').update(patch).eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coaching-notes', slotId] }),
  });
}

export function useDeleteCoachingNote(slotId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('session_player_notes').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coaching-notes', slotId] }),
  });
}
