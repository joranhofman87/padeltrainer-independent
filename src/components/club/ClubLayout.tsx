import { useState, useEffect, createContext, useContext, Suspense } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { Building2, Menu } from 'lucide-react';
// SubscriptionOverlay removed - now using redirect approach
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageContentSkeleton } from '@/components/AppShellSkeleton';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { useAuth } from '@/hooks/useAuth';
import { getUserClubProfiles, type ClubProfile } from '@/lib/club';
import { ClubSidebar } from '@/components/club/ClubSidebar';
import { SidebarProvider, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import type { Location } from '@/lib/locations';

import { ReferralWidget } from '@/components/ReferralWidget';
import { 
  checkClubSubscription, 
  getTrialDaysRemaining, 
  type ClubSubscriptionInfo 
} from '@/lib/clubSubscription';
import { logger } from '@/lib/logger';

interface ClubWithLocation extends ClubProfile {
  role: string;
  location: Location;
}

interface ClubContextValue {
  activeClub: ClubWithLocation | null;
  clubs: ClubWithLocation[];
  setActiveClub: (club: ClubWithLocation) => void;
  refreshClubs: () => Promise<void>;
  subscription: ClubSubscriptionInfo | null;
  hasActiveSubscription: boolean;
  isTrialing: boolean;
  trialDaysRemaining: number;
  refreshSubscription: () => Promise<void>;
}

const ClubContext = createContext<ClubContextValue | undefined>(undefined);

export function useClubContext() {
  const context = useContext(ClubContext);
  if (!context) {
    throw new Error('useClubContext must be used within ClubLayout');
  }
  return context;
}

const ACTIVE_CLUB_STORAGE_KEY = 'activeClubId';

function ClubMobileHeader({ clubName }: { clubName?: string }) {
  const { t } = useTranslation('club');
  const { toggleSidebar } = useSidebar();

  return (
    <header
      className="sticky top-0 z-40 flex h-14 min-w-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80 md:hidden"
      data-testid="club-mobile-header"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={toggleSidebar}
        aria-label={t('nav.openMenu', 'Open menu')}
        data-testid="club-mobile-menu-trigger"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{clubName}</span>
    </header>
  );
}

export default function ClubLayout() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const location = useLocation();
  const localizePath = useLocalizedPathFn();
  const { user, loading: authLoading, profileReady } = useAuth();
  const authResolving = authLoading || (!!user && !profileReady);
  const [clubs, setClubs] = useState<ClubWithLocation[]>([]);
  const [activeClub, setActiveClub] = useState<ClubWithLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState<ClubSubscriptionInfo | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);

  useEffect(() => {
    if (!authResolving && !user) {
      navigate('/app/auth');
    }
  }, [user, authResolving, navigate]);

  const fetchClubs = async () => {
    if (!user) return;

    try {
      const userClubs = await getUserClubProfiles(user.id);
      setClubs(userClubs);
      
      const savedClubId = localStorage.getItem(ACTIVE_CLUB_STORAGE_KEY);
      const savedClub = savedClubId ? userClubs.find(c => c.id === savedClubId) : null;
      
      if (savedClub) {
        setActiveClub(savedClub);
      } else if (userClubs.length > 0) {
        setActiveClub(userClubs[0]);
        localStorage.setItem(ACTIVE_CLUB_STORAGE_KEY, userClubs[0].id);
      }
    } catch (error) {
      logger.error('Error fetching clubs', error as Error, { component: 'ClubLayout' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClubs();
  }, [user]);

  const fetchSubscription = async () => {
    if (!activeClub) {
      setSubscription(null);
      return;
    }
    
    setSubscriptionLoading(true);
    try {
      const sub = await checkClubSubscription(activeClub.id);
      setSubscription(sub);
    } catch (error) {
      logger.error('Error fetching subscription', error as Error, { component: 'ClubLayout' });
      setSubscription(null);
    } finally {
      setSubscriptionLoading(false);
    }
  };

  useEffect(() => {
    fetchSubscription();
    const interval = setInterval(fetchSubscription, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [activeClub]);

  const handleClubChange = (club: ClubWithLocation) => {
    setActiveClub(club);
    localStorage.setItem(ACTIVE_CLUB_STORAGE_KEY, club.id);
  };

  const hasActiveSubscription = subscription?.isSubscribed || false;
  const isTrialing = subscription?.isTrial && !subscription?.trialExpired;
  const trialDaysRemaining = subscription?.trialEnd 
    ? getTrialDaysRemaining(subscription.trialEnd) 
    : 0;
  const isSubscriptionExpired = subscription?.trialExpired && !subscription?.isSubscribed;
  const isOnSubscriptionPage = location.pathname === '/app/club/subscription';

  // Redirect to subscription page when expired
  useEffect(() => {
    if (!subscriptionLoading && isSubscriptionExpired && !isOnSubscriptionPage) {
      navigate('/app/club/subscription', { replace: true });
    }
  }, [subscriptionLoading, isSubscriptionExpired, isOnSubscriptionPage, navigate]);

  if (authResolving || loading || (clubs.length > 0 && !activeClub)) {
    return (
      <div className="min-h-screen bg-background" data-testid="club-layout-loading">
        <div className="flex min-h-screen w-full">
          <div className="hidden w-64 shrink-0 border-r border-slate-200 bg-slate-50 p-4 md:block">
            <Skeleton className="mb-6 h-8 w-full rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-full rounded-lg" />
              <Skeleton className="h-9 w-3/4 rounded-lg" />
            </div>
          </div>
          <div className="flex-1 p-4 md:p-6">
            <PageContentSkeleton />
          </div>
        </div>
      </div>
    );
  }

  if (clubs.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-16 text-center">
          <Building2 className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t('dashboard.title')}</h1>
          <p className="text-muted-foreground mb-6">
            {t('dashboard.noClubs', "You haven't claimed any clubs yet. Visit a location page to claim your club.")}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button onClick={() => navigate('/app/onboarding/club')}>
              {t('dashboard.claimClub', 'Claim a Club')}
            </Button>
            <Button variant="outline" onClick={() => navigate(localizePath('/locations'))}>
              {t('dashboard.browseLocations', 'Browse Locations')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ClubContext.Provider value={{ 
      activeClub, 
      clubs, 
      setActiveClub: handleClubChange, 
      refreshClubs: fetchClubs,
      subscription,
      hasActiveSubscription,
      isTrialing: isTrialing || false,
      trialDaysRemaining,
      refreshSubscription: fetchSubscription,
    }}>
      <SidebarProvider>
        <div className="min-h-screen flex w-full bg-background">
          <ClubSidebar 
            club={activeClub}
            onClubChange={handleClubChange}
            isExpired={!!isSubscriptionExpired}
          />
          <SidebarInset className="flex-1">
            <ClubMobileHeader clubName={activeClub?.location?.name} />
            <main className="flex-1">
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
    </ClubContext.Provider>
  );
}
