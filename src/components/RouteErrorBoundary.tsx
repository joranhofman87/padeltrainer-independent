import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { logger } from '@/lib/logger';
import { isChunkLoadError, tryChunkReload } from '@/components/ErrorBoundary';

function RouteErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('common');

  return (
    <div
      role="alert"
      className="flex min-h-[50vh] flex-col items-center justify-center p-6 text-center"
      data-testid="route-error-fallback"
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="h-6 w-6 text-destructive" />
      </div>
      <h2 className="text-lg font-semibold text-foreground">
        {t('errorBoundary.title', 'Something went wrong')}
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {t('errorBoundary.description', 'This page ran into a problem. Your data is safe — try again or pick another page from the menu.')}
      </p>
      <Button variant="outline" className="mt-4" onClick={onRetry}>
        <RefreshCw className="mr-2 h-4 w-4" />
        {t('errorBoundary.retry', 'Try again')}
      </Button>
    </div>
  );
}

interface InnerProps {
  children: ReactNode;
  onRetry: () => void;
}

interface InnerState {
  hasError: boolean;
}

class RouteBoundaryInner extends Component<InnerProps, InnerState> {
  state: InnerState = { hasError: false };

  static getDerivedStateFromError(): InnerState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Stale lazy chunk after a deploy — attempt the throttled auto-reload first.
    if (isChunkLoadError(error?.message || '') && tryChunkReload()) return;

    logger.error('Route render error', error, {
      component: 'RouteErrorBoundary',
      componentStack: errorInfo.componentStack || undefined,
    });
  }

  render() {
    if (this.state.hasError) {
      return <RouteErrorFallback onRetry={this.props.onRetry} />;
    }
    return this.props.children;
  }
}

/**
 * Route-level error boundary for inside the logged-in shell: a page crash only
 * takes down the content pane (sidebar/navigation survive). Navigating to
 * another route clears the error automatically; "Try again" remounts just the
 * crashed route.
 */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [attempt, setAttempt] = useState(0);

  return (
    <RouteBoundaryInner
      // New key on navigation or retry → fresh boundary + remounted route.
      key={`${location.pathname}#${attempt}`}
      onRetry={() => setAttempt((a) => a + 1)}
    >
      {children}
    </RouteBoundaryInner>
  );
}

export default RouteErrorBoundary;
