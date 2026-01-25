import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Settings, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/useAuth';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';

export default function TrainerLayout() {
  const { t } = useTranslation('trainer');
  const navigate = useNavigate();
  const { user, profile, role, loading } = useAuth();
  const { toast } = useToast();

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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
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
      {/* Persistent Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span 
              className="font-bold text-lg sm:text-xl cursor-pointer" 
              onClick={() => navigate('/trainer')}
            >
              PadelTrainer<span className="text-primary">.ai</span>
            </span>
            <span className="text-xs bg-orange-500 text-white px-1.5 py-0.5 rounded-full hidden sm:inline">
              {t('badge')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ProfileSwitcher context="trainer" />
            <Button variant="ghost" size="icon" onClick={() => navigate('/trainer/settings')}>
              <Settings className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2">
              <Avatar className="h-9 w-9">
                <AvatarImage src={profile?.avatar_url || undefined} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="font-medium hidden sm:inline">{profile?.full_name || 'Trainer'}</span>
            </div>
            <Button variant="ghost" size="icon" onClick={handleSignOut}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Page Content via Outlet */}
      <Outlet />
    </div>
  );
}
