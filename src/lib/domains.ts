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
 * @deprecated No longer needed. Kept as alias for MARKETING_DOMAIN for backward compat in SEO.
 */
export const APP_DOMAIN = MARKETING_DOMAIN;

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
 * Get the appropriate auth redirect URL based on environment.
 * Always returns a full URL for OAuth/email redirects.
 */
export function getAuthRedirectUrl(path: string = '/app/auth'): string {
  return `${window.location.origin}${path}`;
}

/**
 * @deprecated No longer needed — everything is same-origin.
 */
export function isOnAppDomain(): boolean {
  return true;
}

/**
 * @deprecated No longer needed — everything is same-origin.
 */
export function isOnMarketingDomain(): boolean {
  return true;
}

/**
 * @deprecated No longer needed — everything is same-origin.
 */
export function isInDevelopment(): boolean {
  return true;
}
