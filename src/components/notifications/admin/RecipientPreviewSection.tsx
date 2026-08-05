import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageState } from '@/components/ui/list-page-shell';
import { Users } from 'lucide-react';
import type { PreviewRow } from './types';

type Row = PreviewRow & { id: string };

/**
 * The recipient preview. It does NOT use useCursorList: its cursor is a server-returned
 * `next_cursor` with an honest `candidates_partial` signal (a bounded-crawl contract), not a
 * last-row keyset — forcing it into the shared hook would misrepresent both.
 */
export function RecipientPreviewSection({ eventKeys }: { eventKeys: string[] }) {
  const { t } = useTranslation('admin');
  const [eventKey, setEventKey] = useState('');
  const [channel, setChannel] = useState('email');
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const lock = useRef(false);

  const resetScope = () => {
    epoch.current++;
    lock.current = false;
    setRows(null);
    setPartial(false);
    setCursor(null);
    setError(false);          // a previous scope's failure must not linger over a new one
  };
  const load = async (more = false) => {
    if (lock.current) return;
    lock.current = true;
    const myEpoch = ++epoch.current;
    setBusy(true);
    setError(false);
    const { data, error: err } = await supabase.rpc('admin_preview_notification_recipients', {
      p_event_key: eventKey,
      p_channel: channel,
      p_after_user_id: more ? cursor ?? undefined : undefined,
      p_limit: 25,
    });
    if (myEpoch !== epoch.current) return;
    lock.current = false;
    setBusy(false);
    if (err) { setError(true); return; }
    const list = (data ?? []) as PreviewRow[];
    const real = list.filter((r) => r.user_id);
    setRows((prev) => (more && prev ? [...prev, ...real] : real));
    setPartial(list.some((r) => r.candidates_partial === true));
    setCursor(list.length ? (list[list.length - 1].next_cursor ?? null) : null);
  };

  const columns: ColumnDef<Row>[] = [
    { key: 'destination', header: t('notifOps.destination', 'Destination'), className: 'max-w-[240px]',
      cellTitle: (r) => r.destination_masked ?? undefined,
      renderCell: (r) => <span className="block truncate">{r.destination_masked ?? '—'}</span> },
    { key: 'decision', header: t('notifOps.decision', 'Decision'), className: 'max-w-[240px] whitespace-nowrap',
      cellTitle: (r) => r.final_decision,
      renderCell: (r) => <span className="block truncate">{r.final_decision}</span> },
  ];

  return (
    <section aria-label="recipient preview" data-testid="section-preview">
      <h2 className="font-medium">{t('notifOps.preview', 'Recipient preview')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('notifOps.previewScope', 'Previews resolver state (preferences, caps, consent, suppression) for known users — not a producer’s audience.')}
      </p>
      <TableToolbar className="py-2">
        <Select value={eventKey} onValueChange={(v) => { setEventKey(v); resetScope(); }}>
          <SelectTrigger className="w-[240px]" data-testid="preview-event">
            <SelectValue placeholder={t('notifOps.chooseEvent', 'choose event…')} />
          </SelectTrigger>
          <SelectContent>
            {eventKeys.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={channel} onValueChange={(v) => { setChannel(v); resetScope(); }}>
          <SelectTrigger className="w-[160px]" data-testid="preview-channel"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="email">email</SelectItem>
            <SelectItem value="whatsapp">whatsapp</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={() => void load(false)} disabled={!eventKey} data-testid="preview-load">
          {t('notifOps.preview', 'Preview')}
        </Button>
      </TableToolbar>
      {rows === null && !error && !busy ? null : (
        <ListPageState
          isLoading={busy && rows === null}
          error={error ? (
            <span>
              {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'recipient preview' })}
              <Button size="sm" variant="outline" className="ml-2" onClick={() => void load(false)} data-testid="preview-retry">
                {t('notifOps.retry', 'Retry')}
              </Button>
            </span>
          ) : undefined}
          isEmpty={(rows?.length ?? 0) === 0 && !partial}
          empty={<EmptyState icon={Users} title={t('notifOps.previewEmpty', 'No recipients for this event')}
            description={t('notifOps.previewEmptyDesc', 'No known user resolves to a delivery for this event and channel.')} />}
        >
          <div data-testid="preview-list">
            {partial && (
              <p role="status" className="text-sm text-amber-600" data-testid="preview-partial">
                {t('notifOps.partial', 'PARTIAL: the candidate scan hit its budget — users beyond the horizon are omitted from this page; continue to crawl them.')}
              </p>
            )}
            <DataTable<Row>
              columns={columns}
              rows={(rows ?? []).map((r) => ({ ...r, id: r.user_id }))}
              compact
              desktopOnly={false}
              empty={t('notifOps.previewEmpty', 'No recipients for this event')}
            />
            {cursor && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void load(true)} data-testid="preview-more">
                {t('notifOps.more', 'Load more')}
              </Button>
            )}
          </div>
        </ListPageState>
      )}
    </section>
  );
}
