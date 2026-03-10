import { useEffect } from 'react';
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

export default function TrainerLayout() {
  const { t } = useTranslation('trainer');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, role, roles, loading, subscription } = useAuth();

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
    staleTime: 5 * 60 * 1000,  // cache for 5 minutes
    gcTime: 10 * 60 * 1000,
  });

  // Auth guard - use roles array to support dual-role trainers
  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/app/auth');
      } else if (roles.length === 0) {
        navigate('/app/auth');
      } else if (!roles.includes('trainer') && !roles.includes('admin')) {
        navigate('/app/player');
      }
    }
  }, [user, roles, loading, navigate]);

  if (loading) {
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

  // Calculate subscription status
  const subscriptionLoaded = subscription !== null;
  const hasActiveSubscription = subscription?.isSubscribed || subscription?.isInTrial || false;
  const isTrialing = subscription?.isInTrial || false;
  const trialDaysRemaining = subscription?.trialEndsAt 
    ? getTrialDaysRemaining(subscription.trialEndsAt) 
    : 0;
  const isSubscriptionExpired = subscriptionLoaded && !subscription?.isSubscribed && !subscription?.isInTrial;
  const isOnSubscriptionPage = location.pathname.endsWith('/subscription');

  // Redirect to subscription page when expired
  useEffect(() => {
    if (!loading && isSubscriptionExpired && !isOnSubscriptionPage && !hasAcademy) {
      navigate('/app/trainer/subscription', { replace: true });
    }
  }, [loading, isSubscriptionExpired, isOnSubscriptionPage, hasAcademy, navigate]);

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
        <TrainerSidebar isExpired={!!(isSubscriptionExpired && !hasAcademy)} />
        <main className="flex-1 overflow-auto">
          {/* Mobile header */}
          <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/80 backdrop-blur-sm px-4 lg:hidden">
            <SidebarTrigger />
            <span className="font-semibold">PadelTrainer<span className="text-primary">.ai</span></span>
          </header>
          <div className="p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>
      
      
      <ReferralWidget />
    </SidebarProvider>
  );
}
