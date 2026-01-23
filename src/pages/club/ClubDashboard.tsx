import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { 
  Building2, 
  Users, 
  Calendar, 
  AlertCircle, 
  ArrowRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useClubContext } from '@/components/club/ClubLayout';
import { getClubPlayers, getClubTrainers } from '@/lib/club';
import { logger } from '@/lib/logger';

export default function ClubDashboard() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const { activeClub } = useClubContext();
  const [stats, setStats] = useState({ trainers: 0, players: 0 });

  useEffect(() => {
    async function fetchStats() {
      if (!activeClub) return;

      try {
        const [trainersData, playersData] = await Promise.all([
          getClubTrainers(activeClub.id),
          getClubPlayers(activeClub.id),
        ]);
        
        setStats({
          trainers: trainersData.length,
          players: playersData.length,
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

  return (
    <div className="container mx-auto px-4 py-8">
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/club/trainers')}>
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

        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/club/players')}>
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

        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/club/calendar')}>
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
            <Button onClick={() => navigate('/club/trainers')}>
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
            <Button onClick={() => navigate('/club/players')}>
              {t('players.title')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
