import type { VercelRequest, VercelResponse } from '@vercel/node';
import { invokeEdgeFunction, rejectUnauthorizedCron, verifyCronSecret } from '../_lib/cron';

/** Hourly: onboarding drip + digest emails (replaces Lovable external cron). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req)) {
    rejectUnauthorizedCron(res);
    return;
  }

  const jobs = ['process-onboarding-emails', 'send-digest-emails'] as const;
  const results: Record<string, unknown> = {};

  for (const slug of jobs) {
    try {
      const result = await invokeEdgeFunction(slug, {});
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
