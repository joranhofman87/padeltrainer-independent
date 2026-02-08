import { useState, useEffect, createContext, useContext } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { Building2, Menu, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { getUserClubProfiles, type ClubProfile } from '@/lib/club';
import { ClubSidebar } from '@/components/club/ClubSidebar';
import { SidebarProvider, SidebarTrigger, SidebarInset } from '@/components/ui/sidebar';
import { useToast } from '@/hooks/use-toast';
import type { Location } from '@/lib/locations';
import { SubscriptionOverlay } from '@/components/shared/SubscriptionOverlay';
import { 
  checkClubSubscription, 
  getTrialDaysRemaining, 
  CLUB_SUBSCRIPTION,
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

export default function ClubLayout() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const location = useLocation();
  const localizePath = useLocalizedPathFn();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [clubs, setClubs] = useState<ClubWithLocation[]>([]);
  const [activeClub, setActiveClub] = useState<ClubWithLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState<ClubSubscriptionInfo | null>(null);
  const [subscriptionLoading, setSubscriptionLoading] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/app/auth');
    }
  }, [user, authLoading, navigate]);

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
    const interval = setInterval(fetchSubscription, 60000);
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

  if (activeClub && !activeClub.is_verified) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-16 text-center max-w-lg">
          <Clock className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t('dashboard.pendingTitle')}</h1>
          <p className="text-muted-foreground mb-2">
            {t('dashboard.pendingDescription', { clubName: activeClub.location?.name })}
          </p>
          <p className="text-sm text-muted-foreground mb-6">
            {t('dashboard.pendingNote')}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button variant="outline" onClick={() => navigate(localizePath('/locations'))}>
              {t('dashboard.browseLocations', 'Browse Locations')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const subscriptionFeatures = [
    t('subscription.features.unlimitedTrainers', 'Unlimited trainers'),
    t('subscription.features.unifiedCalendar', 'Unified calendar'),
    t('subscription.features.analytics', 'Club analytics'),
    t('subscription.features.prioritySupport', 'Priority support'),
  ];

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
              <span className="font-semibold truncate">{activeClub?.location?.name}</span>
            </header>
            
            {/* Page Content */}
            <main className="flex-1">
              <Outlet />
            </main>
          </SidebarInset>
        </div>
        
        {/* Subscription Paywall Overlay */}
        {!subscriptionLoading && isSubscriptionExpired && !isOnSubscriptionPage && (
          <SubscriptionOverlay
            roleName="club"
            subscriptionPath="/app/club/subscription"
            pricing={{
              monthly: CLUB_SUBSCRIPTION.monthlyPrice,
              yearly: CLUB_SUBSCRIPTION.yearlyPrice,
            }}
            features={subscriptionFeatures}
            trialDaysRemaining={trialDaysRemaining}
            isTrialExpired={isSubscriptionExpired}
          />
        )}
      </SidebarProvider>
    </ClubContext.Provider>
  );
}
