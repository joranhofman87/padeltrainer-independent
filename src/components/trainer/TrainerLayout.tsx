import { useEffect, useCallback, Suspense } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TrainerSidebar } from '@/components/trainer/TrainerSidebar';
import { ReferralWidget } from '@/components/ReferralWidget';
import { getTrialDaysRemaining, SUBSCRIPTION_TIERS, STARTER_TIER } from '@/lib/subscription';
import { getTrainerAcademy } from '@/lib/academy';
import { supabase } from '@/lib/supabaseClient';
import { useQuery } from '@tanstack/react-query';
import { PageContentSkeleton } from '@/components/AppShellSkeleton';

export default function TrainerLayout() {
  const { t } = useTranslation('trainer');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, role, roles, loading, profileReady, subscription, refreshSubscription } = useAuth();
  const authResolving = loading || (!!user && !profileReady);

  // Check academy membership with caching
  const { data: hasAcademy = false } = useQuery({
    queryKey: ['trainer-has-academy', user?.id],
    queryFn: async () => {
      if (!user) return false;
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!trainerProfile) return false;
      const academy = await getTrainerAcademy(trainerProfile.id);
      return !!academy;
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });

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
        navigate('/app/auth');
      } else if (!roles.includes('trainer') && !roles.includes('admin')) {
        navigate('/app/player');
      }
    }
  }, [user, roles, authResolving, navigate]);

  // Calculate subscription status
  const subscriptionLoaded = subscription !== null;
  const hasActiveSubscription = subscription?.isSubscribed || subscription?.isInTrial || false;
  const isTrialing = subscription?.isInTrial || false;
  const trialDaysRemaining = subscription?.trialEndsAt 
    ? getTrialDaysRemaining(subscription.trialEndsAt) 
    : 0;
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

  // Redirect academy trainers away from restricted pages
  const RESTRICTED_PATHS_FOR_ACADEMY = [
    '/app/trainer/settings',
    '/app/trainer/subscription',
    '/app/trainer/earnings',
    '/app/trainer/cycles',
    '/app/trainer/intake-requests',
    '/app/trainer/waiting-list',
    '/app/trainer/schedule-overview',
    '/app/trainer/open-slots',
    '/app/trainer/get-started',
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

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <TrainerSidebar isExpired={!!(isSubscriptionExpired && !hasAcademy)} />
        <main className="flex-1 overflow-auto">
          {/* Mobile header */}
          <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/80 backdrop-blur-sm px-4 lg:hidden">
            <SidebarTrigger />
            <span className="font-semibold">PadelTrainer<span className="text-primary">.ai</span></span>
          </header>
          <div className="p-4 md:p-6">
            <Suspense fallback={<PageContentSkeleton />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      
      
      <ReferralWidget />
    </SidebarProvider>
  );
}
