import type { VercelRequest, VercelResponse } from '@vercel/node';
import { invokeEdgeFunction, rejectUnauthorizedCron, verifyCronSecret } from '../_lib/cron';

/** Daily: backups, invoice health, enrichment + logo batch (replaces Lovable external cron). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req)) {
    rejectUnauthorizedCron(res);
    return;
  }

  const jobs: Array<{ slug: string; body?: Record<string, unknown> }> = [
    { slug: 'backup-database' },
    { slug: 'invoice-health-check' },
    { slug: 'enrich-clubs', body: { batch_size: 5, fill_missing_only: true } },
    { slug: 'fetch-location-logos', body: { batch_size: 10 } },
    // Deferred rebooking invoicing: creates DRAFT invoices (per-group split) for
    // started cycles' commitments; academies review + send. Idempotent.
    { slug: 'generate-cycle-commitment-invoices' },
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
  res.status(allOk ? 200 : 207).json({ jobs: results });
}
