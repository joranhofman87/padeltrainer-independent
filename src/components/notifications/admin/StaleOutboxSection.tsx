import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { TableToolbar } from '@/components/ui/table-toolbar';
import { ListPageState } from '@/components/ui/list-page-shell';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CHANNELS, type Channel, type StaleOutboxRow } from './types';

/**
 * THE LONG-OUTAGE RECOVERY, on the surface that can actually run it.
 *
 * Both RPCs are admin-gated (`auth.uid()` + the platform-admin role), so the runbook cannot
 * execute them: psql carries no JWT. They belong here, where the operator already has the
 * authenticated session — and where the decision gets the same confirmation, request id and audit
 * as every other control on this page.
 *
 * The preview is a deliberate first step, not a convenience: the number it reports is what the
 * operator is deciding about, and the disposal is bounded to what they were shown.
 */
export function StaleOutboxSection({ onDispose }: {
  onDispose: (target: { channel: Channel; olderThanMinutes: number; row: StaleOutboxRow }) => void;
}) {
  const { t } = useTranslation('admin');
  const [channel, setChannel] = useState<Channel>('email');
  // 24h by default: the case this exists for is an outage longer than the provider's dedup window
  const [minutes, setMinutes] = useState('1440');
  const [row, setRow] = useState<StaleOutboxRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const look = async () => {
    setBusy(true);
    setError(null);
    setRow(null);
    const { data, error: err } = await supabase.rpc('admin_stale_outbox_preview', {
      p_channel: channel,
      p_older_than_minutes: Number(minutes),
    });
    setBusy(false);
    // the RPC raises below its 60-minute floor, and the message says why — show it verbatim rather
    // than a generic failure, because it is the answer, not an error
    if (err) { setError(err.message); return; }
    setRow(((data ?? []) as StaleOutboxRow[])[0] ?? null);
  };

  const total = (row?.pending ?? 0) + (row?.abandoned_processing ?? 0);

  return (
    <section aria-label="stale outbox" data-testid="section-stale">
      <h2 className="font-medium">{t('notifOps.stale', 'After a long outage')}</h2>
      <p className="text-sm text-muted-foreground">
        {t('notifOps.staleDesc', 'Nothing bounds how long an instant row waits between attempts, so after an outage longer than the provider’s deduplication window (24h) resuming can re-send an attempt that may already have been accepted. Look at what is waiting, then dispose of what is no longer worth sending — before the worker resumes.')}
      </p>
      <TableToolbar className="py-2">
        <Select value={channel} onValueChange={(v) => { setChannel(v as Channel); setRow(null); }}>
          <SelectTrigger className="w-[160px]" data-testid="stale-channel"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CHANNELS.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input
          value={minutes}
          onChange={(e) => { setMinutes(e.target.value); setRow(null); }}
          className="max-w-[160px]"
          inputMode="numeric"
          aria-label={t('notifOps.staleMinutes', 'older than (minutes)')}
          placeholder={t('notifOps.staleMinutes', 'older than (minutes)')}
          data-testid="stale-minutes"
        />
        <Button size="sm" variant="outline" onClick={() => void look()} disabled={busy} data-testid="stale-preview">
          {t('notifOps.staleLook', 'Look')}
        </Button>
      </TableToolbar>

      <ListPageState
        isLoading={busy && !row}
        error={error ? <span data-testid="stale-error">{error}</span> : undefined}
      >
        {row ? (
          <div data-testid="stale-result" className="space-y-2 text-sm">
            <p>
              {t('notifOps.stalePending', 'pending')}: <strong data-testid="stale-pending">{row.pending}</strong>{' · '}
              {t('notifOps.staleAbandoned', 'abandoned leases')}: <strong data-testid="stale-abandoned">{row.abandoned_processing}</strong>
              {row.oldest ? <span className="text-muted-foreground">{' · '}{t('notifOps.staleOldest', 'oldest')}: {row.oldest}</span> : null}
            </p>
            {total > 0 ? (
              <>
                <Badge variant="destructive" data-testid="stale-total">{total}</Badge>
                <Button
                  size="sm" variant="outline" className="ml-2" data-testid="stale-dispose"
                  onClick={() => onDispose({ channel, olderThanMinutes: Number(minutes), row })}
                >
                  {t('notifOps.staleDispose', 'Dispose these…')}
                </Button>
              </>
            ) : (
              // nothing to decide about is the good answer, and the control disappears with it
              <p className="text-muted-foreground" data-testid="stale-none">
                {t('notifOps.staleNone', 'Nothing is waiting past that threshold — resuming is safe.')}
              </p>
            )}
          </div>
        ) : null}
      </ListPageState>
    </section>
  );
}
