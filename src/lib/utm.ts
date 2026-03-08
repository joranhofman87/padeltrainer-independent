import { posthog } from '@/lib/posthog';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
const STORAGE_KEY = 'pt_utm';

/** Parse UTM params from current URL and persist in sessionStorage + PostHog super properties. */
export function captureUtmParams() {
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};

  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) utm[key] = value;
  }

  // Only overwrite if we found new UTM params
  if (Object.keys(utm).length > 0) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(utm));
    } catch {
      // sessionStorage may be unavailable in incognito/restricted browsers
    }
    posthog.register(utm);
  } else {
    // Restore previously captured params for PostHog super properties
    const stored = getUtmParams();
    if (Object.keys(stored).length > 0) {
      posthog.register(stored);
    }
  }
}

/** Retrieve stored UTM params (safe for spreading into trackEvent properties). */
export function getUtmParams(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
