/**
 * Lazy PostHog wrapper — the ONLY module allowed to touch posthog-js.
 * The library (~50KB gzip) is dynamically imported on first use, and only
 * on production hostnames, so it never lands in the entry chunk and
 * dev/preview environments never load it at all.
 */
import type { PostHog } from 'posthog-js';

const POSTHOG_KEY = 'phc_FUKQFOf822gn4Dyyf5QWHxIIma61r7bQPWnOPD7ex3';
const POSTHOG_HOST = 'https://eu.i.posthog.com';

let client: PostHog | null = null;
let loadPromise: Promise<PostHog | null> | null = null;

function isProductionHost(): boolean {
  return window.location.hostname === 'padeltrainer.ai'
    || window.location.hostname.endsWith('.padeltrainer.ai');
}

export function initializePostHog(): Promise<PostHog | null> {
  if (!loadPromise) {
    loadPromise = !isProductionHost()
      ? Promise.resolve(null)
      : import('posthog-js')
          .then(({ default: posthog }) => {
            posthog.init(POSTHOG_KEY, {
              api_host: POSTHOG_HOST,
              persistence: 'memory',
              disable_cookie: true,
              disable_persistence: true,
              capture_pageview: false, // We handle SPA page views manually
              capture_pageleave: true,
              autocapture: true,
            });
            client = posthog;
            return posthog;
          })
          .catch(() => null); // Analytics must never break app functionality
  }
  return loadPromise;
}

/**
 * Run `fn` with the PostHog client once it's loaded.
 * Silently no-ops off production (the import never happens there).
 */
export function withPostHog(fn: (ph: PostHog) => void): void {
  if (client) {
    try {
      fn(client);
    } catch {
      // Analytics must never break app functionality
    }
    return;
  }
  void initializePostHog().then((ph) => {
    if (!ph) return;
    try {
      fn(ph);
    } catch {
      // Analytics must never break app functionality
    }
  });
}

export function trackPostHogPageView(path: string) {
  withPostHog((ph) => {
    ph.capture('$pageview', {
      $current_url: window.location.origin + path,
    });
  });
}
