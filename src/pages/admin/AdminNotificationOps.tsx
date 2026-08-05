import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';

/**
 * N4 M7 — the platform-admin notification operations surface, on the N3 UI doctrine:
 *
 *  * FAIL-CLOSED loads: an error renders retry, never defaults-as-state (an admin acting on a
 *    silently-defaulted "live" kill state is the failure mode);
 *  * request-id-per-DECISION, held in a ref across retries: an exact network retry REPLAYS
 *    server-side instead of double-recording (the registry keys on it);
 *  * TYPED VERDICTS: the recovery RPCs return refusals ('rejected_stale_state', …) as values,
 *    not exceptions — each is surfaced as its own message, and a stale-state refusal prompts a
 *    reload-and-reconfirm, never an auto-retry;
 *  * cursors are OPAQUE STRINGS passed back verbatim (timestamptz carries microseconds that a
 *    Date round-trip silently destroys — proven as a paging bug twice in the SQL suites);
 *  * the DIGEST_SEND_ENABLED line is VISIBLE text on the page, never a tooltip — no SQL can
 *    read an edge env var, and this page must say so rather than imply it verified it;
 *  * there is NO clear-kill and NO retry control here, by design — killing is one-way on this
 *    surface (clearing is the owner's runbook) and no RPC shaped like a resend exists.
 */

type Check = { id: string; status: string; detail: string; value?: number; capped?: boolean };
type Envelope = { schema_version: number; as_of: string; readiness: string; checks: Check[] };

const CHANNELS = ['email', 'whatsapp'] as const;

function StatusBadge({ status }: { status: string }) {
  const variant = status === 'pass' ? 'default' : status === 'fail' ? 'destructive' : 'secondary';
  return <Badge variant={variant} data-testid={`status-${status}`}>{status}</Badge>;
}

/** Every section loads fail-closed through this shape: error → alert + retry, no defaults. */
function SectionError({ onRetry, label }: { onRetry: () => void; label: string }) {
  const { t } = useTranslation('admin');
  return (
    <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
      <p>{t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label })}</p>
      <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>
        {t('notifOps.retry', 'Retry')}
      </Button>
    </div>
  );
}

export default function AdminNotificationOps() {
  const { t } = useTranslation('admin');
  const { toast } = useToast();
  const qc = useQueryClient();

  const readiness = useQuery({
    queryKey: ['notif-ops', 'readiness'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_notification_readiness');
      if (error) throw error;
      return data as unknown as Envelope;
    },
    retry: false,
  });
  const gauges = useQuery({
    queryKey: ['notif-ops', 'gauges'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_notification_gauges');
      if (error) throw error;
      return data;
    },
    retry: false,
  });
  const eventStates = useQuery({
    queryKey: ['notif-ops', 'event-states'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_notification_event_states');
      if (error) throw error;
      return data;
    },
    retry: false,
  });
  const invocations = useQuery({
    queryKey: ['notif-ops', 'invocations'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_worker_invocations', { p_limit: 50 });
      if (error) throw error;
      return data;
    },
    retry: false,
  });

  // ── audit + rejected: keyset pagination with OPAQUE string cursors ────────────────────────
  const [auditRows, setAuditRows] = useState<Record<string, unknown>[] | null>(null);
  const [auditError, setAuditError] = useState(false);
  const loadAudit = async (more = false) => {
    setAuditError(false);
    const last = more && auditRows?.length ? auditRows[auditRows.length - 1] : null;
    const { data, error } = await supabase.rpc('admin_list_notification_audit', {
      // the cursor is the row's RAW string value, passed back verbatim — a Date round-trip
      // destroys microseconds and silently drops same-millisecond rows
      p_before_created_at: last ? (last.created_at as string) : undefined,
      p_before_id: last ? (last.id as string) : undefined,
      p_limit: 25,
    });
    if (error) { setAuditError(true); return; }
    setAuditRows(more && auditRows ? [...auditRows, ...(data ?? [])] : (data ?? []));
  };
  const [rejectedRows, setRejectedRows] = useState<Record<string, unknown>[] | null>(null);
  const [rejectedError, setRejectedError] = useState(false);
  const loadRejected = async (more = false) => {
    setRejectedError(false);
    const last = more && rejectedRows?.length ? rejectedRows[rejectedRows.length - 1] : null;
    const { data, error } = await supabase.rpc('admin_list_notification_rejected', {
      p_before_created_at: last ? (last.created_at as string) : undefined,
      p_before_id: last ? (last.id as string) : undefined,
      p_limit: 25,
    });
    if (error) { setRejectedError(true); return; }
    setRejectedRows(more && rejectedRows ? [...rejectedRows, ...(data ?? [])] : (data ?? []));
  };

  // ── the KILL decision: reason + one request id per decision, held across retries ──────────
  const [killTarget, setKillTarget] = useState<string | null>(null);
  const [killReason, setKillReason] = useState('');
  const [killBusy, setKillBusy] = useState(false);
  const killRequestId = useRef<string | null>(null);
  const openKill = (channel: string) => {
    killRequestId.current = crypto.randomUUID();   // ONE id per DECISION — retries replay it
    setKillReason('');
    setKillTarget(channel);
  };
  const confirmKill = async () => {
    if (!killTarget) return;
    setKillBusy(true);
    try {
      const { data, error } = await supabase.rpc('admin_activate_channel_kill', {
        p_channel: killTarget,
        p_reason: killReason.trim(),
        p_request_id: killRequestId.current,
      });
      if (error) throw error;
      const verdict = String(data);
      toast({
        title: verdict === 'killed'
          ? t('notifOps.killed', { defaultValue: '{{channel}} is KILLED', channel: killTarget })
          : t('notifOps.killVerdict', { defaultValue: 'Kill verdict: {{verdict}}', verdict }),
      });
      setKillTarget(null);
      void qc.invalidateQueries({ queryKey: ['notif-ops'] });
    } catch (error) {
      logger.error('channel kill failed', undefined, { error });
      // the SAME request id stays in the ref — pressing confirm again REPLAYS, never re-kills
      toast({ title: t('notifOps.killFailed', 'The kill did not go through — retrying replays the same decision'), variant: 'destructive' });
    } finally {
      setKillBusy(false);
    }
  };

  // ── the CIRCUIT RESET: typed confirmation built from the state ON SCREEN ──────────────────
  const [resetTarget, setResetTarget] = useState<{ channel: string; state: string; reason: string | null; tripped_at: string | null } | null>(null);
  const [resetReason, setResetReason] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const resetRequestId = useRef<string | null>(null);
  const openReset = (channel: string, state: string, reason: string | null, tripped: string | null) => {
    resetRequestId.current = crypto.randomUUID();
    setResetReason('');
    setResetTarget({ channel, state, reason, tripped_at: tripped });
  };
  const confirmReset = async () => {
    if (!resetTarget) return;
    setResetBusy(true);
    try {
      const { data, error } = await supabase.rpc('admin_reset_notification_circuit', {
        // the EXPECTED identity is exactly what this screen showed — a stale screen is refused
        // server-side as rejected_stale_state, never silently applied to a newer trip
        p_channel: resetTarget.channel,
        p_expected_state: resetTarget.state,
        p_expected_reason: resetTarget.reason,
        p_expected_tripped_at: resetTarget.tripped_at,
        p_reason: resetReason.trim(),
        p_request_id: resetRequestId.current,
      });
      if (error) throw error;
      const verdict = String(data);
      if (verdict === 'rejected_stale_state') {
        toast({
          title: t('notifOps.staleReset', 'The circuit changed since this screen loaded — reload and confirm against the CURRENT trip'),
          variant: 'destructive',
        });
      } else {
        toast({ title: t('notifOps.resetVerdict', { defaultValue: 'Circuit reset verdict: {{verdict}}', verdict }) });
      }
      setResetTarget(null);
      void qc.invalidateQueries({ queryKey: ['notif-ops'] });
    } catch (error) {
      logger.error('circuit reset failed', undefined, { error });
      toast({ title: t('notifOps.resetFailed', 'The reset did not go through — retrying replays the same decision'), variant: 'destructive' });
    } finally {
      setResetBusy(false);
    }
  };

  const env = readiness.data;

  return (
    <div className="space-y-6 p-4" data-testid="admin-notification-ops">
      <div>
        <h1 className="text-xl font-semibold">{t('notifOps.title', 'Notification operations')}</h1>
        {/* THE VISIBLE ENV LINE — plain page text, deliberately not a tooltip */}
        <p className="text-sm text-muted-foreground" data-testid="env-line">
          {t('notifOps.envLine', 'DIGEST_SEND_ENABLED is an edge environment switch that cannot be verified from this page or from SQL — treat every digest-send conclusion below as unverified until the operator confirms the switch.')}
        </p>
      </div>

      <section aria-label={t('notifOps.readiness', 'Readiness')}>
        <h2 className="font-medium">{t('notifOps.readiness', 'Readiness')}</h2>
        {readiness.isError ? (
          <SectionError label="readiness" onRetry={() => void readiness.refetch()} />
        ) : env ? (
          <div data-testid="readiness-envelope">
            <p className="text-sm">
              {t('notifOps.overall', 'Overall')}: <StatusBadge status={env.readiness} />{' '}
              <span className="text-muted-foreground">v{env.schema_version} · {env.as_of}</span>
            </p>
            <ul className="mt-2 space-y-1 text-sm">
              {env.checks.map((c) => (
                <li key={c.id} data-testid={`check-${c.id}`}>
                  <StatusBadge status={c.status} /> <strong>{c.id}</strong>: {c.detail}
                  {c.capped ? <em> {t('notifOps.capped', '(saturated count)')}</em> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-label={t('notifOps.kills', 'Kill switches')}>
        <h2 className="font-medium">{t('notifOps.kills', 'Kill switches')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('notifOps.killOneWay', 'Killing a channel is ONE-WAY from this page: it stops the instant workers and parks the digest engine. Clearing a kill re-opens live sending and is deliberately not offered here — it is an owner runbook operation.')}
        </p>
        {gauges.isError ? (
          <SectionError label="kill state" onRetry={() => void gauges.refetch()} />
        ) : gauges.data ? (
          <div className="flex gap-4" data-testid="kill-switches">
            {CHANNELS.map((ch) => {
              const killed = Number((gauges.data as Array<{ metric: string; channel: string | null; value: number }>)
                .find((g) => g.metric === 'channel_killed' && g.channel === ch)?.value ?? 0) > 0;
              return (
                <div key={ch} className="rounded-md border p-3" data-testid={`kill-${ch}`} data-killed={killed}>
                  <p className="font-medium">{ch}</p>
                  <p className="text-sm">{killed ? t('notifOps.stateKilled', 'KILLED') : t('notifOps.stateLive', 'live')}</p>
                  {!killed && (
                    <Button size="sm" variant="destructive" onClick={() => openKill(ch)} data-testid={`kill-btn-${ch}`}>
                      {t('notifOps.killNow', 'Kill channel')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section aria-label={t('notifOps.eventStates', 'Event states')}>
        <h2 className="font-medium">{t('notifOps.eventStates', 'Event states')}</h2>
        {eventStates.isError ? (
          <SectionError label="event states" onRetry={() => void eventStates.refetch()} />
        ) : eventStates.data ? (
          <div className="overflow-x-auto">
            <Table data-testid="event-states">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('notifOps.event', 'Event')}</TableHead>
                  <TableHead>{t('notifOps.channel', 'Channel')}</TableHead>
                  <TableHead>{t('notifOps.catalog', 'Catalog')}</TableHead>
                  <TableHead>{t('notifOps.caps', 'Caps')}</TableHead>
                  <TableHead>{t('notifOps.cron', 'Cron')}</TableHead>
                  <TableHead>{t('notifOps.circuit', 'Circuit')}</TableHead>
                  <TableHead>{t('notifOps.kill', 'Kill')}</TableHead>
                  <TableHead>{t('notifOps.env', 'Env')}</TableHead>
                  <TableHead>{t('notifOps.instant', 'Instant')}</TableHead>
                  <TableHead>{t('notifOps.digest', 'Digest')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(eventStates.data as Array<Record<string, unknown>>).map((r) => (
                  <TableRow key={`${r.event_type}:${r.channel}`} data-testid={`es-${r.event_type}:${r.channel}`}>
                    <TableCell>{String(r.event_type)}</TableCell>
                    <TableCell>{String(r.channel)}</TableCell>
                    <TableCell>{r.catalog_supported ? String(r.catalog_default) : t('notifOps.unsupported', 'unsupported')}{r.required_delivery ? ' · required' : ''}</TableCell>
                    <TableCell>{Number(r.academy_off_caps)}</TableCell>
                    <TableCell>{String(r.cron_state)}</TableCell>
                    <TableCell>
                      {String(r.circuit_state)}
                      {['open', 'half_open'].includes(String(r.circuit_state)) && (
                        <Button size="sm" variant="outline" className="ml-2"
                          onClick={() => openReset(String(r.channel), String(r.circuit_state),
                            (r.circuit_reason as string | null) ?? null,
                            (r.circuit_tripped_at as string | null) ?? null)}
                          data-testid={`reset-btn-${r.channel}`}>
                          {t('notifOps.reset', 'Reset…')}
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>{String(r.kill_state)}</TableCell>
                    <TableCell>{String(r.send_env)}</TableCell>
                    <TableCell>{String(r.instant_conclusion)}</TableCell>
                    <TableCell>{String(r.digest_conclusion)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </section>

      <section aria-label={t('notifOps.invocations', 'Deliberate invocations')}>
        <h2 className="font-medium">{t('notifOps.invocations', 'Deliberate invocations')}</h2>
        {invocations.isError ? (
          <SectionError label="invocations" onRetry={() => void invocations.refetch()} />
        ) : invocations.data ? (
          <Table data-testid="invocations">
            <TableHeader>
              <TableRow>
                <TableHead>{t('notifOps.purpose', 'Purpose')}</TableHead>
                <TableHead>{t('notifOps.status', 'Status')}</TableHead>
                <TableHead>{t('notifOps.age', 'Age (s)')}</TableHead>
                <TableHead>{t('notifOps.stale', 'Stale')}</TableHead>
                <TableHead>{t('notifOps.actionable', 'Actionable')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(invocations.data as Array<Record<string, unknown>>).map((r) => (
                <TableRow key={String(r.id)}>
                  <TableCell>{String(r.purpose)} · {String(r.source)}</TableCell>
                  <TableCell>{String(r.status)}</TableCell>
                  <TableCell>{String(r.age_seconds)}</TableCell>
                  <TableCell>{r.stale ? '⚠︎' : '—'}</TableCell>
                  <TableCell>{r.actionable ? t('notifOps.yes', 'yes') : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>

      <section aria-label={t('notifOps.audit', 'Decision audit')}>
        <h2 className="font-medium">{t('notifOps.audit', 'Decision audit')}</h2>
        {auditError ? (
          <SectionError label="audit" onRetry={() => void loadAudit(false)} />
        ) : auditRows === null ? (
          <Button size="sm" variant="outline" onClick={() => void loadAudit(false)} data-testid="audit-load">
            {t('notifOps.load', 'Load')}
          </Button>
        ) : (
          <div data-testid="audit-list">
            <ul className="space-y-1 text-sm">
              {auditRows.map((r) => (
                <li key={String(r.id)}>
                  {String(r.created_at)} · {String(r.action)} · {String(r.target)} · {String(r.old_value)}→{String(r.new_value)} · {String(r.outcome)} · “{String(r.reason)}”
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void loadAudit(true)} data-testid="audit-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          </div>
        )}
        <h3 className="mt-3 text-sm font-medium">{t('notifOps.rejected', 'Rejected attempts')}</h3>
        {rejectedError ? (
          <SectionError label="rejected attempts" onRetry={() => void loadRejected(false)} />
        ) : rejectedRows === null ? (
          <Button size="sm" variant="outline" onClick={() => void loadRejected(false)} data-testid="rejected-load">
            {t('notifOps.load', 'Load')}
          </Button>
        ) : (
          <div data-testid="rejected-list">
            <ul className="space-y-1 text-sm">
              {rejectedRows.map((r) => (
                <li key={String(r.id)}>
                  {String(r.created_at)} · {String(r.action)} · {String(r.target)} · {String(r.conflict_with)}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void loadRejected(true)} data-testid="rejected-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          </div>
        )}
      </section>

      {/* the KILL confirmation — reason mandatory, one request id per decision */}
      <Dialog open={!!killTarget} onOpenChange={(open) => { if (!open) setKillTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('notifOps.killTitle', { defaultValue: 'Kill the {{channel}} channel?', channel: killTarget ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {t('notifOps.killDesc', 'This stops sending NOW and cannot be undone from this page. A reason is required and is recorded in the immutable audit.')}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={killReason} onChange={(e) => setKillReason(e.target.value)}
            placeholder={t('notifOps.killReasonPh', 'e.g. provider incident #123 — stop all email now')}
            data-testid="kill-reason" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setKillTarget(null)}>{t('cancel', 'Cancel')}</Button>
            <Button variant="destructive" onClick={() => void confirmKill()}
              disabled={killBusy || killReason.trim().length < 3} data-testid="kill-confirm">
              {killBusy ? t('notifOps.killing', 'Killing…') : t('notifOps.killConfirm', 'Kill channel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* the CIRCUIT RESET confirmation — the expected identity is what the screen showed */}
      <Dialog open={!!resetTarget} onOpenChange={(open) => { if (!open) setResetTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('notifOps.resetTitle', { defaultValue: 'Reset the {{channel}} circuit?', channel: resetTarget?.channel ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {t('notifOps.resetDesc', { defaultValue: 'You are confirming against the trip this screen showed ({{state}}). If the circuit re-tripped since, the server refuses and you must reload.', state: resetTarget?.state ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={resetReason} onChange={(e) => setResetReason(e.target.value)}
            placeholder={t('notifOps.resetReasonPh', 'e.g. provider incident resolved, dashboard green')}
            data-testid="reset-reason" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetTarget(null)}>{t('cancel', 'Cancel')}</Button>
            <Button onClick={() => void confirmReset()}
              disabled={resetBusy || resetReason.trim().length < 3} data-testid="reset-confirm">
              {resetBusy ? t('notifOps.resetting', 'Resetting…') : t('notifOps.resetConfirm', 'Reset circuit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
