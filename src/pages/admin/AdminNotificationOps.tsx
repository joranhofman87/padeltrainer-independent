import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
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
import { OpsDecisionDialog } from '@/components/notifications/admin/OpsDecisionDialog';
import { useOpsDecision } from '@/components/notifications/admin/useOpsDecision';
import type {
  Channel, DigestGroupRow, EventStateRow, GaugeRow, HistoryRow, InvocationRow, OrphanRow, ReadinessEnvelope,
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
  const { toast } = useToast();
  const qc = useQueryClient();

  const readiness = useQuery({
    queryKey: ['notif-ops', 'readiness'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_notification_readiness');
      if (error) throw error;
      return data as unknown as ReadinessEnvelope;
    },
    retry: false,
  });
  const gauges = useQuery({
    queryKey: ['notif-ops', 'gauges'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_notification_gauges');
      if (error) throw error;
      return data as GaugeRow[];
    },
    retry: false,
  });
  const eventStates = useQuery({
    queryKey: ['notif-ops', 'event-states'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_notification_event_states');
      if (error) throw error;
      return data as EventStateRow[];
    },
    retry: false,
  });
  const invocations = useQuery({
    queryKey: ['notif-ops', 'invocations'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('admin_list_worker_invocations', { p_limit: 50 });
      if (error) throw error;
      return data as InvocationRow[];
    },
    retry: false,
  });

  // delivery-history drill-down (epoch-guarded: a late response for row A must not render under B)
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<HistoryRow[] | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const historyEpoch = useRef(0);
  const openHistory = async (outboxId: string) => {
    const myEpoch = ++historyEpoch.current;
    setHistoryFor(outboxId);
    setHistoryRows(null);
    setHistoryError(false);
    const { data, error } = await supabase.rpc('admin_notification_delivery_history', { p_outbox_id: outboxId, p_limit: 50 });
    if (myEpoch !== historyEpoch.current) return;
    if (error) { setHistoryError(true); return; }
    setHistoryRows((data ?? []) as HistoryRow[]);
  };

  const frozenNote = t('notifOps.frozenNote', 'The decision is locked to this exact wording — a retry replays it. To decide differently, cancel and start a new decision.');
  const cancelLabel = t('cancel', 'Cancel');
  const refreshAll = () => void qc.invalidateQueries({ queryKey: ['notif-ops'] });

  const kill = useOpsDecision<Channel>();
  const confirmKill = () => kill.submit(async () => {
    try {
      const { data, error } = await supabase.rpc('admin_activate_channel_kill', {
        p_channel: kill.target!, p_reason: kill.reason.trim(), p_request_id: kill.requestId.current!,
      });
      if (error) throw error;
      toast({ title: t('notifOps.killVerdict', { defaultValue: 'Kill verdict: {{verdict}}', verdict: String(data) }) });
      kill.close();
      refreshAll();
    } catch (error) {
      logger.error('channel kill failed', undefined, { error });
      toast({ title: t('notifOps.killFailed', 'The kill did not go through — retry replays the SAME decision'), variant: 'destructive' });
    }
  });

  const reset = useOpsDecision<EventStateRow>();
  const confirmReset = () => reset.submit(async () => {
    try {
      const { data, error } = await supabase.rpc('admin_reset_notification_circuit', {
        p_channel: reset.target!.channel,
        p_expected_state: reset.target!.circuit_state,
        p_expected_reason: reset.target!.circuit_reason,
        p_expected_tripped_at: reset.target!.circuit_tripped_at,
        p_reason: reset.reason.trim(),
        p_request_id: reset.requestId.current!,
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
      refreshAll();
    } catch (error) {
      logger.error('circuit reset failed', undefined, { error });
      toast({ title: t('notifOps.resetFailed', 'The reset did not go through — retry replays the SAME decision'), variant: 'destructive' });
    }
  });

  const cancelGroup = useOpsDecision<DigestGroupRow>();
  const confirmCancel = () => cancelGroup.submit(async () => {
    try {
      const { data, error } = await supabase.rpc('admin_cancel_digest_group', {
        p_group_id: cancelGroup.target!.id,
        p_expected_state: cancelGroup.target!.state,
        p_reason: cancelGroup.reason.trim(),
        p_request_id: cancelGroup.requestId.current!,
      });
      if (error) throw error;
      toast({ title: t('notifOps.cancelVerdict', { defaultValue: 'Cancel verdict: {{verdict}}', verdict: String(data) }) });
      cancelGroup.close();
      reloadGroups.current?.();
    } catch (error) {
      logger.error('group cancel failed', undefined, { error });
      toast({ title: t('notifOps.cancelFailed', 'The cancel did not go through — retry replays the SAME decision'), variant: 'destructive' });
    }
  });

  const orphanOp = useOpsDecision<{ row: OrphanRow; action: 'resolve' | 'requeue' }>();
  const confirmOrphan = () => orphanOp.submit(async () => {
    try {
      const rpcName = orphanOp.target!.action === 'resolve'
        ? 'admin_resolve_notification_orphan' : 'admin_requeue_notification_orphan';
      const { data, error } = await supabase.rpc(rpcName, {
        p_resend_event_id: orphanOp.target!.row.resend_event_id,
        p_reason: orphanOp.reason.trim(),
        p_request_id: orphanOp.requestId.current!,
      });
      if (error) throw error;
      toast({ title: t('notifOps.orphanVerdict', { defaultValue: 'Orphan verdict: {{verdict}}', verdict: String(data) }) });
      orphanOp.close();
      reloadOrphans.current?.();
    } catch (error) {
      logger.error('orphan operation failed', undefined, { error });
      toast({ title: t('notifOps.orphanFailed', 'The operation did not go through — retry replays the SAME decision'), variant: 'destructive' });
    }
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
          historyFor={historyFor} historyRows={historyRows} historyError={historyError}
        />
        <DigestGroupsSection onCancel={(g) => cancelGroup.open(g)} onReady={(r) => { reloadGroups.current = r; }} />
        <WorkerRunsSection />
        <OrphanQueueSection onAct={(row, action) => orphanOp.open({ row, action })} onReady={(r) => { reloadOrphans.current = r; }} />
        <RecipientPreviewSection eventKeys={eventKeys} />
        <DestinationSearchSection />
        <DecisionAuditSection />
      </div>

      <OpsDecisionDialog
        open={!!kill.target} testId="kill" destructive
        title={t('notifOps.killTitle', { defaultValue: 'Kill the {{channel}} channel?', channel: kill.target ?? '' })}
        description={t('notifOps.killDesc', 'This stops sending NOW and cannot be undone from this page. A reason is required and recorded in the immutable audit.')}
        reason={kill.reason} onReasonChange={kill.setReason} frozen={kill.frozen} busy={kill.busy}
        confirmLabel={t('notifOps.killConfirm', 'Kill channel')} busyLabel={t('notifOps.killing', 'Killing…')}
        cancelLabel={cancelLabel} frozenNote={frozenNote}
        onCancel={kill.close} onConfirm={() => void confirmKill()}
      />
      <OpsDecisionDialog
        open={!!reset.target} testId="reset"
        title={t('notifOps.resetTitle', { defaultValue: 'Reset the {{channel}} circuit?', channel: reset.target?.channel ?? '' })}
        description={t('notifOps.resetDesc', {
          defaultValue: 'You are confirming against exactly this trip: state {{state}}, reason {{reason}}, tripped {{tripped}}. If the circuit re-tripped since, the server refuses and you must reload.',
          state: reset.target?.circuit_state ?? '', reason: reset.target?.circuit_reason ?? '—', tripped: reset.target?.circuit_tripped_at ?? '—',
        })}
        reason={reset.reason} onReasonChange={reset.setReason} frozen={reset.frozen} busy={reset.busy}
        confirmLabel={t('notifOps.resetConfirm', 'Reset circuit')} busyLabel={t('notifOps.resetting', 'Resetting…')}
        cancelLabel={cancelLabel} frozenNote={frozenNote}
        onCancel={reset.close} onConfirm={() => void confirmReset()}
      />
      <OpsDecisionDialog
        open={!!cancelGroup.target} testId="cancel" destructive
        title={t('notifOps.cancelTitle', 'Cancel this digest group?')}
        description={t('notifOps.cancelDesc', {
          defaultValue: 'You are cancelling the group in state {{state}}, exactly as shown. Any send evidence refuses server-side.',
          state: cancelGroup.target?.state ?? '',
        })}
        reason={cancelGroup.reason} onReasonChange={cancelGroup.setReason} frozen={cancelGroup.frozen} busy={cancelGroup.busy}
        confirmLabel={t('notifOps.cancelConfirm', 'Cancel group')} busyLabel={t('notifOps.cancelling', 'Cancelling…')}
        cancelLabel={cancelLabel} frozenNote={frozenNote}
        onCancel={cancelGroup.close} onConfirm={() => void confirmCancel()}
      />
      <OpsDecisionDialog
        open={!!orphanOp.target} testId="orphan"
        title={orphanOp.target?.action === 'resolve'
          ? t('notifOps.orphanResolveTitle', 'Resolve this orphan (permanent mismatch)?')
          : t('notifOps.orphanRequeueTitle', 'Requeue this orphan (transient)?')}
        description={t('notifOps.orphanDesc', 'The server refuses a misclassification (permanent vs transient) with a typed verdict. Provider evidence is never deleted.')}
        reason={orphanOp.reason} onReasonChange={orphanOp.setReason} frozen={orphanOp.frozen} busy={orphanOp.busy}
        confirmLabel={t('notifOps.orphanConfirm', 'Confirm')} busyLabel={t('notifOps.working', 'Working…')}
        cancelLabel={cancelLabel} frozenNote={frozenNote}
        onCancel={orphanOp.close} onConfirm={() => void confirmOrphan()}
      />
    </ListPageShell>
  );
}
