import { useEffect, Suspense } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { TrainerSidebar } from '@/components/trainer/TrainerSidebar';
import { ReferralWidget } from '@/components/ReferralWidget';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { useIsAcademyTrainer } from '@/hooks/useIsAcademyTrainer';
import { supabase } from '@/lib/supabaseClient';
import { useQuery } from '@tanstack/react-query';
import { PageContentSkeleton } from '@/components/AppShellSkeleton';
import { QueryErrorState } from '@/components/ui/QueryErrorState';

function TrainerMobileHeader() {
  const { t } = useTranslation('trainer');
  const { profile } = useAuth();
  const { toggleSidebar } = useSidebar();

  const displayName = profile?.full_name?.split(' ')[0] || t('badge', 'Trainer');

  return (
    <header
      className="sticky top-0 z-40 flex h-14 min-w-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80 lg:hidden"
      data-testid="trainer-mobile-header"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={toggleSidebar}
        aria-label={t('nav.openMenu', 'Open menu')}
        data-testid="trainer-mobile-menu-trigger"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{displayName}</span>
    </header>
  );
}

export default function TrainerLayout() {
  // Hook call kept for its side effects (i18n namespace subscription); `t` itself is unused here
  useTranslation('trainer');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, roles, loading, profileReady, profileFetchFailed, refreshAuth, subscription, refreshSubscription } = useAuth();
  const authResolving = loading || (!!user && !profileReady);

  // Academy affiliation — single shared signal (see useIsAcademyTrainer). Academy
  // trainers skip onboarding and have every financial/business surface hidden,
  // because the academy manages those things for them.
  const { isAcademyTrainer: hasAcademy, isResolved: academyResolved } = useIsAcademyTrainer();

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

  // Onboarding before subscription/paywall.
  // Academy-affiliated trainers SKIP onboarding entirely — the academy arranges
  // their setup, so we never guide them through the solo-trainer flow. Wait until
  // affiliation is known (academyResolved) so a first-login academy trainer is not
  // momentarily bounced into onboarding before the signal resolves.
  useEffect(() => {
    if (authResolving || onboardingGateLoading || !user || !isTrainerUser) return;
    if (!academyResolved) return;
    if (hasAcademy) return;
    if (!trainerOnboardingComplete && !isOnTrainerOnboarding) {
      navigate('/app/onboarding/trainer', { replace: true });
    }
  }, [
    authResolving,
    onboardingGateLoading,
    user,
    isTrainerUser,
    academyResolved,
    hasAcademy,
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

  // Redirect academy trainers away from restricted (financial / business) pages.
  // The `.startsWith` check also covers nested routes (e.g. /invoices/new,
  // /invoices/:id/edit, /settings/bookings). Slot detail is intentionally NOT here —
  // academy trainers need it for attendance/notes/roster; its pricing/payment blocks
  // are hidden in-page via useIsAcademyTrainer instead.
  const RESTRICTED_PATHS_FOR_ACADEMY = [
    '/app/trainer/settings',
    '/app/trainer/subscription',
    '/app/trainer/earnings',
    '/app/trainer/invoices',
    '/app/trainer/analytics',
    '/app/trainer/cycles',
    '/app/trainer/cyclus',
    '/app/trainer/intake-requests',
    '/app/trainer/waiting-list',
    '/app/trainer/schedule-overview',
    '/app/trainer/open-slots',
    '/app/trainer/get-started',
  ];

  useEffect(() => {
    if (!authResolving && academyResolved && hasAcademy) {
      const isRestricted = RESTRICTED_PATHS_FOR_ACADEMY.some(p => location.pathname.startsWith(p));
      // Also redirect dashboard index (financial tiles) for academy trainers.
      const isDashboardIndex = location.pathname === '/app/trainer' || location.pathname === '/app/trainer/';
      if (isRestricted || isDashboardIndex) {
        // Land on the Agenda ("what's coming up") — their relevant, no-financials home.
        navigate('/app/trainer/agenda', { replace: true });
      }
    }
  }, [authResolving, academyResolved, hasAcademy, location.pathname, navigate]);

  // Block render until affiliation is known too, so academy trainers never flash a
  // financial page (or the onboarding bounce) before the signal resolves on first load.
  const showLayoutLoading = authResolving || (isTrainerUser && (onboardingGateLoading || !academyResolved));

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
        <SidebarInset className="flex-1">
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
