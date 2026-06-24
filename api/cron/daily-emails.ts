import type { VercelRequest, VercelResponse } from '@vercel/node';
// NOTE: explicit .js extension is REQUIRED — package.json is "type":"module", so
// @vercel/node emits ESM and Node's ESM loader does not extension-complete relative
// imports. Without it the function crashes at import with ERR_MODULE_NOT_FOUND.
import { invokeEdgeFunction, rejectUnauthorizedCron, verifyCronSecret } from '../_lib/cron.js';

/**
 * Daily (noon, `0 12 * * *`): onboarding-drip queue flush + the daily digest.
 *
 * Named for its actual cadence — this runs ONCE PER DAY (Vercel Hobby crons
 * can't run sub-daily). send-digest-emails must stay daily (it drains a full
 * day's notification_queue into one digest per user). process-onboarding-emails
 * would ideally run hourly so drips go out nearer their scheduled time; if that
 * becomes important, move JUST that job to Supabase pg_cron (the digest stays
 * here, daily).
 */
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
