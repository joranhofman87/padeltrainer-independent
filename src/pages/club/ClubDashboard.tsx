import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { 
  Building2, 
  Users, 
  Calendar, 
  AlertCircle, 
  ArrowRight,
  Eye,
  Clock,
  AlertTriangle,
  Bell,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useClubContext } from '@/components/club/ClubLayout';
import { getClubPlayers, getClubTrainers } from '@/lib/club';
import { getClubViewStats } from '@/lib/clubProfileViews';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

export default function ClubDashboard() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const { activeClub, isTrialing, trialDaysRemaining, hasActiveSubscription, subscription } = useClubContext();
  const [stats, setStats] = useState({ trainers: 0, players: 0, followers: 0, viewsLast7Days: 0, viewsLast30Days: 0 });

  useEffect(() => {
    async function fetchStats() {
      if (!activeClub) return;

      try {
        const [trainersData, playersData, viewStats, followersData] = await Promise.all([
          getClubTrainers(activeClub.id),
          getClubPlayers(activeClub.id),
          getClubViewStats(activeClub.id),
          supabase
            .from('club_followers')
            .select('id', { count: 'exact', head: true })
            .eq('club_profile_id', activeClub.id),
        ]);
        
        setStats({
          trainers: trainersData.length,
          players: playersData.length,
          followers: followersData.count || 0,
          viewsLast7Days: viewStats.last7Days,
          viewsLast30Days: viewStats.last30Days,
        });
      } catch (error) {
        logger.error('Error fetching club stats', error as Error, { 
          component: 'ClubDashboard', 
          clubId: activeClub?.id 
        });
      }
    }

    fetchStats();
  }, [activeClub]);

  const isTrialExpired = subscription?.trialExpired && !subscription?.isSubscribed;

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Trial Banner */}
      {isTrialing && trialDaysRemaining > 0 && (
        <Alert className="mb-6 border-primary bg-primary/5">
          <Clock className="h-4 w-4" />
          <AlertTitle>{t('subscription.trialActive')}</AlertTitle>
          <AlertDescription className="flex items-center justify-between">
            <span>{t('subscription.trialDaysRemaining', { days: trialDaysRemaining })}</span>
            <Button variant="outline" size="sm" onClick={() => navigate('/app/club/subscription')}>
              {t('subscription.upgradeNow')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Trial Expired Banner */}
      {isTrialExpired && (
        <Alert variant="destructive" className="mb-6">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t('subscription.trialExpired')}</AlertTitle>
          <AlertDescription className="flex items-center justify-between">
            <span>{t('subscription.subscribeToAccess')}</span>
            <Button variant="outline" size="sm" onClick={() => navigate('/app/club/subscription')}>
              {t('subscription.upgradeNow')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Verification Alert */}
      {activeClub && !activeClub.is_verified && (
        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('dashboard.pendingVerification')}</AlertTitle>
          <AlertDescription>
            {t('dashboard.pendingVerificationDescription')}
          </AlertDescription>
        </Alert>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/app/club/trainers')}>
          <CardHeader className="pb-2">
            <CardDescription>{t('stats.trainers')}</CardDescription>
            <CardTitle className="text-3xl">{stats.trainers}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="ghost" size="sm" className="p-0 h-auto">
              {t('trainers.title')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/app/club/players')}>
          <CardHeader className="pb-2">
            <CardDescription>{t('stats.players')}</CardDescription>
            <CardTitle className="text-3xl">{stats.players}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="ghost" size="sm" className="p-0 h-auto">
              {t('players.title')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/app/club/calendar')}>
          <CardHeader className="pb-2">
            <CardDescription>{t('stats.upcomingSessions')}</CardDescription>
            <CardTitle className="text-3xl">-</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="ghost" size="sm" className="p-0 h-auto">
              {t('dashboard.calendar')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {t('stats.profileViews')}
            </CardDescription>
            <CardTitle className="text-3xl">{stats.viewsLast7Days}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {t('stats.last7Days')} · {stats.viewsLast30Days} {t('stats.last30Days').toLowerCase()}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1">
              <Bell className="h-3 w-3" />
              {t('stats.followers', 'Followers')}
            </CardDescription>
            <CardTitle className="text-3xl">{stats.followers}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {t('stats.followersDescription', 'Players following your club')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <h2 className="text-lg font-semibold mb-4">{t('dashboard.overview')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              {t('trainers.title')}
            </CardTitle>
            <CardDescription>{t('trainers.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/app/club/trainers')}>
              {t('trainers.title')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Calendar className="h-5 w-5" />
              {t('players.title')}
            </CardTitle>
            <CardDescription>{t('players.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/app/club/players')}>
              {t('players.title')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
