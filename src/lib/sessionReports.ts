/**
 * session_reports helpers shared by the player report widget
 * (PlayerSessionReport) and the dashboard "Action Required" card
 * (PendingAttendanceCard / TrainerReportForm).
 *
 * The table has no unique constraint, so a blind insert can create a DUPLICATE
 * row when a report already exists (e.g. the player reported from the bookings
 * page while the dashboard card was loaded). upsertSessionReport does a
 * check-then-update/insert so every report surface converges on a single row.
 *
 * Note: the player's free-text reflection no longer lives here — it is written
 * to session_player_notes via playerSelfNotes.ts (the same store the journey
 * uses, which carries the private/shared visibility toggle). session_reports
 * holds only the attendance fact (session_happened).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

export async function upsertSessionReport(payload: {
  slot_id: string;
  reporter_id: string;
  reporter_role: 'trainer' | 'player';
  session_happened: boolean;
  attendees: string[];
  public_notes?: string | null;
  notes: string | null;
}) {
  const { data: existing } = await supabase
    .from('session_reports')
    .select('id')
    .eq('slot_id', payload.slot_id)
    .eq('reporter_id', payload.reporter_id)
    .eq('reporter_role', payload.reporter_role)
    .maybeSingle();
  if (existing?.id) {
    return supabase.from('session_reports').update(payload).eq('id', existing.id);
  }
  return supabase.from('session_reports').insert(payload);
}

export interface SlotPlayerReport {
  /** id of the player's own session_reports row, null if not yet reported */
  reportId: string | null;
  /** the player's attendance answer; null until they pick Yes/No */
  sessionHappened: boolean | null;
  /** the trainer's public session summary, read-only for the player */
  trainerSummary: string | null;
}

/** The player's own attendance report + the trainer's public summary for a slot. */
export function useSlotPlayerReport(slotId: string, profileId?: string | null) {
  return useQuery({
    queryKey: ['slot-player-report', slotId, profileId],
    enabled: Boolean(profileId),
    staleTime: 60_000,
    queryFn: async (): Promise<SlotPlayerReport> => {
      const [{ data: own }, { data: trainer }] = await Promise.all([
        supabase
          .from('session_reports')
          .select('id, session_happened')
          .eq('slot_id', slotId)
          .eq('reporter_id', profileId!)
          .eq('reporter_role', 'player')
          .maybeSingle(),
        supabase
          .from('session_reports')
          .select('public_notes')
          .eq('slot_id', slotId)
          .eq('reporter_role', 'trainer')
          .maybeSingle(),
      ]);
      return {
        reportId: own?.id ?? null,
        sessionHappened: own ? own.session_happened : null,
        trainerSummary: trainer?.public_notes ?? null,
      };
    },
  });
}

/**
 * Record (or correct) a player's "did the training happen?" answer.
 * Invalidates the per-slot report and the journey (whose badge reads this), but
 * NOT the dashboard pending list — that would yank the form out from under the
 * player before they can add a note. The dashboard clears the slot on "Done".
 */
export function usePlayerReportAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { slotId: string; reporterId: string; sessionHappened: boolean }) => {
      const { error } = await upsertSessionReport({
        slot_id: input.slotId,
        reporter_id: input.reporterId,
        reporter_role: 'player',
        session_happened: input.sessionHappened,
        attendees: [],
        notes: null,
      });
      if (error) throw error;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['slot-player-report', vars.slotId] });
      qc.invalidateQueries({ queryKey: ['player-journey'] });
    },
  });
}
