import React, { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { logger } from "@/lib/logger";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

export function isChunkLoadError(message: string): boolean {
  return CHUNK_ERROR_RE.test(message || "");
}

const RELOAD_ATTEMPTS_KEY = "__chunkReloadAttempts";

// One failed chunk fires several handlers (vite:preloadError, unhandledrejection,
// the error boundaries). Without this flag each of them would record a separate
// attempt and a single failure could exhaust the whole throttle budget.
let reloadScheduled = false;

/**
 * Throttled reload to recover from stale chunks / 524 timeouts.
 * Up to 3 attempts within 5 minutes. Returns true if a reload is scheduled
 * (or already pending). Resets naturally on the reload itself.
 */
export function tryChunkReload(): boolean {
  if (typeof window === "undefined") return false;
  if (reloadScheduled) return true;
  try {
    const now = Date.now();
    const raw = sessionStorage.getItem(RELOAD_ATTEMPTS_KEY);
    const attempts: number[] = raw ? JSON.parse(raw) : [];
    const recent = attempts.filter((ts) => now - ts < 5 * 60_000);
    if (recent.length >= 3) return false;
    recent.push(now);
    sessionStorage.setItem(RELOAD_ATTEMPTS_KEY, JSON.stringify(recent));
    reloadScheduled = true;
    setTimeout(() => window.location.reload(), 500);
    return true;
  } catch {
    return false;
  }
}

// This boundary mounts OUTSIDE the i18n provider (it wraps TranslationsProvider
// in main.tsx), so translation hooks are unavailable — pick static copy from the
// persisted language instead. Never include component names or raw error text.
const FALLBACK_COPY = {
  en: {
    title: "Something went wrong",
    description: "An unexpected error occurred. Please try again or refresh the page.",
    retry: "Try again",
    refresh: "Refresh page",
    updating: "Loading the new version…",
  },
  nl: {
    title: "Er is iets misgegaan",
    description: "Er is een onverwachte fout opgetreden. Probeer het opnieuw of vernieuw de pagina.",
    retry: "Probeer opnieuw",
    refresh: "Pagina vernieuwen",
    updating: "Nieuwe versie laden…",
  },
} as const;

function getFallbackCopy() {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem("i18nextLng");
  } catch {
    // localStorage unavailable (privacy mode) — fall through to navigator
  }
  const lang = (stored || navigator.language || "en").split("-")[0];
  return lang === "nl" ? FALLBACK_COPY.nl : FALLBACK_COPY.en;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  /** A stale-chunk auto-reload is pending — render the quiet updating state,
   *  not the alarming error card (the reload lands within ~500ms). */
  reloadingChunk: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, reloadingChunk: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // No side effects here (render phase) — chunk-reload recovery happens once
    // in componentDidCatch, so a single error can't burn multiple attempts.
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Auto-recover from stale lazy chunks after a deploy / 524 timeouts. While the
    // reload is pending (~500ms) show the quiet "updating" state — flashing the red
    // error card here made every routine post-deploy navigation look like a crash.
    if (isChunkLoadError(error?.message || "") && typeof window !== "undefined") {
      if (tryChunkReload()) {
        this.setState({ reloadingChunk: true });
        return;
      }
    }

    // Log error to centralized logger
    logger.error("Uncaught application error", error, {
      component: "ErrorBoundary",
      componentStack: errorInfo.componentStack || undefined,
    });

    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null, reloadingChunk: false });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.state.reloadingChunk) {
        // New deploy invalidated this tab's lazy chunks; the auto-reload is already
        // scheduled. A quiet spinner — this is an update, not a failure.
        const copy = getFallbackCopy();
        return (
          <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3 p-4" data-testid="chunk-reload-fallback">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{copy.updating}</p>
          </div>
        );
      }
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const copy = getFallbackCopy();

      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4" data-testid="error-boundary-fallback">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="h-6 w-6 text-destructive" />
              </div>
              <CardTitle className="text-xl">{copy.title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                {copy.description}
              </p>

              {import.meta.env.DEV && this.state.error && (
                <div className="p-3 bg-muted rounded-md overflow-auto max-h-32">
                  <code className="text-xs text-destructive">
                    {this.state.error.message}
                  </code>
                </div>
              )}

              <div className="flex gap-2 justify-center">
                <Button variant="outline" onClick={this.handleReset}>
                  {copy.retry}
                </Button>
                <Button onClick={this.handleReload}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  {copy.refresh}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
