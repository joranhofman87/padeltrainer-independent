import { ReactNode, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { AppShellSkeleton } from '@/components/AppShellSkeleton';
import { logAppShellTransition, needsAuthProfileBootstrap } from '@/lib/appBootstrap';

/**
 * Prevents protected app routes from rendering before auth + profile/roles are ready.
 * Avoids transient wrong-sidebar flashes and premature auth-guard redirects.
 */
export function AppBootstrapGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { loading, profileReady, user } = useAuth();
  const lastPathRef = useRef(location.pathname);

  const shouldGate = needsAuthProfileBootstrap(location.pathname);
  const authResolving = loading || (shouldGate && !!user && !profileReady);

  useEffect(() => {
    if (lastPathRef.current !== location.pathname) {
      logAppShellTransition('route-change', {
        from: lastPathRef.current,
        to: location.pathname,
        shouldGate,
        authResolving,
        profileReady,
        hasUser: !!user,
      });
      lastPathRef.current = location.pathname;
    }
  }, [location.pathname, shouldGate, authResolving, profileReady, user]);

  useEffect(() => {
    if (authResolving && shouldGate) {
      logAppShellTransition('auth-resolving', {
        path: location.pathname,
        loading,
        profileReady,
        hasUser: !!user,
      });
    }
  }, [authResolving, shouldGate, location.pathname, loading, profileReady, user]);

  if (authResolving && shouldGate) {
    return <AppShellSkeleton />;
  }

  return <>{children}</>;
}
