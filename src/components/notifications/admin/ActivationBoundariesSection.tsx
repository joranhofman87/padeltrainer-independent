import { useTranslation } from 'react-i18next';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ListPageState } from '@/components/ui/list-page-shell';
import { EmptyState } from '@/components/ui/empty-state';
import { Route } from 'lucide-react';
import type { BoundaryRow } from './types';

/**
 * N5 — the DELIVERY PATHS: which are open, since when, and what each one's boundary is holding
 * back. Three rows by construction, so this is a plain read (no cursor list) rendered on the
 * shared table engine.
 *
 * Opening a path is deliberately NOT here: it is an owner-gated runbook act performed by the
 * rollout artifacts, and a button that starts sending on a path is exactly the control this
 * surface must not offer. What IS here is the disposal — the only sanctioned exit for the work
 * the boundary has made permanently ineligible, and its only effect is pending -> skipped.
 */
export function ActivationBoundariesSection({
  rows, isLoading, isError, onRetry, onDispose,
}: {
  rows?: BoundaryRow[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onDispose: (row: BoundaryRow) => void;
}) {
  const { t } = useTranslation('admin');

  const columns: ColumnDef<BoundaryRow & { id: string }>[] = [
    {
      key: 'path', header: t('notifOps.path', 'Delivery path'), className: 'whitespace-nowrap',
      renderCell: (r) => <span className="font-medium">{r.path}</span>,
    },
    {
      key: 'state', header: t('notifOps.state', 'State'), className: 'whitespace-nowrap',
      renderCell: (r) => (r.state === 'active'
        ? <Badge variant="default">{t('notifOps.pathOpen', 'open')}</Badge>
        : <Badge variant="secondary">{t('notifOps.pathInert', 'inert — sends nothing')}</Badge>),
    },
    {
      key: 'since', header: t('notifOps.boundary', 'Eligible from'), className: 'max-w-[220px]',
      cellTitle: (r) => r.boundary_at ?? undefined,
      // an inert path has no boundary — render the absence, never a blank cell that reads as a date
      renderCell: (r) => <span className="block truncate">{r.boundary_at ?? '—'}</span>,
    },
    {
      key: 'backlog', header: t('notifOps.heldBack', 'Held back'), className: 'whitespace-nowrap',
      renderCell: (r) => (r.pending_before_boundary > 0
        ? (
          <Badge variant="destructive" data-testid={`backlog-${r.path}`}>
            {r.pending_before_boundary_capped
              ? t('notifOps.atLeastN', { defaultValue: 'at least {{n}}', n: r.pending_before_boundary })
              : r.pending_before_boundary}
          </Badge>
        )
        : <span className="text-muted-foreground">0</span>),
    },
    {
      // the OTHER clock. A row can be perfectly post-boundary and still report an event too old to
      // send — the replay shape. Without this column an operator asking "why has this not gone
      // out?" has no answer on the screen.
      key: 'tooOld', header: t('notifOps.eventTooOld', 'Event too old'), className: 'whitespace-nowrap',
      cellTitle: (r) => (r.max_event_age_minutes
        ? t('notifOps.ceilingTitle', {
          defaultValue: 'Events older than {{days}} days are never sent on this path',
          days: Math.round(r.max_event_age_minutes / 1440),
        })
        : undefined),
      renderCell: (r) => (r.pending_before_occurrence_floor > 0
        ? (
          <Badge variant="destructive" data-testid={`tooold-${r.path}`}>
            {r.pending_before_occurrence_floor_capped
              ? t('notifOps.atLeastN', { defaultValue: 'at least {{n}}', n: r.pending_before_occurrence_floor })
              : r.pending_before_occurrence_floor}
          </Badge>
        )
        : <span className="text-muted-foreground">0</span>),
    },
  ];

  return (
    <section aria-label="delivery paths" data-testid="section-boundaries">
      <h2 className="font-medium">{t('notifOps.paths', 'Delivery paths')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('notifOps.pathsDesc', 'A path sends nothing until it is opened, and then only events that happened after that moment. Two things are held back permanently: messages queued before the path opened, and messages for events older than the path\'s age limit. Neither can ever send — dispose of them so the queue reflects reality.')}
      </p>
      <ListPageState
        isLoading={isLoading}
        error={isError ? (
          <span>
            {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'delivery paths' })}
            <Button size="sm" variant="outline" className="ml-2" onClick={onRetry} data-testid="boundaries-retry">
              {t('notifOps.retry', 'Retry')}
            </Button>
          </span>
        ) : undefined}
        isEmpty={(rows?.length ?? 0) === 0 && !isLoading && !isError}
        empty={(
          <EmptyState
            icon={Route}
            title={t('notifOps.noPaths', 'No delivery paths recorded')}
            description={t('notifOps.noPathsDesc', 'The activation-boundary migration has not been applied — the send authorities are gating on nothing.')}
          />
        )}
      >
        {rows ? (
          <div data-testid="boundaries">
            <DataTable<BoundaryRow & { id: string }>
              columns={columns}
              rows={rows.map((r) => ({ ...r, id: r.path }))}
              renderActions={(r) => (r.state === 'active' && r.pending_before_boundary > 0 ? (
                <Button size="sm" variant="outline" onClick={() => onDispose(r)} data-testid={`dispose-${r.path}`}>
                  {t('notifOps.dispose', 'Dispose backlog…')}
                </Button>
              ) : null)}
              compact
              desktopOnly={false}
              empty={t('notifOps.noPaths', 'No delivery paths recorded')}
            />
          </div>
        ) : null}
      </ListPageState>
    </section>
  );
}
