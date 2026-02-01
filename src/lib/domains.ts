/**
 * Domain configuration for cross-domain navigation.
 * 
 * Marketing site: padeltrainer.ai
 * App: app.padeltrainer.ai
 */

export const APP_DOMAIN = 'https://app.padeltrainer.ai';
export const MARKETING_DOMAIN = 'https://padeltrainer.ai';

/**
 * Get the full URL for an app route.
 * Use this for links from the marketing site to the app.
 */
export function getAppUrl(path: string): string {
  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${APP_DOMAIN}${normalizedPath}`;
}

/**
 * Get the full URL for a marketing route.
 * Use this for links from the app to the marketing site.
 */
export function getMarketingUrl(path: string, lang: string = 'nl'): string {
  // Ensure path doesn't start with / since we're adding lang prefix
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  // If path is empty (homepage), just return domain with lang
  if (!normalizedPath) {
    return `${MARKETING_DOMAIN}/${lang}`;
  }
  return `${MARKETING_DOMAIN}/${lang}/${normalizedPath}`;
}

/**
 * Check if we're currently on the app domain.
 */
export function isOnAppDomain(): boolean {
  const hostname = window.location.hostname;
  return hostname === 'app.padeltrainer.ai';
}

/**
 * Check if we're currently on the marketing domain.
 */
export function isOnMarketingDomain(): boolean {
  const hostname = window.location.hostname;
  return hostname === 'padeltrainer.ai' || hostname === 'www.padeltrainer.ai';
}

/**
 * Check if we're in development/preview mode.
 */
export function isInDevelopment(): boolean {
  const hostname = window.location.hostname;
  return hostname === 'localhost' || 
         hostname === '127.0.0.1' || 
         hostname.includes('.lovable.app');
}

/**
 * Get the appropriate auth redirect URL based on environment.
 * In production, always redirect to app subdomain.
 * In development, use current origin.
 */
export function getAuthRedirectUrl(path: string = '/auth'): string {
  if (isInDevelopment()) {
    return `${window.location.origin}${path}`;
  }
  return getAppUrl(path);
}
