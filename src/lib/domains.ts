/**
 * Domain configuration for single-domain path-based routing.
 * 
 * Marketing pages: padeltrainer.ai/:lang/*
 * App pages: padeltrainer.ai/app/*
 * 
 * All routes live under one domain — no more cross-subdomain issues.
 */

export const MARKETING_DOMAIN = 'https://padeltrainer.ai';

/**
 * Get the path for an app route.
 * All app routes are prefixed with /app.
 */
export function getAppUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `/app${normalizedPath}`;
}

/**
 * Get the full URL for a marketing route (for sharing / canonical URLs).
 * Returns a full URL with domain for sharing, or a relative path for navigation.
 */
export function getMarketingUrl(path: string, lang: string = 'nl'): string {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  if (!normalizedPath) {
    return `${MARKETING_DOMAIN}/${lang}`;
  }
  return `${MARKETING_DOMAIN}/${lang}/${normalizedPath}`;
}

/**
 * Get a relative marketing path for internal navigation.
 */
export function getMarketingPath(path: string, lang: string = 'nl'): string {
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  if (!normalizedPath) {
    return `/${lang}`;
  }
  return `/${lang}/${normalizedPath}`;
}

/**
 * Short, social-friendly share URL for an academy public profile.
 * Resolves via the unlocalized `/a/:slug` route which redirects to the
 * canonical localized academy page.
 */
export function getAcademyShortUrl(slug: string): string {
  return `${MARKETING_DOMAIN}/a/${slug}`;
}

/**
 * Short, social-friendly share URL for a trainer public profile.
 * Resolves via the unlocalized `/t/:slug` route which redirects to the
 * canonical localized trainer page.
 */
export function getTrainerShortUrl(slug: string): string {
  return `${MARKETING_DOMAIN}/t/${slug}`;
}

/**
 * Absolute URL for a GENERIC short link (padeltrainer.ai/s/<code>), resolved by the Cloudflare Worker
 * → 301 to the target. Distinct from the /t/ /a/ PROFILE slug links above: this is the code-based
 * short_links system (src/lib/shortLinks.ts). The code charset/length must stay within the worker's
 * `^/s/([0-9A-Za-z]{4,16})$` regex — see src/test/shortLinkContract.test.ts.
 */
export function getShortUrl(code: string): string {
  return `${MARKETING_DOMAIN}/s/${code}`;
}

/**
 * Get the appropriate auth redirect URL based on environment.
 * Always returns a full URL for OAuth/email redirects.
 */
export function getAuthRedirectUrl(path: string = '/app/auth'): string {
  return `${window.location.origin}${path}`;
}
