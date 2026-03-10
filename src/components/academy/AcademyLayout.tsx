import { useState, useEffect, createContext, useContext } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GraduationCap, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { getUserAcademyProfiles, type AcademyProfile } from '@/lib/academy';
import { AcademySidebar } from '@/components/academy/AcademySidebar';
import { SidebarProvider, SidebarTrigger, SidebarInset } from '@/components/ui/sidebar';
import { useToast } from '@/hooks/use-toast';
import { ReferralWidget } from '@/components/ReferralWidget';
import { 
  checkAcademySubscription, 
  getTrialDaysRemaining, 
  ACADEMY_SUBSCRIPTION,
  type AcademySubscriptionInfo 
} from '@/lib/academySubscription';

interface AcademyWithRole extends AcademyProfile {
  role: string;
}

interface AcademyContextValue {
  activeAcademy: AcademyWithRole | null;
  academies: AcademyWithRole[];
  setActiveAcademy: (academy: AcademyWithRole) => void;
  refreshAcademies: () => Promise<void>;
  subscription: AcademySubscriptionInfo | null;
  hasActiveSubscription: boolean;
  isTrialing: boolean;
  trialDaysRemaining: number;
  refreshSubscription: () => Promise<void>;
}

const AcademyContext = createContext<AcademyContextValue | undefined>(undefined);

export function useAcademyContext() {
  const context = useContext(AcademyContext);
  if (!context) {
    throw new Error('useAcademyContext must be used within AcademyLayout');
  }
  return context;
}

const ACTIVE_ACADEMY_STORAGE_KEY = 'activeAcademyId';

export default function AcademyLayout() {
  const { t } = useTranslation('academy');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [academies, setAcademies] = useState<AcademyWithRole[]>([]);
  const [activeAcademy, setActiveAcademy] = useState<AcademyWithRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState<AcademySubscriptionInfo | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/app/auth');
    }
  }, [user, authLoading, navigate]);

  const fetchAcademies = async () => {
    if (!user) return;

    try {
      const userAcademies = await getUserAcademyProfiles(user.id);
      setAcademies(userAcademies);
      
      // Try to restore previously selected academy from localStorage
      const savedAcademyId = localStorage.getItem(ACTIVE_ACADEMY_STORAGE_KEY);
      const savedAcademy = savedAcademyId ? userAcademies.find(a => a.id === savedAcademyId) : null;
      
      if (savedAcademy) {
        setActiveAcademy(savedAcademy);
      } else if (userAcademies.length > 0) {
        setActiveAcademy(userAcademies[0]);
        localStorage.setItem(ACTIVE_ACADEMY_STORAGE_KEY, userAcademies[0].id);
      }
    } catch (error) {
      console.error('Error fetching academies:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAcademies();
  }, [user]);

  // Fetch subscription status when active academy changes
  const fetchSubscription = async () => {
    if (!activeAcademy) {
      setSubscription(null);
      return;
    }
    
    setSubscriptionLoading(true);
    try {
      const sub = await checkAcademySubscription(activeAcademy.id);
      setSubscription(sub);
    } catch (error) {
      console.error('Error fetching subscription:', error);
      setSubscription(null);
    } finally {
      setSubscriptionLoading(false);
    }
  };

  useEffect(() => {
    fetchSubscription();
    
    // Refresh subscription every 60 seconds
    const interval = setInterval(fetchSubscription, 60000);
    return () => clearInterval(interval);
  }, [activeAcademy]);

  const handleAcademyChange = (academy: AcademyWithRole) => {
    setActiveAcademy(academy);
    localStorage.setItem(ACTIVE_ACADEMY_STORAGE_KEY, academy.id);
  };

  // Calculate subscription status
  const hasActiveSubscription = subscription?.isSubscribed || false;
  const isTrialing = subscription?.isTrial && !subscription?.trialExpired;
  const trialDaysRemaining = subscription?.trialEnd 
    ? getTrialDaysRemaining(subscription.trialEnd) 
    : 0;
  const isSubscriptionExpired = subscription?.trialExpired && !subscription?.isSubscribed;
  const isOnSubscriptionPage = location.pathname === '/app/academy/subscription';

  // Redirect to subscription page when expired
  useEffect(() => {
    if (!subscriptionLoading && isSubscriptionExpired && !isOnSubscriptionPage) {
      navigate('/app/academy/subscription', { replace: true });
    }
  }, [subscriptionLoading, isSubscriptionExpired, isOnSubscriptionPage, navigate]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="flex">
          <div className="w-64 border-r bg-sidebar p-4 space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-6 w-1/2" />
          </div>
          <div className="flex-1 p-8">
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

  if (academies.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-16 text-center">
          <GraduationCap className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t('dashboard.title')}</h1>
          <p className="text-muted-foreground mb-6">
            {t('dashboard.noAcademies', "You haven't created any academies yet.")}
          </p>
          <Button onClick={() => navigate('/app/onboarding/academy')}>
            {t('dashboard.createAcademy', 'Create an Academy')}
          </Button>
        </div>
      </div>
    );
  }

  // Feature translations for subscription overlay
  const subscriptionFeatures = [
    t('subscription.features.unlimitedTrainers', 'Unlimited trainers'),
    t('subscription.features.multipleLocations', 'Multiple locations'),
    t('subscription.features.analytics', 'Advanced analytics'),
    t('subscription.features.prioritySupport', 'Priority support'),
  ];

  return (
    <AcademyContext.Provider value={{ 
      activeAcademy, 
      academies, 
      setActiveAcademy: handleAcademyChange, 
      refreshAcademies: fetchAcademies,
      subscription,
      hasActiveSubscription,
      isTrialing: isTrialing || false,
      trialDaysRemaining,
      refreshSubscription: fetchSubscription,
    }}>
      <SidebarProvider>
        <div className="min-h-screen flex w-full bg-background">
          <AcademySidebar 
            academy={activeAcademy}
            onAcademyChange={handleAcademyChange}
          />
          <SidebarInset className="flex-1">
            {/* Mobile Header */}
            <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4 md:hidden">
              <SidebarTrigger>
                <Button variant="ghost" size="icon">
                  <Menu className="h-5 w-5" />
                  <span className="sr-only">Toggle sidebar</span>
                </Button>
              </SidebarTrigger>
              <span className="font-semibold truncate">{activeAcademy?.name}</span>
            </header>
            
            {/* Page Content */}
            <main className="flex-1">
              <Outlet />
            </main>
          </SidebarInset>
        </div>
        
        
        <ReferralWidget />

        {/* Subscription Paywall Overlay */}
        {!subscriptionLoading && isSubscriptionExpired && !isOnSubscriptionPage && (
          <SubscriptionOverlay
            roleName="academy"
            subscriptionPath="/app/academy/subscription"
            pricing={{
              monthly: ACADEMY_SUBSCRIPTION.monthlyPrice,
              yearly: ACADEMY_SUBSCRIPTION.yearlyPrice,
            }}
            features={subscriptionFeatures}
            trialDaysRemaining={trialDaysRemaining}
            isTrialExpired={isSubscriptionExpired}
          />
        )}
      </SidebarProvider>
    </AcademyContext.Provider>
  );
}
