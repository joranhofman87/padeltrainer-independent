import { useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { TrainerSidebar } from '@/components/trainer/TrainerSidebar';
import { SubscriptionOverlay } from '@/components/shared/SubscriptionOverlay';
import { getTrialDaysRemaining, SUBSCRIPTION_TIERS, STARTER_TIER } from '@/lib/subscription';

export default function TrainerLayout() {
  const { t } = useTranslation('trainer');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, role, loading, subscription } = useAuth();

  // Auth guard
  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/app/auth');
      } else if (!role) {
        navigate('/app/auth');
      } else if (role !== 'trainer') {
        navigate('/app/player');
      }
    }
  }, [user, role, loading, navigate]);

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
  const hasActiveSubscription = subscription?.isSubscribed || subscription?.isInTrial || false;
  const isTrialing = subscription?.isInTrial || false;
  const trialDaysRemaining = subscription?.trialEndsAt 
    ? getTrialDaysRemaining(subscription.trialEndsAt) 
    : 0;
  const isSubscriptionExpired = !subscription?.isSubscribed && !subscription?.isInTrial;
  const isOnSubscriptionPage = location.pathname === '/subscription' || location.pathname === '/trainer/subscription';

  // Feature translations for subscription overlay
  const subscriptionFeatures = [
    t('subscriptionOverlay.features.unlimitedLessons', 'Unlimited lessons'),
    t('subscriptionOverlay.features.calendarSync', 'Google Calendar sync'),
    t('subscriptionOverlay.features.analytics', 'Analytics dashboard'),
    t('subscriptionOverlay.features.prioritySupport', 'Priority support'),
  ];

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
        <TrainerSidebar />
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
      
      {/* Subscription Paywall Overlay */}
      {!loading && role === 'trainer' && isSubscriptionExpired && !isOnSubscriptionPage && (
        <SubscriptionOverlay
          roleName="trainer"
          subscriptionPath="/trainer/subscription"
          pricing={{
            monthly: SUBSCRIPTION_TIERS.professional.monthlyPrice,
            yearly: SUBSCRIPTION_TIERS.professional.yearlyPrice,
          }}
          features={subscriptionFeatures}
          trialDaysRemaining={trialDaysRemaining}
          isTrialExpired={isSubscriptionExpired}
        />
      )}
    </SidebarProvider>
  );
}
