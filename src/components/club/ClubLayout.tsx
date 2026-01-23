import { useState, useEffect, createContext, useContext } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, MapPin, Settings, LogOut, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { getUserClubProfiles, type ClubProfile } from '@/lib/club';
import { ClubNavigation } from '@/components/club/ClubNavigation';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import type { Location } from '@/lib/locations';

interface ClubWithLocation extends ClubProfile {
  role: string;
  location: Location;
}

interface ClubContextValue {
  activeClub: ClubWithLocation | null;
  clubs: ClubWithLocation[];
  setActiveClub: (club: ClubWithLocation) => void;
  refreshClubs: () => Promise<void>;
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
  const { t, i18n } = useTranslation('club');
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [clubs, setClubs] = useState<ClubWithLocation[]>([]);
  const [activeClub, setActiveClub] = useState<ClubWithLocation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  const fetchClubs = async () => {
    if (!user) return;

    try {
      const userClubs = await getUserClubProfiles(user.id);
      setClubs(userClubs);
      
      // Try to restore previously selected club from localStorage
      const savedClubId = localStorage.getItem(ACTIVE_CLUB_STORAGE_KEY);
      const savedClub = savedClubId ? userClubs.find(c => c.id === savedClubId) : null;
      
      if (savedClub) {
        setActiveClub(savedClub);
      } else if (userClubs.length > 0) {
        setActiveClub(userClubs[0]);
        localStorage.setItem(ACTIVE_CLUB_STORAGE_KEY, userClubs[0].id);
      }
    } catch (error) {
      console.error('Error fetching clubs:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClubs();
  }, [user]);

  const handleClubChange = (club: ClubWithLocation) => {
    setActiveClub(club);
    localStorage.setItem(ACTIVE_CLUB_STORAGE_KEY, club.id);
  };

  const handleSignOut = async () => {
    await signOut();
    toast({
      title: t('common:success'),
      description: t('common:signedOut', 'Successfully signed out'),
    });
    navigate('/');
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
            <Skeleton className="h-8 w-40" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-8 w-32" />
            </div>
          </div>
        </div>
        <div className="border-b bg-card">
          <div className="container mx-auto px-4 py-6">
            <div className="flex items-center gap-3">
              <Skeleton className="h-12 w-12 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
            </div>
          </div>
        </div>
        <div className="container mx-auto px-4 py-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
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
            <Button onClick={() => navigate('/onboarding/club')}>
              {t('dashboard.claimClub', 'Claim a Club')}
            </Button>
            <Button variant="outline" onClick={() => navigate('/locations')}>
              {t('dashboard.browseLocations', 'Browse Locations')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ClubContext.Provider value={{ activeClub, clubs, setActiveClub: handleClubChange, refreshClubs: fetchClubs }}>
      <div className="min-h-screen bg-background">
        {/* Top Header Bar */}
        <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg sm:text-xl">PadelTrainer<span className="text-primary">.ai</span></span>
            </div>
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              <ProfileSwitcher 
                activeClubId={activeClub?.id} 
                onClubChange={handleClubChange} 
              />
              <Button variant="ghost" size="icon" onClick={() => navigate('/club/settings')}>
                <Settings className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={handleSignOut}>
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </header>

        {/* Club Info Section */}
        <div className="border-b bg-card">
          <div className="container mx-auto px-4 py-6">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Building2 className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h1 className="text-2xl font-bold">{activeClub?.location.name}</h1>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <MapPin className="h-4 w-4" />
                      <span>{activeClub?.location.city}</span>
                      <Badge variant={activeClub?.is_verified ? 'default' : 'secondary'}>
                        {activeClub?.is_verified ? t('common:verified') : t('dashboard.pendingVerification')}
                      </Badge>
                    </div>
                  </div>
                </div>
                
                {/* View Public Profile */}
                {activeClub?.location.slug && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(`/${i18n.language}/locations/${activeClub.location.slug}`, '_blank')}
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    {t('dashboard.viewPublicProfile')}
                  </Button>
                )}
              </div>
              
              {/* Navigation */}
              <ClubNavigation />
            </div>
          </div>
        </div>

        {/* Page Content */}
        <Outlet />
      </div>
    </ClubContext.Provider>
  );
}
