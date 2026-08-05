import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';

/**
 * N4 M7 — the platform-admin notification operations surface, on the N3 UI doctrine:
 *
 *  * FAIL-CLOSED loads: an error renders retry, never defaults-as-state;
 *  * request-id-per-DECISION held in a ref across retries, and the decision INPUTS FREEZE
 *    after the first submit — a changed reason under the held id would be conflicting reuse
 *    server-side, not a replay, so the UI forbids changing it mid-decision;
 *  * TYPED VERDICTS handled as values ('rejected_stale_state' → reload-and-reconfirm, …);
 *  * cursors are OPAQUE STRINGS passed back verbatim (microseconds must survive);
 *  * paginated lists carry an in-flight guard + request epoch (concurrent clicks cannot
 *    double-append; a stale response cannot overwrite newer state);
 *  * the DIGEST_SEND_ENABLED line is VISIBLE page text, never a tooltip;
 *  * NO clear-kill and NO retry/resend control exists on this surface, by design.
 */

type Check = { id: string; status: string; detail: string; value?: number; capped?: boolean };
type Envelope = { schema_version: number; as_of: string; readiness: string; checks: Check[] };
type Row = Record<string, unknown>;

const CHANNELS = ['email', 'whatsapp'] as const;

function StatusBadge({ status }: { status: string }) {
  const variant = status === 'pass' ? 'default' : status === 'fail' ? 'destructive' : 'secondary';
  return <Badge variant={variant} data-testid={`status-${status}`}>{status}</Badge>;
}

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

/** Cursor-list plumbing: in-flight guard + request epoch + functional updates. The cursor is
 *  built from the LAST row's raw string fields, passed back verbatim. */
function usePagedRpc(rpcName: string, cursorFields: [string, string], cursorParams: [string, string], extraArgs: () => Row = () => ({})) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const lock = useRef(false);               // SYNCHRONOUS: render state is not an atomic guard
  const load = async (more = false) => {
    if (lock.current) return;               // the in-flight guard: concurrent clicks no-op
    lock.current = true;
    setBusy(true);
    setError(false);
    const myEpoch = ++epoch.current;
    const last = more && rows?.length ? rows[rows.length - 1] : null;
    const args: Row = { ...extraArgs(), p_limit: 25 };
    if (last) {
      args[cursorParams[0]] = last[cursorFields[0]] as string;   // verbatim raw string
      args[cursorParams[1]] = last[cursorFields[1]] as string;
    }
    const { data, error: err } = await supabase.rpc(rpcName, args);
    if (myEpoch !== epoch.current) return;  // a newer request superseded this one: drop it
    lock.current = false;                   // only the epoch OWNER releases the lock
    if (err) { setError(true); setBusy(false); return; }
    setRows((prev) => (more && prev ? [...prev, ...((data ?? []) as Row[])] : ((data ?? []) as Row[])));
    setBusy(false);
  };
  const reset = () => { setRows(null); setError(false); epoch.current++; lock.current = false; setBusy(false); };
  return { rows, error, busy, load, reset };
}

/** Decision plumbing: one request id per decision; inputs FREEZE after the first submit. */
function useDecision<T>() {
  const [target, setTarget] = useState<T | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const requestId = useRef<string | null>(null);
  const open = (t: T) => {
    requestId.current = crypto.randomUUID();
    setReason('');
    setFrozen(false);
    setTarget(t);
  };
  const close = () => setTarget(null);
  return { target, reason, setReason, busy, setBusy, frozen, setFrozen, requestId, open, close };
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
      return data as Row[];
    },
    retry: false,
  });
  const eventStates = useQuery({
    queryKey: ['notif-ops', 'event-states'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_notification_event_states');
      if (error) throw error;
      return data as Row[];
    },
    retry: false,
  });
  const invocations = useQuery({
    queryKey: ['notif-ops', 'invocations'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_worker_invocations', { p_limit: 50 });
      if (error) throw error;
      return data as Row[];
    },
    retry: false,
  });

  // ── paginated lists ───────────────────────────────────────────────────────────────────────
  const audit = usePagedRpc('admin_list_notification_audit', ['created_at', 'id'], ['p_before_created_at', 'p_before_id']);
  const rejected = usePagedRpc('admin_list_notification_rejected', ['created_at', 'id'], ['p_before_created_at', 'p_before_id']);
  const [outboxChannel, setOutboxChannel] = useState('email');
  const [outboxStatus, setOutboxStatus] = useState('');
  const outbox = usePagedRpc('admin_list_notification_outbox', ['created_at', 'id'], ['p_before_created_at', 'p_before_id'],
    () => ({ p_channel: outboxChannel || undefined, p_status: outboxStatus || undefined, p_days: 7 }));
  const [groupState, setGroupState] = useState('');
  const groups = usePagedRpc('admin_list_digest_groups', ['created_at', 'id'], ['p_before_created_at', 'p_before_id'],
    () => ({ p_state: groupState || undefined, p_days: 7 }));
  const runs = usePagedRpc('admin_list_worker_runs', ['started_at', 'run_id'], ['p_before_started_at', 'p_before_run_id'],
    () => ({ p_days: 7 }));
  const orphans = usePagedRpc('admin_list_notification_orphans', ['updated_at', 'resend_event_id'], ['p_before_updated_at', 'p_before_event_id']);

  // ── per-row delivery history drill-down ───────────────────────────────────────────────────
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<Row[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const historyEpoch = useRef(0);
  const openHistory = async (outboxId: string) => {
    const myEpoch = ++historyEpoch.current;   // a late response for an EARLIER row is dropped
    setHistoryFor(outboxId);
    setHistoryRows(null);
    setHistoryError(false);
    const { data, error } = await supabase.rpc('admin_notification_delivery_history', { p_outbox_id: outboxId, p_limit: 50 });
    if (myEpoch !== historyEpoch.current) return;
    if (error) { setHistoryError(true); return; }
    setHistoryRows((data ?? []) as Row[]);
  };

  // ── recipient preview (crawl with honest partial pages) ───────────────────────────────────
  const [previewEvent, setPreviewEvent] = useState('');
  const [previewChannel, setPreviewChannel] = useState('email');
  const [previewRows, setPreviewRows] = useState<Row[] | null>(null);
  const [previewPartial, setPreviewPartial] = useState(false);
  const [previewCursor, setPreviewCursor] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const previewEpoch = useRef(0);
  const previewLock = useRef(false);
  const resetPreview = () => {              // a changed event/channel invalidates results AND cursor
    previewEpoch.current++;
    previewLock.current = false;
    setPreviewRows(null);
    setPreviewPartial(false);
    setPreviewCursor(null);
  };
  const loadPreview = async (more = false) => {
    if (previewLock.current) return;
    previewLock.current = true;
    const myEpoch = ++previewEpoch.current;
    setPreviewError(false);
    const { data, error } = await supabase.rpc('admin_preview_notification_recipients', {
      p_event_key: previewEvent,
      p_channel: previewChannel,
      p_after_user_id: more ? previewCursor ?? undefined : undefined,
      p_limit: 25,
    });
    if (myEpoch !== previewEpoch.current) return;   // superseded (scope changed / newer call)
    previewLock.current = false;
    if (error) { setPreviewError(true); return; }
    const list = (data ?? []) as Row[];
    const real = list.filter((r) => r.user_id);
    setPreviewRows((prev) => (more && prev ? [...prev, ...real] : real));
    setPreviewPartial(list.some((r) => r.candidates_partial === true));
    const lastCursor = list.length ? (list[list.length - 1].next_cursor as string | null) : null;
    setPreviewCursor(lastCursor);
  };

  // ── destination search ────────────────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const [searchResult, setSearchResult] = useState<Row | null>(null);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);
  const searchEpoch = useRef(0);
  const runSearch = async () => {
    const myEpoch = ++searchEpoch.current;   // an older lookup must never overwrite a newer one
    setSearchResult(null);
    setSearchMessage(null);
    const { data, error } = await supabase.rpc('admin_search_notification_destination', { p_destination: searchInput });
    if (myEpoch !== searchEpoch.current) return;
    if (error) { setSearchMessage(error.message); return; }
    setSearchResult(((data ?? []) as Row[])[0] ?? null);
  };

  // ── decisions ─────────────────────────────────────────────────────────────────────────────
  const kill = useDecision<string>();
  const confirmKill = async () => {
    if (!kill.target) return;
    kill.setBusy(true);
    kill.setFrozen(true);   // from here the reason is IMMUTABLE — a retry must replay, not re-decide
    try {
      const { data, error } = await supabase.rpc('admin_activate_channel_kill', {
        p_channel: kill.target,
        p_reason: kill.reason.trim(),
        p_request_id: kill.requestId.current,
      });
      if (error) throw error;
      toast({ title: t('notifOps.killVerdict', { defaultValue: 'Kill verdict: {{verdict}}', verdict: String(data) }) });
      kill.close();
      void qc.invalidateQueries({ queryKey: ['notif-ops'] });
    } catch (error) {
      logger.error('channel kill failed', undefined, { error });
      toast({ title: t('notifOps.killFailed', 'The kill did not go through — retry replays the SAME decision'), variant: 'destructive' });
    } finally {
      kill.setBusy(false);
    }
  };

  type ResetTarget = { channel: string; state: string; reason: string | null; tripped_at: string | null };
  const reset = useDecision<ResetTarget>();
  const confirmReset = async () => {
    if (!reset.target) return;
    reset.setBusy(true);
    reset.setFrozen(true);
    try {
      const { data, error } = await supabase.rpc('admin_reset_notification_circuit', {
        p_channel: reset.target.channel,
        p_expected_state: reset.target.state,
        p_expected_reason: reset.target.reason,
        p_expected_tripped_at: reset.target.tripped_at,
        p_reason: reset.reason.trim(),
        p_request_id: reset.requestId.current,
      });
      if (error) throw error;
      const verdict = String(data);
      toast({
        title: verdict === 'rejected_stale_state'
          ? t('notifOps.staleReset', 'The circuit changed since this screen loaded — reload and confirm against the CURRENT trip')
          : t('notifOps.resetVerdict', { defaultValue: 'Circuit reset verdict: {{verdict}}', verdict }),
        variant: verdict.startsWith('rejected') ? 'destructive' : undefined,
      });
      reset.close();
      void qc.invalidateQueries({ queryKey: ['notif-ops'] });
    } catch (error) {
      logger.error('circuit reset failed', undefined, { error });
      toast({ title: t('notifOps.resetFailed', 'The reset did not go through — retry replays the SAME decision'), variant: 'destructive' });
    } finally {
      reset.setBusy(false);
    }
  };

  type CancelTarget = { groupId: string; state: string };
  const cancel = useDecision<CancelTarget>();
  const confirmCancel = async () => {
    if (!cancel.target) return;
    cancel.setBusy(true);
    cancel.setFrozen(true);
    try {
      const { data, error } = await supabase.rpc('admin_cancel_digest_group', {
        p_group_id: cancel.target.groupId,
        p_expected_state: cancel.target.state,   // exactly what the row showed
        p_reason: cancel.reason.trim(),
        p_request_id: cancel.requestId.current,
      });
      if (error) throw error;
      toast({ title: t('notifOps.cancelVerdict', { defaultValue: 'Cancel verdict: {{verdict}}', verdict: String(data) }) });
      cancel.close();
      void groups.load(false);
    } catch (error) {
      logger.error('group cancel failed', undefined, { error });
      toast({ title: t('notifOps.cancelFailed', 'The cancel did not go through — retry replays the SAME decision'), variant: 'destructive' });
    } finally {
      cancel.setBusy(false);
    }
  };

  type OrphanTarget = { eventId: string; action: 'resolve' | 'requeue' };
  const orphanOp = useDecision<OrphanTarget>();
  const confirmOrphan = async () => {
    if (!orphanOp.target) return;
    orphanOp.setBusy(true);
    orphanOp.setFrozen(true);
    try {
      const rpcName = orphanOp.target.action === 'resolve'
        ? 'admin_resolve_notification_orphan' : 'admin_requeue_notification_orphan';
      const { data, error } = await supabase.rpc(rpcName, {
        p_resend_event_id: orphanOp.target.eventId,
        p_reason: orphanOp.reason.trim(),
        p_request_id: orphanOp.requestId.current,
      });
      if (error) throw error;
      toast({ title: t('notifOps.orphanVerdict', { defaultValue: 'Orphan verdict: {{verdict}}', verdict: String(data) }) });
      orphanOp.close();
      void orphans.load(false);
    } catch (error) {
      logger.error('orphan operation failed', undefined, { error });
      toast({ title: t('notifOps.orphanFailed', 'The operation did not go through — retry replays the SAME decision'), variant: 'destructive' });
    } finally {
      orphanOp.setBusy(false);
    }
  };

  const env = readiness.data;
  const eventKeys = Array.from(new Set(((eventStates.data ?? []) as Row[]).map((r) => String(r.event_type))));

  return (
    <div className="space-y-6 p-4" data-testid="admin-notification-ops">
      <div>
        <h1 className="text-xl font-semibold">{t('notifOps.title', 'Notification operations')}</h1>
        {/* THE VISIBLE ENV LINE — plain page text, deliberately not a tooltip */}
        <p className="text-sm text-muted-foreground" data-testid="env-line">
          {t('notifOps.envLine', 'DIGEST_SEND_ENABLED is an edge environment switch that cannot be verified from this page or from SQL — treat every digest-send conclusion below as unverified until the operator confirms the switch.')}
        </p>
      </div>

      <section aria-label="readiness">
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

      <section aria-label="kill switches">
        <h2 className="font-medium">{t('notifOps.kills', 'Kill switches')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('notifOps.killOneWay', 'Killing a channel is ONE-WAY from this page. Clearing a kill re-opens live sending and is deliberately not offered here — it is an owner runbook operation.')}
        </p>
        {gauges.isError ? (
          <SectionError label="kill state" onRetry={() => void gauges.refetch()} />
        ) : gauges.data ? (
          <div className="flex gap-4" data-testid="kill-switches">
            {CHANNELS.map((ch) => {
              const killed = Number((gauges.data as Row[])
                .find((g) => g.metric === 'channel_killed' && g.channel === ch)?.value ?? 0) > 0;
              return (
                <div key={ch} className="rounded-md border p-3" data-testid={`kill-${ch}`} data-killed={killed}>
                  <p className="font-medium">{ch}</p>
                  <p className="text-sm">{killed ? t('notifOps.stateKilled', 'KILLED') : t('notifOps.stateLive', 'live')}</p>
                  {!killed && (
                    <Button size="sm" variant="destructive" onClick={() => kill.open(ch)} data-testid={`kill-btn-${ch}`}>
                      {t('notifOps.killNow', 'Kill channel')}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>

      <section aria-label="event states">
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
                {(eventStates.data as Row[]).map((r) => (
                  <TableRow key={`${r.event_type}:${r.channel}`} data-testid={`es-${r.event_type}:${r.channel}`}>
                    <TableCell>{String(r.event_type)}</TableCell>
                    <TableCell>{String(r.channel)}</TableCell>
                    <TableCell>{r.catalog_supported ? String(r.catalog_default) : t('notifOps.unsupported', 'unsupported')}{r.required_delivery ? ' · required' : ''}</TableCell>
                    <TableCell>{Number(r.academy_off_caps)}</TableCell>
                    <TableCell>{String(r.cron_state)}</TableCell>
                    <TableCell data-testid={`circuit-${r.event_type}:${r.channel}`}>
                      {String(r.circuit_state)}
                      {/* the trip IDENTITY the reset confirms against is DISPLAYED, verbatim */}
                      {['open', 'half_open'].includes(String(r.circuit_state)) && (
                        <>
                          <span className="block text-xs text-muted-foreground" data-testid={`circuit-detail-${r.channel}`}>
                            {String(r.circuit_reason ?? '—')} · {String(r.circuit_tripped_at ?? '—')}
                          </span>
                          <Button size="sm" variant="outline" className="mt-1"
                            onClick={() => reset.open({
                              channel: String(r.channel), state: String(r.circuit_state),
                              reason: (r.circuit_reason as string | null) ?? null,
                              tripped_at: (r.circuit_tripped_at as string | null) ?? null,
                            })}
                            data-testid={`reset-btn-${r.channel}`}>
                            {t('notifOps.reset', 'Reset…')}
                          </Button>
                        </>
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

      <section aria-label="invocations">
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
              {(invocations.data as Row[]).map((r) => (
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

      <section aria-label="outbox">
        <h2 className="font-medium">{t('notifOps.outbox', 'Outbox (7 days)')}</h2>
        <div className="flex gap-2 py-1">
          <select value={outboxChannel} onChange={(e) => { setOutboxChannel(e.target.value); outbox.reset(); }}
            data-testid="outbox-channel" className="rounded border p-1 text-sm">
            <option value="email">email</option>
            <option value="whatsapp">whatsapp</option>
          </select>
          <select value={outboxStatus} onChange={(e) => { setOutboxStatus(e.target.value); outbox.reset(); }}
            data-testid="outbox-status" className="rounded border p-1 text-sm">
            <option value="">{t('notifOps.anyStatus', 'any status')}</option>
            {['pending', 'processing', 'sent', 'failed', 'skipped'].map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
          <Button size="sm" variant="outline" onClick={() => void outbox.load(false)} disabled={outbox.busy} data-testid="outbox-load">
            {t('notifOps.load', 'Load')}
          </Button>
        </div>
        {outbox.error ? (
          <SectionError label="outbox" onRetry={() => void outbox.load(false)} />
        ) : outbox.rows ? (
          <div data-testid="outbox-list">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('notifOps.event', 'Event')}</TableHead>
                  <TableHead>{t('notifOps.status', 'Status')}</TableHead>
                  <TableHead>{t('notifOps.destination', 'Destination')}</TableHead>
                  <TableHead>{t('notifOps.reasonCol', 'Reason / error class')}</TableHead>
                  <TableHead>{t('notifOps.history', 'History')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outbox.rows.map((r) => (
                  <TableRow key={String(r.id)}>
                    <TableCell>{String(r.event_type)} · {String(r.channel)}</TableCell>
                    <TableCell>{String(r.status)} ({String(r.attempts)}/{String(r.max_attempts)})</TableCell>
                    <TableCell>{String(r.destination_redacted ?? '—')}</TableCell>
                    <TableCell>{String(r.skip_reason ?? r.error_class ?? '—')}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => void openHistory(String(r.id))} data-testid={`history-btn-${r.id}`}>
                        {t('notifOps.view', 'View')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void outbox.load(true)} disabled={outbox.busy} data-testid="outbox-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          </div>
        ) : null}
        {historyFor && (
          <div className="mt-2 rounded-md border p-3" data-testid="delivery-history">
            <p className="text-sm font-medium">{t('notifOps.historyFor', { defaultValue: 'Delivery history — {{id}}', id: historyFor })}</p>
            {historyError ? (
              <SectionError label="delivery history" onRetry={() => void openHistory(historyFor)} />
            ) : historyRows ? (
              <ul className="space-y-1 text-sm">
                {historyRows.map((h) => (
                  <li key={String(h.ref)}>{String(h.at)} · <strong>{String(h.kind)}</strong> · {String(h.a ?? '')} {String(h.b ?? '')} {String(h.c ?? '')}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <section aria-label="digest groups">
        <h2 className="font-medium">{t('notifOps.groups', 'Digest groups (7 days)')}</h2>
        <div className="flex gap-2 py-1">
          <select value={groupState} onChange={(e) => { setGroupState(e.target.value); groups.reset(); }}
            data-testid="groups-state" className="rounded border p-1 text-sm">
            <option value="">{t('notifOps.anyState', 'any state')}</option>
            {['pending', 'leased', 'prepared', 'request_ready', 'sending', 'awaiting_evidence', 'sent', 'retry_stopped', 'delivery_unknown'].map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
          <Button size="sm" variant="outline" onClick={() => void groups.load(false)} disabled={groups.busy} data-testid="groups-load">
            {t('notifOps.load', 'Load')}
          </Button>
        </div>
        {groups.error ? (
          <SectionError label="digest groups" onRetry={() => void groups.load(false)} />
        ) : groups.rows ? (
          <div data-testid="groups-list">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('notifOps.event', 'Event')}</TableHead>
                  <TableHead>{t('notifOps.state', 'State')}</TableHead>
                  <TableHead>{t('notifOps.items', 'Items')}</TableHead>
                  <TableHead>{t('notifOps.provider', 'Provider')}</TableHead>
                  <TableHead>{t('notifOps.actions', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.rows.map((r) => {
                  const preDispatch = ['pending', 'leased', 'prepared', 'request_ready'].includes(String(r.state))
                    && Number(r.provider_attempts_started) === 0 && !r.provider_message_id && !r.first_send_at && !r.uncertain_since;
                  return (
                    <TableRow key={String(r.id)}>
                      <TableCell>{String(r.event_type)} · {String(r.channel)}</TableCell>
                      <TableCell>{String(r.state)}{r.terminal_reason ? ` (${String(r.terminal_reason)})` : ''}</TableCell>
                      <TableCell>{String(r.item_count)}</TableCell>
                      <TableCell>{String(r.provider_status ?? '—')}</TableCell>
                      <TableCell>
                        {preDispatch && (
                          <Button size="sm" variant="outline"
                            onClick={() => cancel.open({ groupId: String(r.id), state: String(r.state) })}
                            data-testid={`cancel-btn-${r.id}`}>
                            {t('notifOps.cancel', 'Cancel…')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void groups.load(true)} disabled={groups.busy} data-testid="groups-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          </div>
        ) : null}
      </section>

      <section aria-label="worker runs">
        <h2 className="font-medium">{t('notifOps.runs', 'Worker runs (7 days)')}</h2>
        {runs.error ? (
          <SectionError label="worker runs" onRetry={() => void runs.load(false)} />
        ) : runs.rows === null ? (
          <Button size="sm" variant="outline" onClick={() => void runs.load(false)} disabled={runs.busy} data-testid="runs-load">
            {t('notifOps.load', 'Load')}
          </Button>
        ) : (
          <div data-testid="runs-list">
            <ul className="space-y-1 text-sm">
              {runs.rows.map((r) => (
                <li key={String(r.run_id)}>
                  {String(r.started_at)} · {String(r.channel)}/{String(r.phase)} · {String(r.status ?? 'running')} {r.ended_at ? `→ ${String(r.ended_at)}` : ''}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void runs.load(true)} disabled={runs.busy} data-testid="runs-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          </div>
        )}
      </section>

      <section aria-label="orphans">
        <h2 className="font-medium">{t('notifOps.orphans', 'Orphan provider events')}</h2>
        {orphans.error ? (
          <SectionError label="orphans" onRetry={() => void orphans.load(false)} />
        ) : orphans.rows === null ? (
          <Button size="sm" variant="outline" onClick={() => void orphans.load(false)} disabled={orphans.busy} data-testid="orphans-load">
            {t('notifOps.load', 'Load')}
          </Button>
        ) : (
          <div data-testid="orphans-list">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('notifOps.eventId', 'Event id')}</TableHead>
                  <TableHead>{t('notifOps.state', 'State')}</TableHead>
                  <TableHead>{t('notifOps.reasonCol', 'Reason')}</TableHead>
                  <TableHead>{t('notifOps.actions', 'Actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orphans.rows.map((r) => (
                  <TableRow key={String(r.resend_event_id)}>
                    <TableCell>{String(r.resend_event_id)}</TableCell>
                    <TableCell>{r.quarantined ? t('notifOps.quarantined', 'QUARANTINED') : t('notifOps.reconciling', 'reconciling')}</TableCell>
                    <TableCell>{String(r.last_error_code ?? '—')} ({String(r.attempts)})</TableCell>
                    <TableCell>
                      {Boolean(r.quarantined) && (
                        <>
                          <Button size="sm" variant="outline"
                            onClick={() => orphanOp.open({ eventId: String(r.resend_event_id), action: 'resolve' })}
                            data-testid={`orphan-resolve-${r.resend_event_id}`}>
                            {t('notifOps.resolve', 'Resolve…')}
                          </Button>
                          <Button size="sm" variant="outline" className="ml-1"
                            onClick={() => orphanOp.open({ eventId: String(r.resend_event_id), action: 'requeue' })}
                            data-testid={`orphan-requeue-${r.resend_event_id}`}>
                            {t('notifOps.requeue', 'Requeue…')}
                          </Button>
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void orphans.load(true)} disabled={orphans.busy} data-testid="orphans-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          </div>
        )}
      </section>

      <section aria-label="recipient preview">
        <h2 className="font-medium">{t('notifOps.preview', 'Recipient preview')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('notifOps.previewScope', 'Previews resolver state (preferences, caps, consent, suppression) for known users — not a producer’s audience.')}
        </p>
        <div className="flex gap-2 py-1">
          <select value={previewEvent} onChange={(e) => { setPreviewEvent(e.target.value); resetPreview(); }}
            data-testid="preview-event" className="rounded border p-1 text-sm">
            <option value="">{t('notifOps.chooseEvent', 'choose event…')}</option>
            {eventKeys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <select value={previewChannel} onChange={(e) => { setPreviewChannel(e.target.value); resetPreview(); }}
            data-testid="preview-channel" className="rounded border p-1 text-sm">
            <option value="email">email</option>
            <option value="whatsapp">whatsapp</option>
          </select>
          <Button size="sm" variant="outline" onClick={() => void loadPreview(false)} disabled={!previewEvent} data-testid="preview-load">
            {t('notifOps.preview', 'Preview')}
          </Button>
        </div>
        {previewError ? (
          <SectionError label="recipient preview" onRetry={() => void loadPreview(false)} />
        ) : previewRows ? (
          <div data-testid="preview-list">
            {previewPartial && (
              <p role="status" className="text-sm text-amber-600" data-testid="preview-partial">
                {t('notifOps.partial', 'PARTIAL: the candidate scan hit its budget — users beyond the horizon are omitted from this page; continue to crawl them.')}
              </p>
            )}
            <ul className="space-y-1 text-sm">
              {previewRows.map((r) => (
                <li key={String(r.user_id)}>
                  {String(r.destination_masked ?? '—')} · {String(r.final_decision)}
                </li>
              ))}
            </ul>
            {previewCursor && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void loadPreview(true)} data-testid="preview-more">
                {t('notifOps.more', 'Load more')}
              </Button>
            )}
          </div>
        ) : null}
      </section>

      <section aria-label="destination search">
        <h2 className="font-medium">{t('notifOps.search', 'Destination lookup')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('notifOps.searchScope', 'Exact normalized email or E.164 number only — no partial search exists, by design. Lookups are rate-limited and logged.')}
        </p>
        <div className="flex gap-2 py-1">
          <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
            placeholder="name@example.com" data-testid="search-input" className="max-w-xs" />
          <Button size="sm" variant="outline" onClick={() => void runSearch()} data-testid="search-btn">
            {t('notifOps.lookup', 'Look up')}
          </Button>
        </div>
        {searchMessage && <p role="alert" className="text-sm" data-testid="search-message">{searchMessage}</p>}
        {searchResult && (
          <p className="text-sm" data-testid="search-result">
            {String(searchResult.destination_masked)} · {t('notifOps.contacts', 'contacts')}: {String(searchResult.contacts)}{searchResult.contacts_capped ? '+' : ''} ·{' '}
            {t('notifOps.outboxRows', 'outbox')}: {String(searchResult.outbox_rows)}{searchResult.outbox_capped ? '+' : ''} ·{' '}
            {t('notifOps.deliveryEvents', 'delivery events')}: {String(searchResult.delivery_events)}{searchResult.events_capped ? '+' : ''}
          </p>
        )}
      </section>

      <section aria-label="decision audit">
        <h2 className="font-medium">{t('notifOps.audit', 'Decision audit')}</h2>
        {audit.error ? (
          <SectionError label="audit" onRetry={() => void audit.load(false)} />
        ) : audit.rows === null ? (
          <Button size="sm" variant="outline" onClick={() => void audit.load(false)} disabled={audit.busy} data-testid="audit-load">
            {t('notifOps.load', 'Load')}
          </Button>
        ) : (
          <div data-testid="audit-list">
            <ul className="space-y-1 text-sm">
              {audit.rows.map((r) => (
                <li key={String(r.id)}>
                  {String(r.created_at)} · {String(r.action)} · {String(r.target)} · {String(r.old_value)}→{String(r.new_value)} · {String(r.outcome)} · “{String(r.reason)}”
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void audit.load(true)} disabled={audit.busy} data-testid="audit-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          </div>
        )}
        <h3 className="mt-3 text-sm font-medium">{t('notifOps.rejected', 'Rejected attempts')}</h3>
        {rejected.error ? (
          <SectionError label="rejected attempts" onRetry={() => void rejected.load(false)} />
        ) : rejected.rows === null ? (
          <Button size="sm" variant="outline" onClick={() => void rejected.load(false)} disabled={rejected.busy} data-testid="rejected-load">
            {t('notifOps.load', 'Load')}
          </Button>
        ) : (
          <div data-testid="rejected-list">
            <ul className="space-y-1 text-sm">
              {rejected.rows.map((r) => (
                <li key={String(r.id)}>
                  {String(r.created_at)} · {String(r.action)} · {String(r.target)} · {String(r.conflict_with)}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void rejected.load(true)} disabled={rejected.busy} data-testid="rejected-more">
              {t('notifOps.more', 'Load more')}
            </Button>
          </div>
        )}
      </section>

      {/* KILL — reason mandatory, FROZEN after the first submit */}
      <Dialog open={!!kill.target} onOpenChange={(open) => { if (!open) kill.close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('notifOps.killTitle', { defaultValue: 'Kill the {{channel}} channel?', channel: kill.target ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('notifOps.killDesc', 'This stops sending NOW and cannot be undone from this page. A reason is required and recorded in the immutable audit.')}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={kill.reason} onChange={(e) => kill.setReason(e.target.value)}
            readOnly={kill.frozen}
            placeholder={t('notifOps.killReasonPh', 'e.g. provider incident #123 — stop all email now')}
            data-testid="kill-reason" />
          {kill.frozen && (
            <p className="text-xs text-muted-foreground" data-testid="kill-frozen-note">
              {t('notifOps.frozenNote', 'The decision is locked to this exact wording — a retry replays it. To decide differently, cancel and start a new decision.')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => kill.close()}>{t('cancel', 'Cancel')}</Button>
            <Button variant="destructive" onClick={() => void confirmKill()}
              disabled={kill.busy || kill.reason.trim().length < 3} data-testid="kill-confirm">
              {kill.busy ? t('notifOps.killing', 'Killing…') : t('notifOps.killConfirm', 'Kill channel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CIRCUIT RESET — confirms against the DISPLAYED trip identity, frozen after submit */}
      <Dialog open={!!reset.target} onOpenChange={(open) => { if (!open) reset.close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('notifOps.resetTitle', { defaultValue: 'Reset the {{channel}} circuit?', channel: reset.target?.channel ?? '' })}</DialogTitle>
            <DialogDescription data-testid="reset-identity">
              {t('notifOps.resetDesc', {
                defaultValue: 'You are confirming against exactly this trip: state {{state}}, reason {{reason}}, tripped {{tripped}}. If the circuit re-tripped since, the server refuses and you must reload.',
                state: reset.target?.state ?? '', reason: reset.target?.reason ?? '—', tripped: reset.target?.tripped_at ?? '—',
              })}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={reset.reason} onChange={(e) => reset.setReason(e.target.value)}
            readOnly={reset.frozen}
            placeholder={t('notifOps.resetReasonPh', 'e.g. provider incident resolved, dashboard green')}
            data-testid="reset-reason" />
          <DialogFooter>
            <Button variant="outline" onClick={() => reset.close()}>{t('cancel', 'Cancel')}</Button>
            <Button onClick={() => void confirmReset()}
              disabled={reset.busy || reset.reason.trim().length < 3} data-testid="reset-confirm">
              {reset.busy ? t('notifOps.resetting', 'Resetting…') : t('notifOps.resetConfirm', 'Reset circuit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* GROUP CANCEL — expected state is the row's displayed state, frozen after submit */}
      <Dialog open={!!cancel.target} onOpenChange={(open) => { if (!open) cancel.close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('notifOps.cancelTitle', 'Cancel this digest group?')}</DialogTitle>
            <DialogDescription>
              {t('notifOps.cancelDesc', {
                defaultValue: 'You are cancelling the group in state {{state}}, exactly as shown. Any send evidence refuses server-side.',
                state: cancel.target?.state ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={cancel.reason} onChange={(e) => cancel.setReason(e.target.value)}
            readOnly={cancel.frozen}
            placeholder={t('notifOps.cancelReasonPh', 'e.g. wrong audience — stop before dispatch')}
            data-testid="cancel-reason" />
          <DialogFooter>
            <Button variant="outline" onClick={() => cancel.close()}>{t('cancel', 'Cancel')}</Button>
            <Button variant="destructive" onClick={() => void confirmCancel()}
              disabled={cancel.busy || cancel.reason.trim().length < 3} data-testid="cancel-confirm">
              {cancel.busy ? t('notifOps.cancelling', 'Cancelling…') : t('notifOps.cancelConfirm', 'Cancel group')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ORPHAN resolve/requeue — frozen after submit */}
      <Dialog open={!!orphanOp.target} onOpenChange={(open) => { if (!open) orphanOp.close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {orphanOp.target?.action === 'resolve'
                ? t('notifOps.orphanResolveTitle', 'Resolve this orphan (permanent mismatch)?')
                : t('notifOps.orphanRequeueTitle', 'Requeue this orphan (transient)?')}
            </DialogTitle>
            <DialogDescription>
              {t('notifOps.orphanDesc', 'The server refuses a misclassification (permanent vs transient) with a typed verdict. Provider evidence is never deleted.')}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={orphanOp.reason} onChange={(e) => orphanOp.setReason(e.target.value)}
            readOnly={orphanOp.frozen}
            placeholder={t('notifOps.orphanReasonPh', 'e.g. confirmed tag mismatch from provider dashboard')}
            data-testid="orphan-reason" />
          <DialogFooter>
            <Button variant="outline" onClick={() => orphanOp.close()}>{t('cancel', 'Cancel')}</Button>
            <Button onClick={() => void confirmOrphan()}
              disabled={orphanOp.busy || orphanOp.reason.trim().length < 3} data-testid="orphan-confirm">
              {orphanOp.busy ? t('notifOps.working', 'Working…') : t('notifOps.orphanConfirm', 'Confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
