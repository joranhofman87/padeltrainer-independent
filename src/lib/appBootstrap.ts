/** App routes that require a resolved auth profile before rendering the shell. */
const PUBLIC_APP_PREFIXES = [
  '/app/auth',
  '/app/forgot-password',
  '/app/reset-password',
  '/app/signup',
  '/app/onboarding',
  '/app/book/',
  '/app/booking-success',
  '/app/booking-cancelled',
  '/app/api/',
] as const;

export function isAppRoute(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

export function needsAuthProfileBootstrap(pathname: string): boolean {
  if (!isAppRoute(pathname)) return false;
  return !PUBLIC_APP_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function logAppShellTransition(
  event: string,
  details: Record<string, string | boolean | number | null | undefined>,
): void {
  if (!import.meta.env.DEV) return;
  // Safe dev-only diagnostics — no PII (no emails, names, tokens).
  console.debug(`[app-shell] ${event}`, details);
}
