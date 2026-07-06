/**
 * session_reports helpers shared by the player report widget
 * (PlayerSessionReport) and the dashboard "Action Required" card
 * (PendingAttendanceCard / TrainerReportForm).
 *
 * The table has a UNIQUE (slot_id, reporter_id) constraint, so each person can
 * file at most one report per slot. upsertSessionReport does a
 * check-then-update/insert (matching on reporter_role too) so every report
 * surface converges on that single row instead of erroring on a blind insert
 * when a report already exists (e.g. the player reported from the bookings page
 * while the dashboard card was loaded).
 *
 * Note: the player's free-text reflection no longer lives here — it is written
 * to session_player_notes via playerSelfNotes.ts (the same store the journey
 * uses, which carries the private/shared visibility toggle). session_reports
 * holds only the attendance fact (session_happened).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { isMissingRelation, reportDeployDriftFallback } from '@/lib/deployDrift';
import { logger } from '@/lib/logger';

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

interface TrainerSummaryRow {
  slot_id: string;
  public_notes: string | null;
  created_at: string | null;
}

/**
 * The trainer's player-visible session summaries for a set of slots, keyed by slot id.
 *
 * Reads the player-safe `session_reports_player_summaries` view (migration 20260713100000)
 * — the base-table player policy no longer exposes trainer rows, because the row carried the
 * PRIVATE `notes` column too. Until the migration is applied in prod the view is missing and
 * this falls back to the legacy base-table read (which the old policy still allows), with
 * deploy-drift telemetry so the unapplied migration is visible.
 *
 * A slot can hold reports from two different trainers (slot reassigned between trainers —
 * UNIQUE is (slot_id, reporter_id)); the newest report wins instead of erroring the way the
 * old `.maybeSingle()` did.
 *
 * Never throws: the summary is decorative next to the player's own attendance answer, so a
 * failed read degrades to "no summary" instead of erroring the whole widget/list.
 */
export async function fetchTrainerSlotSummaries(slotIds: string[]): Promise<Map<string, string>> {
  const summaries = new Map<string, string>();
  if (slotIds.length === 0) return summaries;

  let rows: TrainerSummaryRow[] | null = null;
  const { data, error } = await supabase
    .from('session_reports_player_summaries' as never)
    .select('slot_id, public_notes, created_at')
    .in('slot_id', slotIds)
    .order('created_at', { ascending: false });
  if (error) {
    if (!isMissingRelation(error)) {
      logger.warn('Trainer summary read failed', { code: error.code, slotCount: slotIds.length });
      return summaries;
    }
    reportDeployDriftFallback('session_reports_player_summaries', { slotCount: slotIds.length });
    const { data: legacy, error: legacyError } = await supabase
      .from('session_reports')
      .select('slot_id, public_notes, created_at')
      .in('slot_id', slotIds)
      .eq('reporter_role', 'trainer')
      .order('created_at', { ascending: false });
    if (legacyError) {
      logger.warn('Trainer summary fallback read failed', { code: legacyError.code, slotCount: slotIds.length });
      return summaries;
    }
    rows = legacy as TrainerSummaryRow[] | null;
  } else {
    rows = data as unknown as TrainerSummaryRow[] | null;
  }

  // Rows are newest-first; first non-empty summary per slot wins.
  for (const row of rows ?? []) {
    if (row.public_notes && !summaries.has(row.slot_id)) summaries.set(row.slot_id, row.public_notes);
  }
  return summaries;
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
      const [{ data: own }, summaries] = await Promise.all([
        supabase
          .from('session_reports')
          .select('id, session_happened')
          .eq('slot_id', slotId)
          .eq('reporter_id', profileId!)
          .eq('reporter_role', 'player')
          .maybeSingle(),
        fetchTrainerSlotSummaries([slotId]),
      ]);
      return {
        reportId: own?.id ?? null,
        sessionHappened: own ? own.session_happened : null,
        trainerSummary: summaries.get(slotId) ?? null,
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
