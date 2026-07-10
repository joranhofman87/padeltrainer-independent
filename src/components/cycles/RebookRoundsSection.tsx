import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CalendarClock, RefreshCw, Settings2, Archive, ArchiveRestore, Loader2 } from 'lucide-react';
import { formatDate } from '@/lib/format';
import { listRebookRounds, setRebookRoundArchived, type RebookRound } from '@/lib/rebookManage';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { logger } from '@/lib/logger';

/**
 * Discovery entry point for the per-cycle rebook management view. Rebooked "new
 * round" cycles are type='cyclus', so they never appear in the registration/event
 * list — without this an academy can only reach a round's overview via the one-time
 * post-launch redirect. Finished rounds can be archived (hidden from the active list
 * without touching any bookings). Renders nothing when the academy has no rounds.
 */
export default function RebookRoundsSection({ academyId }: { academyId: string }) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const [rounds, setRounds] = useState<RebookRound[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => {
    let active = true;
    listRebookRounds(academyId, { includeArchived: true })
      .then((r) => { if (active) setRounds(r); })
      .catch((e) => logger.error('Failed to load rebook rounds', e as Error, { component: 'RebookRoundsSection' }))
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [academyId]);

  useEffect(() => reload(), [reload]);

  const setArchived = async (id: string, archived: boolean) => {
    setBusyId(id);
    try {
      await setRebookRoundArchived(id, archived);
      setRounds((prev) => prev.map((r) => (r.id === id ? { ...r, archived } : r)));
      toast.success(archived
        ? t('rebookManage.roundArchived', 'Herboeking gearchiveerd')
        : t('rebookManage.roundRestored', 'Herboeking hersteld'));
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookManage.roundArchiveFailed', 'Kon de herboeking niet bijwerken. Probeer het opnieuw.')));
    } finally { setBusyId(null); }
  };

  if (!loaded || rounds.length === 0) return null;

  const active = rounds.filter((r) => !r.archived);
  const archived = rounds.filter((r) => r.archived);

  const row = (r: RebookRound) => (
    <div
      key={r.id}
      className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <div className="truncate font-medium">{r.name || t('rebookManage.untitledRound', 'Herboeking')}</div>
        {r.startDate && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <CalendarClock className="h-3 w-3" />
            {/* start_date is a pure DATE — parse at local noon so it never shifts a day */}
            {t('rebookManage.roundStarts', 'Start {{date}}', { date: formatDate(`${r.startDate}T12:00:00`, 'd MMM yyyy') })}
          </div>
        )}
        {r.cycleIds.length > 1 && (
          <div className="text-xs text-muted-foreground">
            {t('rebookManage.roundCycleCount', '{{count}} cycli in deze ronde', { count: r.cycleIds.length })}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => navigate(`/app/academy/cycles/${r.id}/rebook`)}>
          <Settings2 className="h-4 w-4" />
          {t('actions.manageRebooking', 'Beheer herboeking')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busyId === r.id}
          onClick={() => setArchived(r.id, !r.archived)}
          title={r.archived ? t('rebookManage.restoreRound', 'Herstellen') : t('rebookManage.archiveRound', 'Archiveren')}
          aria-label={r.archived ? t('rebookManage.restoreRound', 'Herstellen') : t('rebookManage.archiveRound', 'Archiveren')}
        >
          {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : r.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="h-4 w-4" />
          {t('rebookManage.roundsTitle', 'Herboekingen')}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('rebookManage.roundsDescription', 'Beheer een lopende herboeking: wie reageerde, wie betaalde en welke plekken open staan.')}
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {active.length === 0 && !showArchived && (
          <p className="text-sm text-muted-foreground">{t('rebookManage.noActiveRounds', 'Geen lopende herboekingen.')}</p>
        )}
        {active.map(row)}

        {archived.length > 0 && (
          <div className="pt-1">
            <Button variant="link" size="sm" className="h-auto p-0 text-sm" onClick={() => setShowArchived((v) => !v)}>
              {showArchived
                ? t('rebookManage.hideArchived', 'Verberg gearchiveerd')
                : t('rebookManage.showArchived', 'Toon gearchiveerd ({{count}})', { count: archived.length })}
            </Button>
            {showArchived && <div className="mt-2 space-y-2 opacity-70">{archived.map(row)}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
