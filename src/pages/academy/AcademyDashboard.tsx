import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { 
  Users, 
  MapPin, 
  AlertCircle, 
  ArrowRight,
  Eye,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainers, getAcademyLocations, getAcademyViewStats } from '@/lib/academy';
import { logger } from '@/lib/logger';
import { UnpaidBookingsCard } from '@/components/trainer/UnpaidBookingsCard';

export default function AcademyDashboard() {
  const { t } = useTranslation('academy');
  const navigate = useNavigate();
  const { activeAcademy, isTrialing, trialDaysRemaining, hasActiveSubscription, subscription } = useAcademyContext();
  const [stats, setStats] = useState({ trainers: 0, locations: 0, viewsLast7Days: 0, viewsLast30Days: 0 });

  useEffect(() => {
    async function fetchStats() {
      if (!activeAcademy) return;

      try {
        const [trainersData, locationsData, viewStats] = await Promise.all([
          getAcademyTrainers(activeAcademy.id),
          getAcademyLocations(activeAcademy.id),
          getAcademyViewStats(activeAcademy.id),
        ]);
        
        setStats({
          trainers: trainersData.length,
          locations: locationsData.length,
          viewsLast7Days: viewStats.last7Days,
          viewsLast30Days: viewStats.last30Days,
        });
      } catch (error) {
        logger.error('Error fetching academy stats', error as Error, { 
          component: 'AcademyDashboard', 
          academyId: activeAcademy?.id 
        });
      }
    }

    fetchStats();
  }, [activeAcademy]);

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
            <Button variant="outline" size="sm" onClick={() => navigate('/app/academy/subscription')}>
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
            <Button variant="outline" size="sm" onClick={() => navigate('/app/academy/subscription')}>
              {t('subscription.upgradeNow')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Verification Alert */}
      {activeAcademy && !activeAcademy.is_verified && (
        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('dashboard.pendingVerification')}</AlertTitle>
          <AlertDescription>
            {t('dashboard.pendingVerificationDescription')}
          </AlertDescription>
        </Alert>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/app/academy/trainers')}>
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

        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/app/academy/locations')}>
          <CardHeader className="pb-2">
            <CardDescription>{t('stats.locations')}</CardDescription>
            <CardTitle className="text-3xl">{stats.locations}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="ghost" size="sm" className="p-0 h-auto">
              {t('locations.title')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => navigate('/app/academy/calendar')}>
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
      </div>

      {/* Unpaid Bookings */}
      {activeAcademy && (
        <UnpaidBookingsCard academyId={activeAcademy.id} />
      )}

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
            <Button onClick={() => navigate('/app/academy/trainers')}>
              {t('trainers.manage')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              {t('locations.title')}
            </CardTitle>
            <CardDescription>{t('locations.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate('/app/academy/locations')}>
              {t('locations.manage')} <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
