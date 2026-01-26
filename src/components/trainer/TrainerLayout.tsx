import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Settings, LogOut, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { TrainerNavigation } from '@/components/trainer/TrainerNavigation';
import { signOut, getTrainerProfile } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';

export default function TrainerLayout() {
  const { t, i18n } = useTranslation('trainer');
  const navigate = useNavigate();
  const { user, profile, role, loading } = useAuth();
  const { toast } = useToast();
  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);

  // Auth guard
  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (!role) {
        navigate('/select-role');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  // Fetch trainer profile ID
  useEffect(() => {
    const fetchTrainerProfileId = async () => {
      if (user) {
        const trainerProfile = await getTrainerProfile(user.id);
        if (trainerProfile) {
          setTrainerProfileId(trainerProfile.id);
        }
      }
    };
    fetchTrainerProfileId();
  }, [user]);

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } else {
      navigate('/auth');
    }
  };

  if (loading) {
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
              <Skeleton className="h-12 w-12 rounded-full" />
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

  const initials = profile?.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'T';

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Top Header Bar */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span 
              className="font-bold text-lg sm:text-xl cursor-pointer" 
              onClick={() => navigate('/trainer')}
            >
              PadelTrainer<span className="text-primary">.ai</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ProfileSwitcher context="trainer" />
            <Button variant="ghost" size="icon" onClick={() => navigate('/trainer/settings')}>
              <Settings className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" onClick={handleSignOut}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Trainer Info Section */}
      <div className="border-b bg-card">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-12 w-12">
                  <AvatarImage src={profile?.avatar_url || undefined} />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <div>
                  <h1 className="text-2xl font-bold">{profile?.full_name || 'Trainer'}</h1>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="secondary" className="bg-orange-500/10 text-orange-600 dark:text-orange-400">
                      {t('badge')}
                    </Badge>
                  </div>
                </div>
              </div>
              
              {/* View Public Profile */}
              {trainerProfileId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`${window.location.origin}/${i18n.language}/trainer/${trainerProfileId}`, '_blank')}
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  {t('nav.viewPublicProfile')}
                </Button>
              )}
            </div>
            
            {/* Navigation */}
            <TrainerNavigation />
          </div>
        </div>
      </div>

      {/* Page Content via Outlet */}
      <Outlet />
    </div>
  );
}
