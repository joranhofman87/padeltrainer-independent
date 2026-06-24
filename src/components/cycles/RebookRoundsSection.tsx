import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CalendarClock, RefreshCw, Settings2 } from 'lucide-react';
import { formatDate } from '@/lib/format';
import { listRebookRounds, type RebookRound } from '@/lib/rebookManage';
import { logger } from '@/lib/logger';

/**
 * Discovery entry point for the per-cycle rebook management view. Rebooked "new
 * round" cycles are type='cyclus', so they never appear in the registration/event
 * list — without this an academy can only reach a round's overview via the one-time
 * post-launch redirect. Renders nothing when the academy has no rebook rounds.
 */
export default function RebookRoundsSection({ academyId }: { academyId: string }) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  const [rounds, setRounds] = useState<RebookRound[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    listRebookRounds(academyId)
      .then((r) => { if (active) setRounds(r); })
      .catch((e) => logger.error('Failed to load rebook rounds', e as Error, { component: 'RebookRoundsSection' }))
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [academyId]);

  if (!loaded || rounds.length === 0) return null;

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
        {rounds.map((r) => (
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
            </div>
            <Button size="sm" variant="outline" onClick={() => navigate(`/app/academy/cycles/${r.id}/rebook`)}>
              <Settings2 className="h-4 w-4" />
              {t('actions.manageRebooking', 'Beheer herboeking')}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
