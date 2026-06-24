import type { VercelRequest, VercelResponse } from '@vercel/node';
// NOTE: explicit .js extension is REQUIRED — package.json is "type":"module", so
// @vercel/node emits ESM and Node's ESM loader does not extension-complete relative
// imports. Without it the function crashes at import with ERR_MODULE_NOT_FOUND and
// the whole daily-maintenance cron (incl. deferred-rebook invoicing) never runs.
import { alertCronFailure, invokeEdgeFunction, rejectUnauthorizedCron, verifyCronSecret } from '../_lib/cron.js';

/** Daily: backups, invoice health, enrichment, and logo batch jobs. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req)) {
    rejectUnauthorizedCron(res);
    return;
  }

  const jobs: Array<{ slug: string; body?: Record<string, unknown> }> = [
    { slug: 'backup-database' },
    { slug: 'invoice-health-check' },
    // Deferred rebooking invoicing: creates DRAFT invoices (per-group split) for
    // started cycles' commitments; academies review + send. Idempotent.
    { slug: 'generate-cycle-commitment-invoices' },
    // Backstop for email campaigns whose autonomous resume chain never completed (e.g. a
    // first invocation hard-killed before scheduling a continuation): re-triggers any
    // campaign stuck 'sending' >15min with queued recipients. No-op when none are stuck.
    { slug: 'send-campaign-emails', body: { sweep: true } },
    // NOTE: enrich-clubs + fetch-location-logos were removed here — they depend on
    // paid external APIs (Firecrawl + an AI gateway) that aren't
    // configured, so they only ever failed this cron (207). Re-add with the API keys
    // set if directory auto-enrichment is wanted again.
  ];

  const results: Record<string, unknown> = {};

  for (const { slug, body } of jobs) {
    try {
      const result = await invokeEdgeFunction(slug, body ?? {});
      results[slug] = { ok: result.ok, status: result.status, data: result.data };
    } catch (err) {
      results[slug] = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const allOk = Object.values(results).every((r) => (r as { ok?: boolean }).ok !== false);
  if (!allOk) await alertCronFailure('daily-maintenance', results);
  res.status(allOk ? 200 : 207).json({ jobs: results });
}
