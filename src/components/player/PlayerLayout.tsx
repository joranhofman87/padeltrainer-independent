import { useEffect, Suspense } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import {
  SidebarProvider,
  SidebarInset,
} from '@/components/ui/sidebar';
import { AppMobileHeader } from '@/components/ui/app-mobile-header';
import { PlayerSidebar } from '@/components/player/PlayerSidebar';
import { ReferralWidget } from '@/components/ReferralWidget';
import { PageContentSkeleton } from '@/components/AppShellSkeleton';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { QueryErrorState } from '@/components/ui/QueryErrorState';

function PlayerMobileHeader() {
  const { t } = useTranslation('player');
  const { profile } = useAuth();

  const displayName = profile?.full_name?.split(' ')[0] || t('nav.dashboard', 'Dashboard');

  return (
    // md:hidden (was lg:hidden): the shared sidebar swaps its mobile Sheet for the
    // desktop rail at md (768px), so the old lg breakpoint left a redundant
    // hamburger header next to the visible sidebar between 768–1023px.
    <AppMobileHeader
      breakpointClass="md:hidden"
      data-testid="player-mobile-header"
      menuTriggerTestId="player-mobile-menu-trigger"
      menuLabel={t('nav.openMenu', 'Open menu')}
    >
      {displayName}
    </AppMobileHeader>
  );
}

export default function PlayerLayout() {
  const navigate = useNavigate();
  const { user, roles, loading, profileReady, profileFetchFailed, refreshAuth } = useAuth();
  const authResolving = loading || (!!user && !profileReady);

  // Auth guard - allow player, trainer (with player role), and admin
  useEffect(() => {
    if (!authResolving) {
      if (!user) {
        navigate('/app/auth');
      } else if (roles.length === 0) {
        // U-12: empty roles after a failed fetch means "couldn't load", not "no account" —
        // show the retry state below instead of bouncing a logged-in user to the login form
        if (!profileFetchFailed) navigate('/app/auth');
      } else if (!roles.includes('player') && !roles.includes('trainer') && !roles.includes('admin')) {
        navigate('/app/auth');
      }
    }
  }, [user, roles, authResolving, profileFetchFailed, navigate]);

  if (authResolving) {
    return (
      <div className="min-h-screen bg-slate-50/80">
        <div className="flex">
          <div className="w-60 border-r border-slate-200 bg-slate-50 p-4">
            <div className="mb-6 flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
          <div className="flex-1 p-4 md:p-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (user && roles.length === 0 && profileFetchFailed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50/80 p-4">
        <QueryErrorState className="w-full max-w-md" onRetry={() => { void refreshAuth(); }} />
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <PlayerSidebar />
        <SidebarInset className="flex min-w-0 flex-1 flex-col bg-slate-50/50">
          <PlayerMobileHeader />
          <div className="flex-1 p-4 md:p-6">
            <Suspense fallback={<PageContentSkeleton />}>
              <RouteErrorBoundary>
                <Outlet />
              </RouteErrorBoundary>
            </Suspense>
          </div>
        </SidebarInset>
      </div>
      <ReferralWidget />
    </SidebarProvider>
  );
}
