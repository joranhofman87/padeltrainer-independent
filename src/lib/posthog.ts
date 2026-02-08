import posthog from 'posthog-js';

const POSTHOG_KEY = 'phc_FUKQFOf822gn4Dyyf5QWHxIIma61r7bQPWnOPD7ex3';
const POSTHOG_HOST = 'https://eu.i.posthog.com';

let isInitialized = false;

export function initializePostHog() {
  if (isInitialized) return;

  const isProduction = !window.location.hostname.includes('lovable.app')
    && !window.location.hostname.includes('localhost');
  if (!isProduction) return;

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    persistence: 'memory',
    disable_cookie: true,
    disable_persistence: true,
    capture_pageview: false, // We handle SPA page views manually
    capture_pageleave: true,
    autocapture: true,
  });

  isInitialized = true;
}

export function trackPostHogPageView(path: string) {
  if (!isInitialized) return;
  posthog.capture('$pageview', {
    $current_url: window.location.origin + path,
  });
}

export { posthog };
