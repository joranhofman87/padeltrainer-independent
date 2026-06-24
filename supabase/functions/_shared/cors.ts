// Shared CORS helper.
//
// Public functions can keep using the wide-open `*` headers exported as
// `corsHeaders`. Admin / privileged functions should call `restrictedCors(req)`
// to echo back only whitelisted origins.

const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  /^https:\/\/padeltrainer\.ai$/,
  /^https:\/\/www\.padeltrainer\.ai$/,
  /^https:\/\/[^/]+\.vercel\.app$/,
  /^https:\/\/padeltrainer\.com$/,
  /^https:\/\/www\.padeltrainer\.com$/,
  /^http:\/\/localhost:8080$/,
  /^http:\/\/localhost:5173$/,
  /^http:\/\/localhost(:\d+)?$/,
];

const FALLBACK_ORIGIN = "https://padeltrainer.ai";

const SHARED_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": SHARED_HEADERS,
};

export function restrictedCors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : FALLBACK_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": SHARED_HEADERS,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

/** Extra exact origins via env (comma-separated), e.g. a future branded domain. */
function envAllowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Origin allow-list CORS for public abuse-surface endpoints (defense in depth).
 * Echoes the request Origin when it matches the allow-list (or the
 * ALLOWED_ORIGINS env override); unknown browser origins get the primary
 * domain back, so their cross-origin reads fail. Requests WITHOUT an Origin
 * header (server-to-server, webhooks, curl) keep the legacy wide-open headers
 * and are unaffected.
 */
export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return { ...corsHeaders };
  const allowed = ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin)) ||
    envAllowedOrigins().includes(origin.replace(/\/+$/, ""));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : FALLBACK_ORIGIN,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": SHARED_HEADERS,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}
