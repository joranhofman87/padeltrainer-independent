import { useState, useEffect, createContext, useContext } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';
import { GraduationCap, Settings, LogOut, ExternalLink } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { getUserAcademyProfiles, type AcademyProfile } from '@/lib/academy';
import { AcademyNavigation } from '@/components/academy/AcademyNavigation';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';

interface AcademyWithRole extends AcademyProfile {
  role: string;
}

interface AcademyContextValue {
  activeAcademy: AcademyWithRole | null;
  academies: AcademyWithRole[];
  setActiveAcademy: (academy: AcademyWithRole) => void;
  refreshAcademies: () => Promise<void>;
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
  const { t, i18n } = useTranslation('academy');
  const navigate = useNavigate();
  const localizePath = useLocalizedPathFn();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [academies, setAcademies] = useState<AcademyWithRole[]>([]);
  const [activeAcademy, setActiveAcademy] = useState<AcademyWithRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
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

  const handleAcademyChange = (academy: AcademyWithRole) => {
    setActiveAcademy(academy);
    localStorage.setItem(ACTIVE_ACADEMY_STORAGE_KEY, academy.id);
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

  if (academies.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-16 text-center">
          <GraduationCap className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t('dashboard.title')}</h1>
          <p className="text-muted-foreground mb-6">
            {t('dashboard.noAcademies', "You haven't created any academies yet.")}
          </p>
          <Button onClick={() => navigate('/academy/onboarding')}>
            {t('dashboard.createAcademy', 'Create an Academy')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <AcademyContext.Provider value={{ activeAcademy, academies, setActiveAcademy: handleAcademyChange, refreshAcademies: fetchAcademies }}>
      <div className="min-h-screen bg-background">
        {/* Top Header Bar */}
        <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-bold text-lg sm:text-xl">PadelTrainer<span className="text-primary">.ai</span></span>
            </div>
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              <ThemeToggle />
              <ProfileSwitcher />
              <Button variant="ghost" size="icon" onClick={() => navigate('/academy/settings')}>
                <Settings className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={handleSignOut}>
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </header>

        {/* Academy Info Section */}
        <div className="border-b bg-card">
          <div className="container mx-auto px-4 py-6">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div className="flex items-center gap-3">
                  {activeAcademy?.logo_url ? (
                    <img 
                      src={activeAcademy.logo_url} 
                      alt={activeAcademy.name}
                      className="h-12 w-12 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center">
                      <GraduationCap className="h-6 w-6 text-primary" />
                    </div>
                  )}
                  <div>
                    <h1 className="text-2xl font-bold">{activeAcademy?.name}</h1>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Badge variant={activeAcademy?.is_verified ? 'default' : 'secondary'}>
                        {activeAcademy?.is_verified ? t('common:verified') : t('dashboard.pendingVerification')}
                      </Badge>
                      {activeAcademy?.is_public && (
                        <Badge variant="outline">{t('dashboard.public')}</Badge>
                      )}
                    </div>
                  </div>
                </div>
                
                {/* View Public Profile */}
                {activeAcademy?.slug && activeAcademy?.is_verified && activeAcademy?.is_public && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const lang = i18n.language === 'en' || i18n.language === 'nl' ? i18n.language : 'en';
                      window.open(`${window.location.origin}/${lang}/academies/${activeAcademy.slug}`, '_blank');
                    }}
                  >
                    <ExternalLink className="h-4 w-4 mr-2" />
                    {t('dashboard.viewPublicProfile')}
                  </Button>
                )}
              </div>
              
              {/* Navigation */}
              <AcademyNavigation />
            </div>
          </div>
        </div>

        {/* Page Content */}
        <Outlet />
      </div>
    </AcademyContext.Provider>
  );
}
