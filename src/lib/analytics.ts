import { CookieConsent } from '@/contexts/CookieConsentContext';

const GA_MEASUREMENT_ID = 'G-7LV1ZK9PH5';

let isInitialized = false;

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
  if (isInitialized) return;
  
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
  
  isInitialized = true;
}

export function initializeAnalytics() {
  const consent = getStoredConsent();
  
  if (consent?.analytics) {
    loadGoogleAnalytics();
  }
  
  // Listen for consent updates
  window.addEventListener('cookie-consent-updated', ((event: CustomEvent<CookieConsent>) => {
    if (event.detail.analytics && !isInitialized) {
      loadGoogleAnalytics();
    }
    // Note: We don't unload GA if consent is withdrawn - that requires a page reload
    // This is standard practice as GA has already collected the pageview
  }) as EventListener);
}

// Type declarations for global window object
declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}
