/** Service-role detection for edge function internal/server calls. */

export function getEnvServiceRoleKey(): string | undefined {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return key?.trim() || undefined;
}

/** Case-insensitive Bearer extraction with trim. */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export type ServiceRoleAuthDebug = {
  hasAuthorizationHeader: boolean;
  hasApiKeyHeader: boolean;
  authHeaderStartsWithBearer: boolean;
  tokenLength: number;
  apiKeyLength: number;
  envServiceRoleKeyExists: boolean;
  envServiceRoleKeyLength: number;
  tokenEqualsServiceRoleKey: boolean;
  apiKeyEqualsServiceRoleKey: boolean;
};

/** Safe auth debug — never logs token values. */
export function buildServiceRoleAuthDebug(req: Request): ServiceRoleAuthDebug {
  const envKey = getEnvServiceRoleKey();
  const authHeader = req.headers.get("Authorization");
  const apiKeyHeader = req.headers.get("apikey");
  const bearerToken = extractBearerToken(authHeader);
  const apiKey = apiKeyHeader?.trim() ?? null;

  return {
    hasAuthorizationHeader: !!authHeader,
    hasApiKeyHeader: !!apiKeyHeader,
    authHeaderStartsWithBearer: !!authHeader && /^Bearer\s+/i.test(authHeader),
    tokenLength: bearerToken?.length ?? 0,
    apiKeyLength: apiKey?.length ?? 0,
    envServiceRoleKeyExists: !!envKey,
    envServiceRoleKeyLength: envKey?.length ?? 0,
    tokenEqualsServiceRoleKey: !!(envKey && bearerToken && bearerToken === envKey),
    apiKeyEqualsServiceRoleKey: !!(envKey && apiKey && apiKey === envKey),
  };
}

/**
 * Constant-time string equality. Avoids leaking the service-role key through
 * comparison timing. Length mismatch folds into the result (never early-returns
 * on a per-character difference).
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const max = Math.max(ab.length, bb.length);
  for (let i = 0; i < max; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * True ONLY when the request carries the project's real service-role key
 * (byte-for-byte) via `Authorization: Bearer <key>`, a bare `Authorization`
 * value, or the `apikey` header.
 *
 * There is deliberately NO claims-only JWT fallback: a `service_role` JWT is
 * trusted only when it exactly equals the configured `SUPABASE_SERVICE_ROLE_KEY`.
 * Decoding a token's claims without verifying its signature (as a previous
 * fallback did) let anyone forge an unsigned `{role:'service_role'}` token and
 * obtain a real RLS-bypassing client — a full unauthenticated cross-tenant
 * breach. Fails closed when the env key is unset.
 *
 * Operational note: legitimate service-role callers (the Vercel daily cron via
 * `invokeEdgeFunction`, and pg_cron via `app.settings.service_role_key`) all send
 * this exact key. After a service-role key rotation, the caller env AND the
 * function secret must both be updated to the new key, or these calls 401 until
 * they are — that config-sync burden is the correct cost of not trusting
 * unsigned claims.
 */
export function isServiceRoleRequest(req: Request): boolean {
  const envKey = getEnvServiceRoleKey();
  if (!envKey) return false;

  const authHeader = req.headers.get("Authorization");
  const bearerToken = extractBearerToken(authHeader);
  const apiKey = req.headers.get("apikey")?.trim() ?? null;
  const rawAuth = authHeader?.trim() ?? null;

  if (bearerToken && timingSafeEqual(bearerToken, envKey)) return true;
  if (apiKey && timingSafeEqual(apiKey, envKey)) return true;
  // Some callers send a bare (non-"Bearer ") Authorization value.
  if (rawAuth && rawAuth !== bearerToken && timingSafeEqual(rawAuth, envKey)) return true;

  return false;
}

/**
 * The service-role key to build a Supabase client with, or null. Always returns
 * the configured ENV key (never a token taken from the request), and only when
 * the request is a verified service-role request — so a client can never be
 * built from an attacker-supplied token.
 */
export function resolveServiceRoleToken(req: Request): string | null {
  const envKey = getEnvServiceRoleKey();
  if (!envKey) return null;
  return isServiceRoleRequest(req) ? envKey : null;
}
