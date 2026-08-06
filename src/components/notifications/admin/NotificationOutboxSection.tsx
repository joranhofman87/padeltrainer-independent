import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageState } from '@/components/ui/list-page-shell';
import { History } from 'lucide-react';
import { OpsSection } from './OpsSection';
import { useCursorList } from './useCursorList';
import type { HistoryRow, OutboxRow } from './types';

const STATUSES = ['pending', 'processing', 'sent', 'failed', 'skipped'] as const;

/**
 * The cross-tenant outbox feed + its per-row delivery-history drill-down. Fixed columns only:
 * no payload ever reaches this surface (the resolver accepts caller JSON), destinations are the
 * redacted projection, and errors are the server's classification — never raw provider text.
 */
export function NotificationOutboxSection({
  onOpenHistory,
  onMoreHistory,
  historyFor,
  historyRows,
  historyError,
  historyExhausted,
}: {
  onOpenHistory: (outboxId: string) => void;
  onMoreHistory: () => void;
  historyFor: string | null;
  historyRows: HistoryRow[] | null;
  historyError: boolean;
  historyExhausted: boolean;
}) {
  const { t } = useTranslation('admin');
  const [channel, setChannel] = useState('email');
  const [status, setStatus] = useState('all');
  const list = useCursorList<OutboxRow>(
    'admin_list_notification_outbox',
    ['created_at', 'id'],
    ['p_before_created_at', 'p_before_id'],
    () => ({ p_channel: channel, p_status: status === 'all' ? undefined : status, p_days: 7 }),
  );

  const columns: ColumnDef<OutboxRow>[] = [
    {
      key: 'event', header: t('notifOps.event', 'Event'), className: 'max-w-[220px]',
      cellTitle: (r) => `${r.event_type} · ${r.channel}`,
      renderCell: (r) => <span className="block truncate">{r.event_type} · {r.channel}</span>,
    },
    {
      key: 'status', header: t('notifOps.status', 'Status'), className: 'whitespace-nowrap',
      renderCell: (r) => `${r.status} (${r.attempts}/${r.max_attempts})`,
    },
    {
      key: 'destination', header: t('notifOps.destination', 'Destination'), className: 'max-w-[220px]',
      cellTitle: (r) => r.destination_redacted ?? undefined,
      renderCell: (r) => <span className="block truncate">{r.destination_redacted ?? '—'}</span>,
    },
    {
      key: 'reason', header: t('notifOps.reasonCol', 'Reason / error class'), className: 'max-w-[220px]',
      cellTitle: (r) => r.skip_reason ?? r.error_class ?? undefined,
      renderCell: (r) => <span className="block truncate">{r.skip_reason ?? r.error_class ?? '—'}</span>,
    },
  ];

  return (
    <>
      <OpsSection<OutboxRow>
        title={t('notifOps.outbox', 'Outbox (7 days)')}
        list={list}
        testId="outbox"
        toolbar={
          <TableToolbar className="py-2">
            <Select value={channel} onValueChange={(v) => { setChannel(v); list.reset(); }}>
              <SelectTrigger className="w-[160px]" data-testid="outbox-channel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="email">email</SelectItem>
                <SelectItem value="whatsapp">whatsapp</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={(v) => { setStatus(v); list.reset(); }}>
              <SelectTrigger className="w-[180px]" data-testid="outbox-status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('notifOps.anyStatus', 'any status')}</SelectItem>
                {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </TableToolbar>
        }
        labels={{
          load: t('notifOps.load', 'Load'),
          more: t('notifOps.more', 'Load more'),
          empty: t('notifOps.outboxEmpty', 'No notifications in this window'),
          emptyDescription: t('notifOps.outboxEmptyDesc', 'Nothing matched this channel, status and 7-day window.'),
          errorText: t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'outbox' }),
        }}
      >
        {(rows) => (
          <DataTable<OutboxRow>
            columns={columns}
            rows={rows}
            renderActions={(r) => (
              <Button size="sm" variant="ghost" onClick={() => onOpenHistory(r.id)} data-testid={`history-btn-${r.id}`}>
                {t('notifOps.view', 'View')}
              </Button>
            )}
            compact
            desktopOnly={false}
            empty={t('notifOps.outboxEmpty', 'No notifications in this window')}
          />
        )}
      </OpsSection>
      {historyFor && (
        <div className="mt-2 rounded-md border p-3" data-testid="delivery-history">
          <p className="text-sm font-medium">
            {t('notifOps.historyFor', { defaultValue: 'Delivery history — {{id}}', id: historyFor })}
          </p>
          <ListPageState
            isLoading={!historyRows && !historyError}
            error={historyError ? (
              <span>
                {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'delivery history' })}
                <Button size="sm" variant="outline" className="ml-2" onClick={() => onOpenHistory(historyFor)}>
                  {t('notifOps.retry', 'Retry')}
                </Button>
              </span>
            ) : undefined}
            isEmpty={(historyRows?.length ?? 0) === 0 && !historyError}
            empty={<EmptyState icon={History} title={t('notifOps.historyEmpty', 'No delivery events for this row')}
              description={t('notifOps.historyEmptyDesc', 'Nothing has happened to this notification beyond its creation.')} />}
          >
            <ul className="space-y-1 text-sm">
              {(historyRows ?? []).map((h) => (
                <li key={h.ref} className="truncate" title={`${h.at} ${h.kind} ${h.a ?? ''} ${h.b ?? ''} ${h.c ?? ''}`}>
                  {h.at} · <strong>{h.kind}</strong> · {h.a ?? ''} {h.b ?? ''} {h.c ?? ''}
                </li>
              ))}
            </ul>
          </ListPageState>
          {historyRows && historyRows.length > 0 && !historyExhausted && (
            <Button size="sm" variant="outline" className="mt-2" onClick={onMoreHistory} data-testid="history-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
