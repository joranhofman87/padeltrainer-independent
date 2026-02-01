import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LogOut } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { PlayerNavigation } from '@/components/player/PlayerNavigation';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';

export default function PlayerLayout() {
  const { t } = useTranslation('player');
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
      } else if (role !== 'player' && role !== 'admin') {
        // Allow admins to access player dashboard (they may also be players)
        navigate('/trainer');
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
    .toUpperCase() || 'P';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
      {/* Top Header Bar */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span 
              className="font-bold text-lg sm:text-xl cursor-pointer" 
              onClick={() => navigate('/player')}
            >
              PadelTrainer<span className="text-primary">.ai</span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ThemeToggle />
            <ProfileSwitcher context="player" />
            <Button variant="ghost" size="icon" onClick={handleSignOut}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Player Info Section */}
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
                  <h1 className="text-2xl font-bold">{profile?.full_name || 'Player'}</h1>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400">
                      {t('badge')}
                    </Badge>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Navigation */}
            <PlayerNavigation />
          </div>
        </div>
      </div>

      {/* Page Content via Outlet */}
      <Outlet />
    </div>
  );
}
