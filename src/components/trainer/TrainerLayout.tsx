import { useEffect, Suspense } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { AppMobileHeader } from '@/components/ui/app-mobile-header';
import { TrainerSidebar } from '@/components/trainer/TrainerSidebar';
import { ReferralWidget } from '@/components/ReferralWidget';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { useTrainerHasAcademy } from '@/hooks/useTrainerHasAcademy';
import { supabase } from '@/lib/supabaseClient';
import { useQuery } from '@tanstack/react-query';
import { PageContentSkeleton } from '@/components/AppShellSkeleton';
import { QueryErrorState } from '@/components/ui/QueryErrorState';

function TrainerMobileHeader() {
  const { t } = useTranslation('trainer');
  const { profile } = useAuth();

  const displayName = profile?.full_name?.split(' ')[0] || t('badge', 'Trainer');

  return (
    // md:hidden (was lg:hidden): the shared sidebar swaps its mobile Sheet for the
    // desktop rail at md (768px), so the old lg breakpoint left a redundant
    // hamburger header next to the visible sidebar between 768–1023px.
    <AppMobileHeader
      breakpointClass="md:hidden"
      data-testid="trainer-mobile-header"
      menuTriggerTestId="trainer-mobile-menu-trigger"
      menuLabel={t('nav.openMenu', 'Open menu')}
    >
      {displayName}
    </AppMobileHeader>
  );
}

export default function TrainerLayout() {
  // Hook call kept for its side effects (i18n namespace subscription); `t` itself is unused here
  useTranslation('trainer');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, roles, loading, profileReady, profileFetchFailed, refreshAuth, subscription, refreshSubscription } = useAuth();
  const authResolving = loading || (!!user && !profileReady);

  // Check academy membership with caching (shared hook/cache with TrainerSessions)
  const { data: hasAcademy = false } = useTrainerHasAcademy();

  // Trigger subscription fetch when entering trainer layout (if not yet loaded)
  useEffect(() => {
    if (!authResolving && user && roles.includes('trainer') && subscription === null) {
      refreshSubscription();
    }
  }, [authResolving, user, roles, subscription, refreshSubscription]);

  // Auth guard
  useEffect(() => {
    if (!authResolving) {
      if (!user) {
        navigate('/app/auth');
      } else if (roles.length === 0) {
        // U-12: empty roles after a failed fetch means "couldn't load", not "no account" —
        // show the retry state below instead of bouncing a logged-in user to the login form
        if (!profileFetchFailed) navigate('/app/auth');
      } else if (!roles.includes('trainer') && !roles.includes('admin')) {
        navigate('/app/player');
      }
    }
  }, [user, roles, authResolving, profileFetchFailed, navigate]);

  // Calculate subscription status
  const subscriptionLoaded = subscription !== null;
  const isSubscriptionExpired = subscriptionLoaded && !subscription?.isSubscribed && !subscription?.isInTrial;
  const isOnSubscriptionPage = location.pathname.endsWith('/subscription');
  const isOnTrainerOnboarding = location.pathname === '/app/onboarding/trainer';

  const isTrainerUser = roles.includes('trainer') || roles.includes('admin');

  const { data: trainerOnboardingComplete = false, isLoading: onboardingGateLoading } = useQuery({
    queryKey: ['trainer-onboarding-gate', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('trainer_onboarding')
        .select('completed_at')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return !!data?.completed_at;
    },
    enabled: !!user && isTrainerUser,
    staleTime: 60 * 1000,
  });

  // Onboarding before subscription/paywall
  useEffect(() => {
    if (authResolving || onboardingGateLoading || !user || !isTrainerUser) return;
    if (!trainerOnboardingComplete && !isOnTrainerOnboarding) {
      navigate('/app/onboarding/trainer', { replace: true });
    }
  }, [
    authResolving,
    onboardingGateLoading,
    user,
    isTrainerUser,
    trainerOnboardingComplete,
    isOnTrainerOnboarding,
    navigate,
  ]);

  // Redirect to subscription page when expired (only after onboarding complete)
  useEffect(() => {
    if (
      authResolving ||
      onboardingGateLoading ||
      !trainerOnboardingComplete ||
      !isSubscriptionExpired ||
      isOnSubscriptionPage ||
      hasAcademy
    ) {
      return;
    }
    navigate('/app/trainer/subscription', { replace: true });
  }, [
    authResolving,
    onboardingGateLoading,
    trainerOnboardingComplete,
    isSubscriptionExpired,
    isOnSubscriptionPage,
    hasAcademy,
    navigate,
  ]);

  // Redirect academy trainers away from restricted pages.
  // NOTE: settings ROOT + settings/notifications are deliberately reachable —
  // language/timezone/player-mode and email-notification prefs are per-user, and
  // the new-booking emails footer-link straight to settings/notifications. Only
  // the trainer BOOKING settings stay academy-managed.
  //
  // Academy trainers are VIEW-ONLY: the session CREATE surfaces (slot/new,
  // slot/generate) and the Sessions hub (which is entirely create actions) are
  // blocked too. `/app/trainer/slot/:id` (slot DETAIL) stays reachable — they
  // view rosters, mark attendance and write coaching notes there; slot ids are
  // UUIDs so they never collide with the /slot/new or /slot/generate prefixes.
  const RESTRICTED_PATHS_FOR_ACADEMY = [
    '/app/trainer/settings/bookings',
    '/app/trainer/subscription',
    '/app/trainer/earnings',
    '/app/trainer/cycles',
    '/app/trainer/intake-requests',
    '/app/trainer/waiting-list',
    '/app/trainer/schedule-overview',
    '/app/trainer/open-slots',
    '/app/trainer/get-started',
    '/app/trainer/slot/new',
    '/app/trainer/slot/generate',
    '/app/trainer/sessions',
    '/app/trainer/invoices',
  ];

  useEffect(() => {
    if (!authResolving && hasAcademy) {
      const isRestricted = RESTRICTED_PATHS_FOR_ACADEMY.some(p => location.pathname.startsWith(p));
      // Also redirect dashboard index for academy trainers
      const isDashboardIndex = location.pathname === '/app/trainer' || location.pathname === '/app/trainer/';
      if (isRestricted || isDashboardIndex) {
        navigate('/app/trainer/calendar', { replace: true });
      }
    }
  }, [authResolving, hasAcademy, location.pathname, navigate]);

  const showLayoutLoading = authResolving || (isTrainerUser && onboardingGateLoading);

  if (showLayoutLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="flex">
          <div className="w-60 border-r bg-card p-4">
            <div className="flex items-center gap-2 mb-6">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          </div>
          <div className="flex-1 p-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
              <Skeleton className="h-32" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (user && roles.length === 0 && profileFetchFailed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <QueryErrorState className="w-full max-w-md" onRetry={() => { void refreshAuth(); }} />
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <TrainerSidebar isExpired={!!(isSubscriptionExpired && !hasAcademy)} />
        <SidebarInset className="flex-1 min-w-0">
          <TrainerMobileHeader />
          <main className="flex-1 overflow-auto p-4 md:p-6">
            <Suspense fallback={<PageContentSkeleton />}>
              <RouteErrorBoundary>
                <Outlet />
              </RouteErrorBoundary>
            </Suspense>
          </main>
        </SidebarInset>
      </div>
      <ReferralWidget />
    </SidebarProvider>
  );
}
