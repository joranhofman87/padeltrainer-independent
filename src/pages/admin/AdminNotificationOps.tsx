import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { ReadinessPanel } from '@/components/notifications/admin/ReadinessPanel';
import { ChannelKillPanel } from '@/components/notifications/admin/ChannelKillPanel';
import { EventStatesSection } from '@/components/notifications/admin/EventStatesSection';
import { InvocationsSection } from '@/components/notifications/admin/InvocationsSection';
import { NotificationOutboxSection } from '@/components/notifications/admin/NotificationOutboxSection';
import { DigestGroupsSection } from '@/components/notifications/admin/DigestGroupsSection';
import { WorkerRunsSection } from '@/components/notifications/admin/WorkerRunsSection';
import { OrphanQueueSection } from '@/components/notifications/admin/OrphanQueueSection';
import { RecipientPreviewSection } from '@/components/notifications/admin/RecipientPreviewSection';
import { DestinationSearchSection } from '@/components/notifications/admin/DestinationSearchSection';
import { DecisionAuditSection } from '@/components/notifications/admin/DecisionAuditSection';
import { ActivationBoundariesSection } from '@/components/notifications/admin/ActivationBoundariesSection';
import { StaleOutboxSection } from '@/components/notifications/admin/StaleOutboxSection';
import { OpsDecisionDialog } from '@/components/notifications/admin/OpsDecisionDialog';
import { useOpsAction, disposeStaleOutbox } from '@/components/notifications/admin/useOpsDecision';
import { useOpsRead } from '@/components/notifications/admin/useOpsRead';
import type {
  BoundaryRow, Channel, DigestGroupRow, EventStateRow, GaugeRow, HistoryRow, InvocationRow, OrphanRow,
  ReadinessEnvelope, StaleOutboxRow,
} from '@/components/notifications/admin/types';

/**
 * N4 M7 — the platform-admin notification operations page: a THIN ORCHESTRATOR.
 *
 * It owns only what is genuinely page-level: the four always-on reads, the four decisions (each
 * on the shared registry contract — one request id per decision, inputs frozen on submit, typed
 * verdicts handled as values), and the delivery-history drill-down state the outbox section
 * renders. Everything else lives in `@/components/notifications/admin/*` per
 * docs/UI_COMPONENT_STANDARDS.md: page chrome from `ListPageShell`, data states from
 * `ListPageState`, every table on the `DataTable` engine with `compact`.
 */
export default function AdminNotificationOps() {
  const { t } = useTranslation('admin');
  const qc = useQueryClient();

  // the always-on reads: same shape every time (named RPC → typed rows, no retry, so a failure
  // is SHOWN rather than hidden behind a retrying spinner)
  const readiness = useOpsRead<ReadinessEnvelope>('readiness', 'admin_notification_readiness');
  const gauges = useOpsRead<GaugeRow[]>('gauges', 'admin_notification_gauges');
  const eventStates = useOpsRead<EventStateRow[]>('event-states', 'admin_notification_event_states');
  const invocations = useOpsRead<InvocationRow[]>('invocations', 'admin_list_worker_invocations', { p_limit: 50 });
  const boundaries = useOpsRead<BoundaryRow[]>('boundaries', 'admin_notification_activation_boundaries');

  // delivery-history drill-down (epoch-guarded: a late response for row A must not render under B)
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryRow[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const historyEpoch = useRef(0);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const HISTORY_PAGE = 50;
  const openHistory = async (outboxId: string, more = false) => {
    const myEpoch = ++historyEpoch.current;
    if (!more) {
      setHistoryFor(outboxId);
      setHistoryRows(null);
      setHistoryExhausted(false);
    }
    setHistoryError(false);
    // the timeline is keyset-paginated too: a row with >50 events must not silently truncate
    const last = more && historyRows?.length ? historyRows[historyRows.length - 1] : null;
    const { data, error } = await supabase.rpc('admin_notification_delivery_history', {
      p_outbox_id: outboxId,
      p_before_at: last ? last.at : undefined,      // verbatim strings, microseconds intact
      p_before_ref: last ? last.ref : undefined,
      p_limit: HISTORY_PAGE,
    });
    if (myEpoch !== historyEpoch.current) return;
    if (error) { setHistoryError(true); return; }
    const page = (data ?? []) as HistoryRow[];
    setHistoryExhausted(page.length < HISTORY_PAGE);
    setHistoryRows((prev) => (more && prev ? [...prev, ...page] : page));
  };

  // the disposal's count comes back beside its verdict; the toast reads both
  const lastDisposed = useRef(0);
  const refreshAll = () => void qc.invalidateQueries({ queryKey: ['notif-ops'] });

  // Every control below is the SAME decision contract (one request id, inputs frozen on submit,
  // typed verdict handled as a value, operator told what the SERVER decided); useOpsAction owns
  // that half, and each control keeps only what is genuinely its own — which RPC, which
  // arguments, how its verdict reads.
  const kill = useOpsAction<Channel>({
    run: async (channel, reason, requestId) => {
      const { data, error } = await supabase.rpc('admin_activate_channel_kill', {
        p_channel: channel, p_reason: reason, p_request_id: requestId,
      });
      if (error) throw error;
      return String(data);
    },
    describe: (verdict) => t('notifOps.killVerdict', { defaultValue: 'Kill verdict: {{verdict}}', verdict }),
    failureTitle: t('notifOps.killFailed', 'The kill did not go through — retry replays the SAME decision'),
    onApplied: refreshAll,
  });

  const reset = useOpsAction<EventStateRow>({
    run: async (row, reason, requestId) => {
      const { data, error } = await supabase.rpc('admin_reset_notification_circuit', {
        p_channel: row.channel,
        p_expected_state: row.circuit_state,
        p_expected_reason: row.circuit_reason,
        p_expected_tripped_at: row.circuit_tripped_at,
        p_reason: reason,
        p_request_id: requestId,
      });
      if (error) throw error;
      return String(data);
    },
    describe: (verdict) => (verdict === 'rejected_stale_state'
      ? t('notifOps.staleReset', 'The circuit changed since this screen loaded — reload and confirm against the CURRENT trip')
      : t('notifOps.resetVerdict', { defaultValue: 'Circuit reset verdict: {{verdict}}', verdict })),
    failureTitle: t('notifOps.resetFailed', 'The reset did not go through — retry replays the SAME decision'),
    onApplied: refreshAll,
  });

  const cancelGroup = useOpsAction<DigestGroupRow>({
    run: async (group, reason, requestId) => {
      const { data, error } = await supabase.rpc('admin_cancel_digest_group', {
        p_group_id: group.id, p_expected_state: group.state, p_reason: reason, p_request_id: requestId,
      });
      if (error) throw error;
      return String(data);
    },
    describe: (verdict) => t('notifOps.cancelVerdict', { defaultValue: 'Cancel verdict: {{verdict}}', verdict }),
    failureTitle: t('notifOps.cancelFailed', 'The cancel did not go through — retry replays the SAME decision'),
    onApplied: () => reloadGroups.current?.(),
  });

  const orphanOp = useOpsAction<{ row: OrphanRow; action: 'resolve' | 'requeue' }>({
    run: async (target, reason, requestId) => {
      const { data, error } = await supabase.rpc(
        target.action === 'resolve' ? 'admin_resolve_notification_orphan' : 'admin_requeue_notification_orphan',
        { p_resend_event_id: target.row.resend_event_id, p_reason: reason, p_request_id: requestId },
      );
      if (error) throw error;
      return String(data);
    },
    describe: (verdict) => t('notifOps.orphanVerdict', { defaultValue: 'Orphan verdict: {{verdict}}', verdict }),
    failureTitle: t('notifOps.orphanFailed', 'The operation did not go through — retry replays the SAME decision'),
    onApplied: () => reloadOrphans.current?.(),
  });

  // N5 — disposing the backlog a path's boundary has made permanently ineligible. Its only
  // effect is pending -> skipped; no arm of it can start a send.
  const disposeBacklog = useOpsAction<BoundaryRow>({
    run: async (row, reason, requestId) => {
      const { data, error } = await supabase.rpc('admin_dispose_pre_boundary_backlog', {
        p_path: row.path, p_reason: reason, p_request_id: requestId, p_limit: 500,
      });
      if (error) throw error;
      const first = (data as { verdict: string; disposed: number }[] | null)?.[0];
      lastDisposed.current = first?.disposed ?? 0;
      return String(first?.verdict ?? 'unknown');
    },
    describe: (verdict) => t('notifOps.disposeVerdict', {
      defaultValue: 'Backlog verdict: {{verdict}} ({{n}} row(s))', verdict, n: lastDisposed.current,
    }),
    failureTitle: t('notifOps.disposeFailed', 'The disposal did not go through — retry replays the SAME decision'),
    onApplied: refreshAll,
  });

  // the long-outage recovery: admin-gated RPCs the runbook cannot call (psql carries no JWT), so
  // this page is where they live — with the same decision contract as every other control.
  const staleDispose = useOpsAction<{ channel: Channel; olderThanMinutes: number; row: StaleOutboxRow }>({
    run: async (target, reason, requestId) => {
      const r = await disposeStaleOutbox(target, reason, requestId);
      lastDisposed.current = r.disposed;
      return r.verdict;
    },
    describe: (verdict) => t('notifOps.staleVerdict', {
      defaultValue: 'Stale disposal: {{verdict}} ({{n}} row(s))', verdict, n: lastDisposed.current,
    }),
    failureTitle: t('notifOps.staleFailed', 'The disposal did not go through — retry replays the SAME decision'),
    onApplied: refreshAll,
  });

  // reload handles the sections publish — a successful decision MUST refresh the list it acted
  // on (the extraction would otherwise leave a cancelled group on screen, inviting a re-decision)
  const reloadGroups = useRef<(() => void) | null>(null);
  const reloadOrphans = useRef<(() => void) | null>(null);

  const eventKeys = Array.from(new Set((eventStates.data ?? []).map((r) => r.event_type)));

  return (
    <ListPageShell
      title={t('notifOps.title', 'Notification operations')}
      description={t('notifOps.description', 'Platform-wide notification state, evidence and disable-only controls.')}
      width="wide"
      headerAfter={
        // THE VISIBLE ENV LINE — plain page text, deliberately not a tooltip
        <p className="mt-2 text-xs text-muted-foreground" data-testid="env-line">
          {t('notifOps.envLine', 'DIGEST_SEND_ENABLED is an edge environment switch that cannot be verified from this page or from SQL — treat every digest-send conclusion below as unverified until the operator confirms the switch.')}
        </p>
      }
    >
      <div className="space-y-6" data-testid="admin-notification-ops">
        <ReadinessPanel
          envelope={readiness.data} isLoading={readiness.isLoading} isError={readiness.isError}
          onRetry={() => void readiness.refetch()}
        />
        <ActivationBoundariesSection
          rows={boundaries.data} isLoading={boundaries.isLoading} isError={boundaries.isError}
          onRetry={() => void boundaries.refetch()} onDispose={(row) => disposeBacklog.open(row)}
        />
        <ChannelKillPanel
          gauges={gauges.data} isLoading={gauges.isLoading} isError={gauges.isError}
          onRetry={() => void gauges.refetch()} onKill={(ch) => kill.open(ch)}
        />
        <EventStatesSection
          rows={eventStates.data} isLoading={eventStates.isLoading} isError={eventStates.isError}
          onRetry={() => void eventStates.refetch()} onResetCircuit={(row) => reset.open(row)}
        />
        <InvocationsSection
          rows={invocations.data} isLoading={invocations.isLoading} isError={invocations.isError}
          onRetry={() => void invocations.refetch()}
        />
        <NotificationOutboxSection
          onOpenHistory={(id) => void openHistory(id)}
          onMoreHistory={() => { if (historyFor) void openHistory(historyFor, true); }}
          historyFor={historyFor} historyRows={historyRows} historyError={historyError}
          historyExhausted={historyExhausted}
        />
        <DigestGroupsSection onCancel={(g) => cancelGroup.open(g)} onReady={(r) => { reloadGroups.current = r; }} />
        <WorkerRunsSection />
        <OrphanQueueSection onAct={(row, action) => orphanOp.open({ row, action })} onReady={(r) => { reloadOrphans.current = r; }} />
        <RecipientPreviewSection eventKeys={eventKeys} />
        <StaleOutboxSection onDispose={(target) => staleDispose.open(target)} />
        <DestinationSearchSection />
        <DecisionAuditSection />
      </div>

      <OpsDecisionDialog
        decision={kill} testId="kill" destructive
        title={t('notifOps.killTitle', { defaultValue: 'Kill the {{channel}} channel?', channel: kill.target ?? '' })}
        description={t('notifOps.killDesc', 'This stops sending NOW and cannot be undone from this page. A reason is required and recorded in the immutable audit.')}
        confirmLabel={t('notifOps.killConfirm', 'Kill channel')} busyLabel={t('notifOps.killing', 'Killing…')}
      />
      <OpsDecisionDialog
        decision={staleDispose} testId="stale" destructive
        title={t('notifOps.staleTitle', 'Dispose the rows this outage left behind?')}
        description={t('notifOps.staleDialogDesc', {
          defaultValue: 'Exactly the {{n}} {{channel}} row(s) you were just shown — those untouched since {{cutoff}} — are marked skipped (stale_after_outage). If anything has changed since you looked, this is refused rather than applied. A row a worker holds right now is never touched, and nothing is re-sent: this stops mail that resuming would otherwise send late, possibly twice.',
          channel: staleDispose.target?.channel ?? '',
          cutoff: staleDispose.target?.row.cutoff_at ?? '',
          n: (staleDispose.target?.row.pending ?? 0) + (staleDispose.target?.row.abandoned_processing ?? 0),
        })}
        confirmLabel={t('notifOps.staleConfirm', 'Dispose')} busyLabel={t('notifOps.staleBusy', 'Disposing…')}
      />
      <OpsDecisionDialog
        decision={disposeBacklog} testId="dispose" destructive
        title={t('notifOps.disposeTitle', { defaultValue: 'Dispose the {{path}} backlog?', path: disposeBacklog.target?.path ?? '' })}
        description={t('notifOps.disposeDesc', {
          defaultValue: 'Up to 500 pending rows created before {{since}} are marked skipped (pre_activation_boundary). They can never send — this only makes the queue say so. Nothing is re-sent, and nothing returns to pending.',
          since: disposeBacklog.target?.boundary_at ?? '',
        })}
        confirmLabel={t('notifOps.disposeConfirm', 'Dispose backlog')} busyLabel={t('notifOps.disposing', 'Disposing…')}
      />
      <OpsDecisionDialog
        decision={reset} testId="reset"
        title={t('notifOps.resetTitle', { defaultValue: 'Reset the {{channel}} circuit?', channel: reset.target?.channel ?? '' })}
        description={t('notifOps.resetDesc', {
          defaultValue: 'You are confirming against exactly this trip: state {{state}}, reason {{reason}}, tripped {{tripped}}. If the circuit re-tripped since, the server refuses and you must reload.',
          state: reset.target?.circuit_state ?? '', reason: reset.target?.circuit_reason ?? '—', tripped: reset.target?.circuit_tripped_at ?? '—',
        })}
        confirmLabel={t('notifOps.resetConfirm', 'Reset circuit')} busyLabel={t('notifOps.resetting', 'Resetting…')}
      />
      <OpsDecisionDialog
        decision={cancelGroup} testId="cancel" destructive
        title={t('notifOps.cancelTitle', 'Cancel this digest group?')}
        description={t('notifOps.cancelDesc', {
          defaultValue: 'You are cancelling the group in state {{state}}, exactly as shown. Any send evidence refuses server-side.',
          state: cancelGroup.target?.state ?? '',
        })}
        confirmLabel={t('notifOps.cancelConfirm', 'Cancel group')} busyLabel={t('notifOps.cancelling', 'Cancelling…')}
      />
      <OpsDecisionDialog
        decision={orphanOp} testId="orphan"
        title={orphanOp.target?.action === 'resolve'
          ? t('notifOps.orphanResolveTitle', 'Resolve this orphan (permanent mismatch)?')
          : t('notifOps.orphanRequeueTitle', 'Requeue this orphan (transient)?')}
        description={t('notifOps.orphanDesc', 'The server refuses a misclassification (permanent vs transient) with a typed verdict. Provider evidence is never deleted.')}
        confirmLabel={t('notifOps.orphanConfirm', 'Confirm')} busyLabel={t('notifOps.working', 'Working…')}
      />
    </ListPageShell>
  );
}
