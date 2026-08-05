import { useTranslation } from 'react-i18next';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OpsSection } from './OpsSection';
import { useCursorList } from './useCursorList';
import type { OrphanRow } from './types';

/** The orphan reconcile queue + the resolve/requeue controls (quarantined rows only). */
export function OrphanQueueSection({ onAct }: { onAct: (row: OrphanRow, action: 'resolve' | 'requeue') => void }) {
  const { t } = useTranslation('admin');
  const list = useCursorList<OrphanRow>(
    'admin_list_notification_orphans',
    ['updated_at', 'resend_event_id'],
    ['p_before_updated_at', 'p_before_event_id'],
  );

  const columns: ColumnDef<OrphanRow & { id: string }>[] = [
    {
      key: 'event', header: t('notifOps.eventId', 'Event id'), className: 'max-w-[240px]',
      cellTitle: (r) => r.resend_event_id,
      renderCell: (r) => <span className="block truncate">{r.resend_event_id}</span>,
    },
    {
      key: 'state', header: t('notifOps.state', 'State'), className: 'whitespace-nowrap',
      renderCell: (r) => (r.quarantined
        ? <Badge variant="destructive">{t('notifOps.quarantined', 'QUARANTINED')}</Badge>
        : <Badge variant="secondary">{t('notifOps.reconciling', 'reconciling')}</Badge>),
    },
    {
      key: 'reason', header: t('notifOps.reasonCol', 'Reason'), className: 'max-w-[200px] whitespace-nowrap',
      cellTitle: (r) => r.last_error_code ?? undefined,
      renderCell: (r) => <span className="block truncate">{r.last_error_code ?? '—'} ({r.attempts})</span>,
    },
  ];

  return (
    <OpsSection<OrphanRow>
      title={t('notifOps.orphans', 'Orphan provider events')}
      list={list}
      testId="orphans"
      labels={{
        load: t('notifOps.load', 'Load'),
        more: t('notifOps.more', 'Load more'),
        empty: t('notifOps.orphansEmpty', 'No orphan provider events'),
        emptyDescription: t('notifOps.orphansEmptyDesc', 'Every provider callback correlated to its group.'),
        errorText: t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'orphans' }),
      }}
    >
      {(rows) => (
        <DataTable<OrphanRow & { id: string }>
          columns={columns}
          rows={rows.map((r) => ({ ...r, id: r.resend_event_id }))}
          renderActions={(r) => (r.quarantined ? (
            <>
              <Button size="sm" variant="outline" onClick={() => onAct(r, 'resolve')} data-testid={`orphan-resolve-${r.resend_event_id}`}>
                {t('notifOps.resolve', 'Resolve…')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => onAct(r, 'requeue')} data-testid={`orphan-requeue-${r.resend_event_id}`}>
                {t('notifOps.requeue', 'Requeue…')}
              </Button>
            </>
          ) : null)}
          compact
          desktopOnly={false}
          empty={t('notifOps.orphansEmpty', 'No orphan provider events')}
        />
      )}
    </OpsSection>
  );
}
