import type { VercelRequest, VercelResponse } from '@vercel/node';

const FICWB_FUNCTIONS_BASE = 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1';

export function verifyCronSecret(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${secret}`;
}

export function rejectUnauthorizedCron(res: VercelResponse): void {
  res.status(401).json({ error: 'Unauthorized' });
}

/** Invoke a Supabase edge function with service role (server-only env). */
export async function invokeEdgeFunction(
  slug: string,
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }

  // Send BOTH the apikey and Authorization headers (the standard Supabase pair).
  // The edge functions authenticate the service role via isServiceRoleRequest, which
  // first tries a byte-equality match against the runtime-injected
  // SUPABASE_SERVICE_ROLE_KEY. When JWT signing keys have been rotated, this Vercel
  // key can be a different *string* than the injected one even though both are valid
  // service-role JWTs for the project — the byte match then fails. Supplying apikey ==
  // Authorization lets the function fall back to validating the service_role JWT
  // claims (isServiceRoleJwtForProject), which is robust to that key-string drift.
  const response = await fetch(`${FICWB_FUNCTIONS_BASE}/${slug}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // keep raw text
  }

  return { ok: response.ok, status: response.status, data };
}

/**
 * Slack-alert on cron sub-job failures via the slack-notify edge function. Without this
 * a failed nightly backup / stalled rebooking-invoice minter / thrown digest is invisible
 * (Vercel doesn't page on cron non-2xx). Never throws — alerting must not break the cron.
 */
export async function alertCronFailure(
  cronName: string,
  results: Record<string, unknown>,
): Promise<void> {
  const failed = Object.entries(results)
    .filter(([, r]) => (r as { ok?: boolean }).ok === false)
    .map(([slug]) => slug);
  if (failed.length === 0) return;
  try {
    await invokeEdgeFunction('slack-notify', {
      event: 'edge_function_error',
      data: {
        function: `${cronName} (Vercel cron)`,
        error: `Failed jobs: ${failed.join(', ')}`,
        jobs: results,
      },
    });
  } catch {
    // Alerting must never break the cron response.
  }
}

export async function runCronHandler(
  req: VercelRequest,
  res: VercelResponse,
  slug: string,
  body: Record<string, unknown> = {},
): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!verifyCronSecret(req)) {
    rejectUnauthorizedCron(res);
    return;
  }

  try {
    const result = await invokeEdgeFunction(slug, body);
    res.status(result.ok ? 200 : 502).json({
      slug,
      status: result.status,
      result: result.data,
    });
  } catch (err) {
    res.status(500).json({
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
