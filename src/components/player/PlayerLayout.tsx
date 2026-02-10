import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { PlayerSidebar } from '@/components/player/PlayerSidebar';

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
      <div className="min-h-screen bg-background">
        <div className="flex">
          <div className="w-60 border-r bg-card p-4">
            <div className="flex items-center gap-2 mb-6">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          </div>
          <div className="flex-1 p-6">
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

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
        <PlayerSidebar />
        <main className="flex-1 overflow-auto">
          {/* Mobile header */}
          <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b bg-background/80 backdrop-blur-sm px-4 lg:hidden">
            <SidebarTrigger />
            <span className="font-semibold">PadelTrainer<span className="text-primary">.ai</span></span>
          </header>
          <div className="p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
