import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App.tsx";
import "./index.css";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initializeAnalytics } from "./lib/analytics";
import { initializePostHog } from "./lib/posthog";

// Initialize analytics based on cookie consent
initializeAnalytics();

// Initialize PostHog (cookieless, no consent needed)
initializePostHog();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <App />
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>
);