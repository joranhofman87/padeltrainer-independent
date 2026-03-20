import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { TranslationsProvider } from "./contexts/TranslationsContext";
import App from "./App.tsx";
import "./index.css";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { logger } from "./lib/logger";

// Global error handlers — catch unhandled errors and promise rejections
window.addEventListener('error', (event) => {
  // Ignore cross-origin script errors (no useful info) and third-party scripts
  if (!event.filename || event.message === 'Script error.' || !event.filename.includes(window.location.hostname)) {
    return;
  }
  logger.error('Unhandled error', event.error instanceof Error ? event.error : new Error(event.message || 'Unknown error'), {
    component: 'global',
    action: 'uncaught_error',
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason || 'Unhandled promise rejection'));
  logger.error('Unhandled promise rejection', error, {
    component: 'global',
    action: 'unhandled_rejection',
  });
});

// Initialize PostHog and Reditus after critical rendering
async function initDeferred() {
  const { initializePostHog } = await import('./lib/posthog');
  initializePostHog();
  // Reditus affiliate tracking — deferred to avoid render-blocking
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://script.getreditus.com/v2.js';
  s.onerror = () => { /* silently ignore third-party load failures */ };
  s.onload = () => {
    try {
      (window as any).gr?.('initCustomer', '48a566a2-eb01-4562-932d-ef6886e0282e');
      (window as any).gr?.('track', 'pageview');
    } catch { /* silently ignore third-party errors */ }
  };
  document.head.appendChild(s);
}

if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
  (window as any).requestIdleCallback(initDeferred);
} else {
  setTimeout(initDeferred, 1000);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <TranslationsProvider>
          <App />
        </TranslationsProvider>
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>
);