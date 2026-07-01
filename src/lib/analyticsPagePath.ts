/** Redact public invoice + guest booking tokens from analytics page paths. */
export function sanitizeAnalyticsPagePath(pathname: string, search = ''): string {
  if (/^\/pay\/[^/]+/.test(pathname)) {
    return '/pay/:token';
  }
  if (/^\/booking\/[^/]+/.test(pathname)) {
    return '/booking/:token';
  }
  if (/^\/academies\/[^/]+\/pay\/[^/]+/.test(pathname)) {
    return pathname.replace(/(\/academies\/[^/]+\/pay\/)[^/]+/, '$1:token');
  }
  return pathname + search;
}
