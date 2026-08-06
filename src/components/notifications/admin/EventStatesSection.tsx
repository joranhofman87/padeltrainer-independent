import { useTranslation } from 'react-i18next';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageState } from '@/components/ui/list-page-shell';
import { ListChecks } from 'lucide-react';
import type { EventStateRow } from './types';

type Row = EventStateRow & { id: string };

/** Per event × channel, every authority its own column — including the circuit TRIP IDENTITY
 *  the reset confirmation submits (visible == submitted) and the unverifiable env column. */
export function EventStatesSection({
  rows, isLoading, isError, onRetry, onResetCircuit,
}: {
  rows?: EventStateRow[]; isLoading: boolean; isError: boolean; onRetry: () => void;
  onResetCircuit: (row: EventStateRow) => void;
}) {
  const { t } = useTranslation('admin');
  const tableRows: Row[] = (rows ?? []).map((r) => ({ ...r, id: `${r.event_type}:${r.channel}` }));

  const columns: ColumnDef<Row>[] = [
    {
      key: 'event', header: t('notifOps.event', 'Event'), className: 'max-w-[220px]',
      cellTitle: (r) => r.event_type,
      renderCell: (r) => <span className="block truncate">{r.event_type}</span>,
    },
    { key: 'channel', header: t('notifOps.channel', 'Channel'), className: 'whitespace-nowrap', renderCell: (r) => r.channel },
    {
      key: 'catalog', header: t('notifOps.catalog', 'Catalog'), className: 'max-w-[160px] whitespace-nowrap',
      cellTitle: (r) => (r.catalog_supported ? r.catalog_default : 'unsupported'),
      renderCell: (r) => <span className="block truncate">{r.catalog_supported ? r.catalog_default : t('notifOps.unsupported', 'unsupported')}{r.required_delivery ? ' · required' : ''}</span>,
    },
    { key: 'caps', header: t('notifOps.caps', 'Caps'), className: 'whitespace-nowrap', renderCell: (r) => String(r.academy_off_caps) },
    { key: 'cron', header: t('notifOps.cron', 'Cron'), className: 'whitespace-nowrap', renderCell: (r) => r.cron_state },
    {
      key: 'circuit', header: t('notifOps.circuit', 'Circuit'), className: 'max-w-[260px]',
      cellTitle: (r) => `${r.circuit_state}${r.circuit_reason ? ` · ${r.circuit_reason}` : ''}${r.circuit_tripped_at ? ` · ${r.circuit_tripped_at}` : ''}`,
      renderCell: (r) => (
        <span className="block truncate" data-testid={`circuit-detail-${r.channel}`}>
          {r.circuit_state}
          {['open', 'half_open'].includes(r.circuit_state) ? ` · ${r.circuit_reason ?? '—'} · ${r.circuit_tripped_at ?? '—'}` : ''}
        </span>
      ),
    },
    { key: 'kill', header: t('notifOps.kill', 'Kill'), className: 'whitespace-nowrap', renderCell: (r) => r.kill_state },
    { key: 'env', header: t('notifOps.env', 'Env'), className: 'whitespace-nowrap', renderCell: (r) => r.send_env },
    { key: 'instant', header: t('notifOps.instant', 'Instant'), className: 'whitespace-nowrap', renderCell: (r) => r.instant_conclusion },
    { key: 'digest', header: t('notifOps.digest', 'Digest'), className: 'whitespace-nowrap', renderCell: (r) => r.digest_conclusion },
  ];

  return (
    <section aria-label="event states" data-testid="section-event-states">
      <h2 className="font-medium">{t('notifOps.eventStates', 'Event states')}</h2>
      <ListPageState
        isLoading={isLoading}
        error={isError ? (
          <span>
            {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'event states' })}
            <Button size="sm" variant="outline" className="ml-2" onClick={onRetry} data-testid="event-states-retry">
              {t('notifOps.retry', 'Retry')}
            </Button>
          </span>
        ) : undefined}
        isEmpty={(rows?.length ?? 0) === 0 && !isLoading && !isError}
        empty={<EmptyState icon={ListChecks} title={t('notifOps.noEvents', 'No events in the catalog')} description={t('notifOps.noEventsDesc', 'The notification event catalog is empty.')} />}
      >
        {rows ? (
          <div data-testid="event-states">
            <DataTable<Row>
              columns={columns}
              rows={tableRows}
              renderActions={(r) => (['open', 'half_open'].includes(r.circuit_state) ? (
                <Button size="sm" variant="outline" onClick={() => onResetCircuit(r)} data-testid={`reset-btn-${r.channel}`}>
                  {t('notifOps.reset', 'Reset…')}
                </Button>
              ) : null)}
              compact
              desktopOnly={false}
              empty={t('notifOps.noEvents', 'No events in the catalog')}
            />
          </div>
        ) : null}
      </ListPageState>
    </section>
  );
}
