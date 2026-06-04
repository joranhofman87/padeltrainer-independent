import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Menu } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import {
  SidebarProvider,
  SidebarInset,
  useSidebar,
} from '@/components/ui/sidebar';
import { PlayerSidebar } from '@/components/player/PlayerSidebar';
import { ReferralWidget } from '@/components/ReferralWidget';

function PlayerMobileHeader() {
  const { t } = useTranslation('player');
  const { profile } = useAuth();
  const { toggleSidebar } = useSidebar();

  const displayName = profile?.full_name?.split(' ')[0] || t('nav.dashboard', 'Dashboard');

  return (
    <header
      className="sticky top-0 z-40 flex h-14 min-w-0 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-white/80 lg:hidden"
      data-testid="player-mobile-header"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        onClick={toggleSidebar}
        aria-label={t('nav.openMenu', 'Open menu')}
        data-testid="player-mobile-menu-trigger"
      >
        <Menu className="h-5 w-5" />
      </Button>
      <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{displayName}</span>
    </header>
  );
}

export default function PlayerLayout() {
  const navigate = useNavigate();
  const { user, roles, loading } = useAuth();

  // Auth guard - allow player, trainer (with player role), and admin
  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/app/auth');
      } else if (roles.length === 0) {
        navigate('/app/auth');
      } else if (!roles.includes('player') && !roles.includes('trainer') && !roles.includes('admin')) {
        navigate('/app/auth');
      }
    }
  }, [user, roles, loading, navigate]);

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50/80">
        <div className="flex">
          <div className="w-60 border-r border-slate-200 bg-slate-50 p-4">
            <div className="mb-6 flex items-center gap-2">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
          <div className="flex-1 p-4 md:p-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
              <Skeleton className="h-32 rounded-xl" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <PlayerSidebar />
        <SidebarInset className="flex min-w-0 flex-1 flex-col bg-slate-50/50">
          <PlayerMobileHeader />
          <div className="flex-1 p-4 md:p-6">
            <Outlet />
          </div>
        </SidebarInset>
      </div>
      <ReferralWidget />
    </SidebarProvider>
  );
}
