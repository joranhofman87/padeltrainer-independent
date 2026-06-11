import { useState, useEffect, createContext, useContext, Suspense } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GraduationCap, Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageContentSkeleton } from '@/components/AppShellSkeleton';
import { useAuth } from '@/hooks/useAuth';
import { getUserAcademyProfiles, type AcademyProfile } from '@/lib/academy';
import { logger } from '@/lib/logger';
import { AcademySidebar } from '@/components/academy/AcademySidebar';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { useToast } from '@/hooks/use-toast';
import { ReferralWidget } from '@/components/ReferralWidget';
import { useQuery } from '@tanstack/react-query';
import { 
  checkAcademySubscription, 
  getTrialDaysRemaining, 
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
const SUBSCRIPTION_STALE_TIME = 5 * 60 * 1000; // 5 minutes

function AcademyMobileHeader({ academyName }: { academyName?: string }) {
  const { t } = useTranslation('academy');
  const { toggleSidebar } = useSidebar();

  return (
    <header className="sticky top-0 z-40 flex h-14 min-w-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80 md:hidden">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={toggleSidebar}
        aria-label={t('nav.openMenu', 'Open menu')}
        data-testid="academy-mobile-menu-trigger"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{academyName}</span>
    </header>
  );
}

export default function AcademyLayout() {
  const { t } = useTranslation('academy');
  const navigate = useNavigate();
  const location = useLocation();
  const { user, loading: authLoading, profileReady } = useAuth();
  const authResolving = authLoading || (!!user && !profileReady);
  useToast(); // keep hook call: subscribes component to toast state
  const [academies, setAcademies] = useState<AcademyWithRole[]>([]);
  const [activeAcademy, setActiveAcademy] = useState<AcademyWithRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authResolving && !user) {
      navigate('/app/auth');
    }
  }, [user, authResolving, navigate]);

  const fetchAcademies = async () => {
    if (!user) return;

    try {
      const userAcademies = await getUserAcademyProfiles(user.id);
      setAcademies(userAcademies);
      
      const savedAcademyId = (() => {
        try {
          return localStorage.getItem(ACTIVE_ACADEMY_STORAGE_KEY);
        } catch {
          return null;
        }
      })();
      const savedAcademy = savedAcademyId ? userAcademies.find(a => a.id === savedAcademyId) : null;
      
      if (savedAcademy) {
        setActiveAcademy(savedAcademy);
      } else if (userAcademies.length > 0) {
        setActiveAcademy(userAcademies[0]);
        try {
          localStorage.setItem(ACTIVE_ACADEMY_STORAGE_KEY, userAcademies[0].id);
        } catch {
          /* ignore storage errors */
        }
      }
    } catch (error) {
      logger.error('Error fetching academies', error instanceof Error ? error : new Error(String(error)), { component: 'AcademyLayout' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAcademies();
  }, [user]);

  // Subscription check via TanStack Query — replaces useEffect + setInterval
  const { data: subscription = null, refetch: refetchSubscription } = useQuery({
    queryKey: ['academy-subscription', activeAcademy?.id],
    queryFn: () => checkAcademySubscription(activeAcademy!.id),
    enabled: !!activeAcademy,
    staleTime: SUBSCRIPTION_STALE_TIME,
    refetchInterval: SUBSCRIPTION_STALE_TIME,
  });

  const handleAcademyChange = (academy: AcademyWithRole) => {
    setActiveAcademy(academy);
    try {
      localStorage.setItem(ACTIVE_ACADEMY_STORAGE_KEY, academy.id);
    } catch {
      /* ignore storage errors */
    }
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
    if (subscription && isSubscriptionExpired && !isOnSubscriptionPage) {
      navigate('/app/academy/subscription', { replace: true });
    }
  }, [subscription, isSubscriptionExpired, isOnSubscriptionPage, navigate]);

  if (authResolving || loading || (academies.length > 0 && !activeAcademy)) {
    return (
      <div className="min-h-screen bg-background" data-testid="academy-layout-loading">
        <div className="flex min-h-screen w-full">
          <div className="hidden w-64 shrink-0 border-r border-slate-200 bg-slate-50 p-4 md:block">
            <Skeleton className="mb-6 h-8 w-full rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-3/4 rounded-lg" />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-14 items-center gap-3 border-b border-slate-200 px-4 md:hidden">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="flex-1 p-4 md:p-6">
              <PageContentSkeleton />
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
      refreshSubscription: async () => { await refetchSubscription(); },
    }}>
      <SidebarProvider>
        <div className="min-h-screen flex w-full bg-background">
          <AcademySidebar 
            academy={activeAcademy}
            onAcademyChange={handleAcademyChange}
            isExpired={!!isSubscriptionExpired}
          />
          <SidebarInset className="flex-1">
            {/* Mobile Header */}
            <AcademyMobileHeader academyName={activeAcademy?.name} />
            
            {/* Page Content */}
            <main className="flex-1 p-4 md:p-6">
              <Suspense fallback={<PageContentSkeleton />}>
                <Outlet />
              </Suspense>
            </main>
          </SidebarInset>
        </div>
        
        
        <ReferralWidget />
      </SidebarProvider>
    </AcademyContext.Provider>
  );
}
