/**
 * Cookie-based storage adapter for Supabase auth.
 *
 * Stores the session token in a cookie scoped to `.padeltrainer.ai`
 * so it is readable on both the marketing site and the app subdomain.
 *
 * In development / preview environments the domain attribute is omitted
 * so the cookie is scoped to the current origin only.
 */

function isProduction(): boolean {
  const h = typeof window !== 'undefined' ? window.location.hostname : '';
  return h === 'padeltrainer.ai' || h === 'www.padeltrainer.ai' || h === 'app.padeltrainer.ai';
}

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days: number): void {
  if (typeof document === 'undefined') return;
  const maxAge = days * 24 * 60 * 60;
  let cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
  if (isProduction()) {
    cookie += '; domain=.padeltrainer.ai; Secure';
  }
  document.cookie = cookie;
}

function removeCookie(name: string): void {
  if (typeof document === 'undefined') return;
  // Expire with and without domain to cover both cases
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`;
  if (isProduction()) {
    document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax; domain=.padeltrainer.ai; Secure`;
  }
}

export const cookieStorage = {
  getItem(key: string): string | null {
    return getCookie(key);
  },
  setItem(key: string, value: string): void {
    setCookie(key, value, 365);
  },
  removeItem(key: string): void {
    removeCookie(key);
  },
};
