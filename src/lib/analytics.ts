import { CookieConsent } from '@/contexts/CookieConsentContext';

const GA_MEASUREMENT_ID = 'G-7LV1ZK9PH5';

let isGAInitialized = false;
let isTradeTrackerInitialized = false;

function getStoredConsent(): CookieConsent | null {
  try {
    const stored = localStorage.getItem('cookie-consent');
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Invalid stored value
  }
  return null;
}

function loadGoogleAnalytics() {
  if (isGAInitialized) return;
  
  // Create and append the GA script
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);

  // Initialize gtag
  window.dataLayer = window.dataLayer || [];
  function gtag(...args: unknown[]) {
    window.dataLayer.push(args);
  }
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);

  // Make gtag available globally
  window.gtag = gtag;
  
  isGAInitialized = true;
}

function loadTradeTracker() {
  // Only load on marketing pages (not /app/* routes)
  if (window.location.pathname.startsWith('/app')) return;
  if (isTradeTrackerInitialized) return;

  // Set up TradeTracker options globally
  (window as unknown as { _TradeTrackerTagOptions: object })._TradeTrackerTagOptions = {
    t: 'a',
    s: '505059',
    chk: 'a6008bc2b069f12d2b9ed64acbcba05b',
    overrideOptions: {}
  };

  // Create and append the TradeTracker script
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = `https://tm.tradetracker.net/tag?t=a&s=505059&chk=a6008bc2b069f12d2b9ed64acbcba05b`;
  document.body.appendChild(script);

  isTradeTrackerInitialized = true;
}

export function initializeAnalytics() {
  const consent = getStoredConsent();
  
  if (consent?.analytics) {
    loadGoogleAnalytics();
    loadTradeTracker();
  }
  
  // Listen for consent updates
  window.addEventListener('cookie-consent-updated', ((event: CustomEvent<CookieConsent>) => {
    if (event.detail.analytics) {
      if (!isGAInitialized) {
        loadGoogleAnalytics();
      }
      if (!isTradeTrackerInitialized) {
        loadTradeTracker();
      }
    }
    // Note: We don't unload trackers if consent is withdrawn - that requires a page reload
  }) as EventListener);
}

// Type declarations for global window object
declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}
