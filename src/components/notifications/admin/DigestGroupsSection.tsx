import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { OpsSection } from './OpsSection';
import { useCursorList } from './useCursorList';
import { isCancellableGroup, type DigestGroupRow } from './types';

const STATES = ['pending', 'leased', 'prepared', 'request_ready', 'sending', 'awaiting_evidence', 'sent', 'retry_stopped', 'delivery_unknown'] as const;

/** Digest-group state + the pre-dispatch CANCEL control (offered only where the server can accept it). */
export function DigestGroupsSection({ onCancel }: { onCancel: (group: DigestGroupRow) => void }) {
  const { t } = useTranslation('admin');
  const [state, setState] = useState('all');
  const list = useCursorList<DigestGroupRow>(
    'admin_list_digest_groups',
    ['created_at', 'id'],
    ['p_before_created_at', 'p_before_id'],
    () => ({ p_state: state === 'all' ? undefined : state, p_days: 7 }),
  );

  const columns: ColumnDef<DigestGroupRow>[] = [
    {
      key: 'event', header: t('notifOps.event', 'Event'), className: 'max-w-[220px]',
      cellTitle: (r) => `${r.event_type} · ${r.channel}`,
      renderCell: (r) => <span className="block truncate">{r.event_type} · {r.channel}</span>,
    },
    {
      key: 'state', header: t('notifOps.state', 'State'), className: 'max-w-[200px] whitespace-nowrap',
      cellTitle: (r) => (r.terminal_reason ? `${r.state} (${r.terminal_reason})` : r.state),
      renderCell: (r) => <span className="block truncate">{r.state}{r.terminal_reason ? ` (${r.terminal_reason})` : ''}</span>,
    },
    { key: 'items', header: t('notifOps.items', 'Items'), className: 'whitespace-nowrap', renderCell: (r) => String(r.item_count) },
    {
      key: 'provider', header: t('notifOps.provider', 'Provider'), className: 'max-w-[180px] whitespace-nowrap',
      cellTitle: (r) => r.provider_status ?? undefined,
      renderCell: (r) => <span className="block truncate">{r.provider_status ?? '—'}</span>,
    },
  ];

  return (
    <OpsSection<DigestGroupRow>
      title={t('notifOps.groups', 'Digest groups (7 days)')}
      list={list}
      testId="groups"
      toolbar={
        <TableToolbar className="py-2">
          <Select value={state} onValueChange={(v) => { setState(v); list.reset(); }}>
            <SelectTrigger className="w-[200px]" data-testid="groups-state"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('notifOps.anyState', 'any state')}</SelectItem>
              {STATES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
        </TableToolbar>
      }
      labels={{
        load: t('notifOps.load', 'Load'),
        more: t('notifOps.more', 'Load more'),
        empty: t('notifOps.groupsEmpty', 'No digest groups in this window'),
        emptyDescription: t('notifOps.groupsEmptyDesc', 'Nothing matched this state and 7-day window.'),
        errorText: t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'digest groups' }),
      }}
    >
      {(rows) => (
        <DataTable<DigestGroupRow>
          columns={columns}
          rows={rows}
          renderActions={(r) => (isCancellableGroup(r) ? (
            <Button size="sm" variant="outline" onClick={() => onCancel(r)} data-testid={`cancel-btn-${r.id}`}>
              {t('notifOps.cancel', 'Cancel…')}
            </Button>
          ) : null)}
          compact
          desktopOnly={false}
          empty={t('notifOps.groupsEmpty', 'No digest groups in this window')}
        />
      )}
    </OpsSection>
  );
}
