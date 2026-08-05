import type { Database } from '@/integrations/supabase/types';

/**
 * TYPED row models for the N4 admin surface — every shape comes from the generated RPC types,
 * so a migration that changes a projection breaks the build instead of silently mismatching a
 * `Record<string, unknown>` cast (the page-wide any-shape the UI standards forbid).
 */
type Fn = Database['public']['Functions'];

export type ReadinessCheck = { id: string; status: string; detail: string; value?: number; capped?: boolean };
export type ReadinessEnvelope = { schema_version: number; as_of: string; readiness: string; checks: ReadinessCheck[] };

export type GaugeRow = Fn['admin_notification_gauges']['Returns'][number];
export type EventStateRow = Fn['admin_notification_event_states']['Returns'][number];
export type InvocationRow = Fn['admin_list_worker_invocations']['Returns'][number];
export type OutboxRow = Fn['admin_list_notification_outbox']['Returns'][number];
export type DigestGroupRow = Fn['admin_list_digest_groups']['Returns'][number];
export type WorkerRunRow = Fn['admin_list_worker_runs']['Returns'][number];
export type OrphanRow = Fn['admin_list_notification_orphans']['Returns'][number];
export type AuditRow = Fn['admin_list_notification_audit']['Returns'][number];
export type RejectedRow = Fn['admin_list_notification_rejected']['Returns'][number];
export type HistoryRow = Fn['admin_notification_delivery_history']['Returns'][number];
export type DecisionRow = Fn['admin_preview_notification_decision']['Returns'][number];
export type PreviewRow = Fn['admin_preview_notification_recipients']['Returns'][number];
export type SearchRow = Fn['admin_search_notification_destination']['Returns'][number];
export type BoundaryRow = Fn['admin_notification_activation_boundaries']['Returns'][number];

export const CHANNELS = ['email', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/** The pre-dispatch, evidence-free shape the server will accept a cancel for (M5's rule,
 *  mirrored so the UI only offers the control where it can succeed). */
export function isCancellableGroup(g: DigestGroupRow): boolean {
  return ['pending', 'leased', 'prepared', 'request_ready'].includes(g.state)
    && Number(g.provider_attempts_started) === 0
    && !g.provider_message_id
    && !g.first_send_at
    && !g.uncertain_since;
}
