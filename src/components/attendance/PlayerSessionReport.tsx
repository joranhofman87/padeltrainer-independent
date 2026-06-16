import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ClipboardCheck, CheckCircle2, XCircle, Check, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PlayerSelfNoteEditor } from '@/components/player/PlayerSelfNoteEditor';
import { useSlotOwnNotes } from '@/lib/playerSelfNotes';
import { useSlotPlayerReport, usePlayerReportAttendance } from '@/lib/sessionReports';

/**
 * The player's per-session report: a "Did the training happen?" Yes/No choice
 * (written to session_reports) plus the same self-note editor used on the
 * journey (written to session_player_notes, with the private/share toggle).
 * Used under each past booking (PlayerBookings) and in the dashboard
 * "Action Required" card (PendingAttendanceCard).
 */
export function PlayerSessionReport({
  slotId,
  trainerSummary: trainerSummaryProp,
  onDone,
  className,
}: {
  slotId: string;
  /** the trainer's public summary, when the caller already has it (dashboard) */
  trainerSummary?: string | null;
  /** when provided, renders a "Done" button (enabled once an answer is given) */
  onDone?: () => void;
  className?: string;
}) {
  const { t } = useTranslation('player');
  const { user, profile } = useAuth();
  const { toast } = useToast();
  const profileId = profile?.id;
  const authorId = user?.id; // session_player_notes.author_id is the auth uid

  const { data: report } = useSlotPlayerReport(slotId, profileId);
  const { data: ownNotes = [] } = useSlotOwnNotes(slotId, profileId);
  const reportAttendance = usePlayerReportAttendance();
  // optimistic answer so the highlight + Done-enable are instant, before refetch
  const [optimistic, setOptimistic] = useState<boolean | null>(null);

  if (!profileId || !authorId) return null;

  const sessionHappened = optimistic ?? report?.sessionHappened ?? null;
  const trainerSummary = trainerSummaryProp ?? report?.trainerSummary ?? null;

  const choose = (value: boolean) => {
    if (reportAttendance.isPending || sessionHappened === value) return;
    setOptimistic(value);
    reportAttendance.mutate(
      { slotId, reporterId: profileId, sessionHappened: value },
      {
        onError: () => {
          setOptimistic(null);
          toast({ title: t('attendance.saveError', 'Failed to save'), variant: 'destructive' });
        },
      },
    );
  };

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ClipboardCheck className="h-3.5 w-3.5" />
          {t('attendance.title', 'Attendance')}
        </span>
        {sessionHappened !== null && (
          <Badge
            variant="outline"
            className="h-5 gap-0.5 border-emerald-300 px-1.5 text-[10px] text-emerald-600 dark:border-emerald-800 dark:text-emerald-400"
          >
            <Check className="h-2.5 w-2.5" />
            {t('attendance.reported', 'Reported')}
          </Badge>
        )}
      </div>

      {/* Trainer's session summary (read-only) */}
      {trainerSummary && (
        <div className="rounded-md bg-muted/50 p-2.5 text-xs">
          <div className="mb-1 flex items-center gap-1.5 text-muted-foreground">
            <Eye className="h-3 w-3" />
            <span className="font-medium">{t('attendance.sessionSummary', 'Session summary')}</span>
          </div>
          <p className="text-foreground">{trainerSummary}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <p className="text-sm font-medium">{t('attendance.didTrainingHappen', 'Did the training happen?')}</p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => choose(true)}
            disabled={reportAttendance.isPending}
            aria-pressed={sessionHappened === true}
            className={cn(
              'gap-1.5 border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800',
              'dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-200',
              sessionHappened === true &&
                'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-600 hover:text-white dark:border-emerald-600 dark:bg-emerald-600 dark:text-white dark:hover:bg-emerald-600 dark:hover:text-white',
            )}
          >
            <CheckCircle2 className="h-4 w-4" />
            {t('attendance.yes', 'Yes')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => choose(false)}
            disabled={reportAttendance.isPending}
            aria-pressed={sessionHappened === false}
            className={cn(
              'gap-1.5 border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800',
              'dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300',
              sessionHappened === false &&
                'border-red-600 bg-red-600 text-white hover:bg-red-600 hover:text-white dark:border-red-600 dark:bg-red-600 dark:text-white dark:hover:bg-red-600 dark:hover:text-white',
            )}
          >
            <XCircle className="h-4 w-4" />
            {t('attendance.no', 'No')}
          </Button>
        </div>
      </div>

      {/* Notes — the same editor as the journey, with the share-with-coach toggle */}
      <PlayerSelfNoteEditor slotId={slotId} authorId={authorId} profileId={profileId} notes={ownNotes} />

      {onDone && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          disabled={sessionHappened === null}
          onClick={onDone}
        >
          {t('pendingAttendance.done', 'Done')}
        </Button>
      )}
    </div>
  );
}
