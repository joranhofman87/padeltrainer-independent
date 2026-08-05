import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ListPageState } from '@/components/ui/list-page-shell';
import { CHANNELS, type Channel, type GaugeRow } from './types';

/** Per-channel kill state + the ONE-WAY kill control (no clear exists on this surface). */
export function ChannelKillPanel({
  gauges, isLoading, isError, onRetry, onKill,
}: { gauges?: GaugeRow[]; isLoading: boolean; isError: boolean; onRetry: () => void; onKill: (channel: Channel) => void }) {
  const { t } = useTranslation('admin');
  return (
    <section aria-label="kill switches" data-testid="section-kills">
      <h2 className="font-medium">{t('notifOps.kills', 'Kill switches')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('notifOps.killOneWay', 'Killing a channel is ONE-WAY from this page. Clearing a kill re-opens live sending and is deliberately not offered here — it is an owner runbook operation.')}
      </p>
      <ListPageState
        isLoading={isLoading}
        error={isError ? (
          <span>
            {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'kill state' })}
            <Button size="sm" variant="outline" className="ml-2" onClick={onRetry} data-testid="kills-retry">
              {t('notifOps.retry', 'Retry')}
            </Button>
          </span>
        ) : undefined}
      >
        {gauges ? (
          <div className="flex flex-wrap gap-4" data-testid="kill-switches">
            {CHANNELS.map((ch) => {
              // FAIL-CLOSED: a MISSING gauge row is not 'live' — it is UNKNOWN. Treating an
              // absent/incomplete response as live would show a kill button (and imply the
              // channel is sending) on a state nobody actually read.
              const row = gauges.find((g) => g.metric === 'channel_killed' && g.channel === ch);
              const known = row !== undefined;
              const killed = known && Number(row.value) > 0;
              return (
                <div key={ch} className="rounded-md border p-3" data-testid={`kill-${ch}`}
                  data-killed={known ? killed : 'unknown'}>
                  <p className="font-medium">{ch}</p>
                  <p className="text-sm">
                    {!known
                      ? t('notifOps.stateUnknown', 'UNKNOWN — this channel’s state was not returned')
                      : killed ? t('notifOps.stateKilled', 'KILLED') : t('notifOps.stateLive', 'live')}
                  </p>
                  {known && !killed && (
                    <Button size="sm" variant="destructive" onClick={() => onKill(ch)} data-testid={`kill-btn-${ch}`}>
                      {t('notifOps.killNow', 'Kill channel')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </ListPageState>
    </section>
  );
}
