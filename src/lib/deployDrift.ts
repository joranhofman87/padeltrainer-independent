/**
 * Deploy-drift telemetry.
 *
 * Several read / scale / money paths ship a server-side RPC or edge function behind a *graceful
 * client-side fallback*: when the migration/function isn't live in prod yet, the call fails with
 * PostgREST `PGRST202` (function not in the schema cache) / Postgres `42883` (no such function),
 * and the client silently runs the legacy path. That keeps the app correct, but it also means an
 * UNAPPLIED production migration is otherwise invisible — the app quietly runs the expensive
 * unbounded scan the migration was meant to replace (see
 * docs/audits/PRODUCTION_RELEASE_LEDGER_2026-06-29.md §5: "no fallback-execution telemetry").
 *
 * `reportDeployDriftFallback` makes that visible: it fires a queryable `deploy_drift_fallback`
 * PostHog event (alert / dashboard on it) plus a `logger.warn`, so the owner learns a fallback
 * fired — i.e. a migration/function still needs deploying — instead of finding out via a slow page.
 */
import { trackEvent } from '@/lib/tracking';
import { logger } from '@/lib/logger';

/** Identifies WHICH fallback fired → maps 1:1 to the migration/function the owner must deploy. */
export type DeployDriftFeature =
  | 'get_academy_cyclus_groups'
  | 'count_cycles_intakes'
  | 'get_trainer_earnings_summary'
  | 'registration_write_rpc'
  | 'create_rebook_invoice'
  | 'cycles_public'
  | 'session_reports_player_summaries';

type DriftDetail = Record<string, string | number | boolean | null | undefined>;

/**
 * True when an error means the server function isn't live yet: PostgREST `PGRST202` (not in the
 * schema cache) or Postgres `42883` (function does not exist). Single source of truth for the
 * "missing RPC → fall back" check shared across the graceful-fallback sites.
 */
export function isMissingRpc(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'PGRST202' || code === '42883';
}

/**
 * True when an error means a table/view isn't live yet: PostgREST `PGRST205`
 * (relation not found in the schema cache), `PGRST200` (schema-cache miss), or
 * Postgres `42P01` (undefined table/view). Used by graceful fallbacks that read a
 * not-yet-deployed `_public` view and drop back to the base table. NOTE: the
 * cycles_public view must expose PLAIN columns only — a PostgREST embed on a plain
 * view raises PGRST200 too, so an embedded read would be indistinguishable from a
 * genuinely missing view and would fall back forever. Do NOT embed on _public views.
 */
export function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'PGRST205' || code === 'PGRST200' || code === '42P01';
}

/**
 * Emit a structured signal that a graceful fallback executed (its server RPC/function isn't live).
 * Never throws — telemetry must not break a fallback that is, by design, keeping the app working.
 */
export function reportDeployDriftFallback(feature: DeployDriftFeature, detail?: DriftDetail): void {
  try {
    trackEvent('deploy_drift_fallback', { feature, ...detail });
    logger.warn(`deploy-drift: '${feature}' not live in prod — running legacy fallback path`, {
      component: 'deployDrift',
      feature,
      ...detail,
    });
  } catch {
    // Telemetry is best-effort; never let it surface to the user.
  }
}
