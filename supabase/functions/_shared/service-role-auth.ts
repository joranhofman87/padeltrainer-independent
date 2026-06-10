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

function projectRefFromSupabaseUrl(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return match?.[1] ?? null;
}

/** Decode Supabase JWT claims without signature verification (fallback only). */
export function parseSupabaseJwtClaims(
  token: string,
): { role?: string; ref?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/** True when token is a service_role JWT for this project (env missing fallback). */
export function isServiceRoleJwtForProject(token: string): boolean {
  const claims = parseSupabaseJwtClaims(token);
  if (!claims || claims.role !== "service_role") return false;
  const projectRef = projectRefFromSupabaseUrl(Deno.env.get("SUPABASE_URL"));
  if (projectRef && claims.ref && claims.ref !== projectRef) return false;
  return true;
}

/**
 * True when request carries the service-role key via Authorization and/or apikey.
 * Accepts env string match OR matching service_role JWT in both headers (dashboard/env drift).
 */
export function isServiceRoleRequest(req: Request): boolean {
  const envKey = getEnvServiceRoleKey();
  const authHeader = req.headers.get("Authorization");
  const apiKey = req.headers.get("apikey")?.trim() ?? null;
  const bearerToken = extractBearerToken(authHeader);

  if (envKey) {
    if (authHeader?.trim() === `Bearer ${envKey}`) return true;
    if (bearerToken && bearerToken === envKey) return true;
    if (apiKey && apiKey === envKey) return true;
  }

  // Agreed service_role JWT in Authorization + apikey (valid when env compare fails).
  if (bearerToken && apiKey && bearerToken === apiKey && isServiceRoleJwtForProject(bearerToken)) {
    return true;
  }

  return false;
}

/** Service-role key for Supabase client: env match first, then agreed request JWT. */
export function resolveServiceRoleToken(req: Request): string | null {
  const envKey = getEnvServiceRoleKey();
  const bearerToken = extractBearerToken(req.headers.get("Authorization"));
  const apiKey = req.headers.get("apikey")?.trim() ?? null;

  if (envKey) {
    if (bearerToken && bearerToken === envKey) return envKey;
    if (apiKey && apiKey === envKey) return envKey;
    if (req.headers.get("Authorization")?.trim() === `Bearer ${envKey}`) return envKey;
  }

  if (bearerToken && apiKey && bearerToken === apiKey && isServiceRoleJwtForProject(bearerToken)) {
    return bearerToken;
  }

  return envKey ?? null;
}
