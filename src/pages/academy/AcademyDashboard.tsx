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
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainers, getAcademyLocations, getAcademyViewStats } from '@/lib/academy';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { format } from 'date-fns';
import { UnpaidBookingsCard } from '@/components/trainer/UnpaidBookingsCard';

export default function AcademyDashboard() {
  const { t } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  const navigate = useNavigate();
  const { activeAcademy, isTrialing, trialDaysRemaining, hasActiveSubscription, subscription } = useAcademyContext();
  const [stats, setStats] = useState({ trainers: 0, locations: 0, viewsLast7Days: 0, viewsLast30Days: 0 });

  // Activity data
  const [recentPlayers, setRecentPlayers] = useState<any[]>([]);
  const [recentBookings, setRecentBookings] = useState<any[]>([]);
  const [recentRegistrations, setRecentRegistrations] = useState<any[]>([]);
  const [upcomingSlots, setUpcomingSlots] = useState<any[]>([]);

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

  useEffect(() => {
    if (!activeAcademy) return;
    fetchActivityData();
  }, [activeAcademy]);

  const fetchActivityData = async () => {
    if (!activeAcademy) return;
    const academyId = activeAcademy.id;
    const now = new Date().toISOString();

    try {
      // Get academy trainer IDs first
      const { data: academyTrainers } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', academyId)
        .eq('status', 'active');

      const trainerIds = academyTrainers?.map(t => t.trainer_profile_id) || [];

      if (trainerIds.length > 0) {
        // Recent Bookings on academy trainer slots
        const { data: bookings } = await supabase
          .from('bookings')
          .select(`
            id, status, payment_status, created_at,
            profiles:player_id (full_name),
            guest_players:guest_player_id (full_name),
            availability_slots!inner (trainer_id, start_time)
          `)
          .in('availability_slots.trainer_id', trainerIds)
          .order('created_at', { ascending: false })
          .limit(10);

        setRecentBookings(bookings || []);

        // Recent Players - get unique players from bookings on academy trainer slots  
        const { data: guestPlayers } = await supabase
          .from('guest_players')
          .select('id, full_name, email, has_trained, created_at')
          .in('trainer_id', trainerIds)
          .order('created_at', { ascending: false })
          .limit(10);

        setRecentPlayers(guestPlayers || []);

        // Upcoming Open Spots from academy trainers
        const { data: slots } = await supabase
          .from('availability_slots')
          .select('id, start_time, end_time, max_participants, is_marked_full, cyclus_name, locations:location_id (name)')
          .in('trainer_id', trainerIds)
          .eq('is_marked_full', false)
          .gte('start_time', now)
          .order('start_time', { ascending: true })
          .limit(10);

        setUpcomingSlots(slots || []);
      }

      // Registrations for academy cycles
      const { data: registrations } = await supabase
        .from('intake_requests')
        .select(`
          id, full_name, status, created_at,
          cycles!inner (owner_id, owner_type, name)
        `)
        .eq('cycles.owner_id', academyId)
        .eq('cycles.owner_type', 'academy')
        .order('created_at', { ascending: false })
        .limit(10);

      setRecentRegistrations(registrations || []);
    } catch (error) {
      logger.error('Error fetching academy activity data', error as Error, { component: 'AcademyDashboard', academyId });
    }
  };

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

      {/* Activity Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
        {/* Recent Players */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t('dashboard.recentPlayers', 'Recent Players')}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/trainers')}>
                {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentPlayers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('dashboard.noData', 'No data yet')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{tTrainer('players.name')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('players.addedOn')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('players.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentPlayers.map(player => (
                    <TableRow key={player.id}>
                      <TableCell className="text-sm py-2">{player.full_name}</TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">{format(new Date(player.created_at), 'dd MMM')}</TableCell>
                      <TableCell className="py-2">
                        <Badge variant={player.has_trained ? 'default' : 'secondary'} className="text-xs">
                          {player.has_trained ? tTrainer('players.active') : tTrainer('players.prospect')}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Bookings */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t('dashboard.recentBookings', 'Recent Bookings')}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/calendar')}>
                {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentBookings.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('dashboard.noData', 'No data yet')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{tTrainer('bookings.player')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('players.addedOn')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('players.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentBookings.map(booking => {
                    const playerName = (booking.profiles as any)?.full_name || (booking.guest_players as any)?.full_name || '—';
                    return (
                      <TableRow key={booking.id}>
                        <TableCell className="text-sm py-2">{playerName}</TableCell>
                        <TableCell className="text-sm py-2 text-muted-foreground">{format(new Date(booking.created_at), 'dd MMM')}</TableCell>
                        <TableCell className="py-2">
                          <Badge variant={booking.status === 'confirmed' ? 'default' : 'secondary'} className="text-xs">
                            {booking.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Registrations */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t('dashboard.registrations', 'Registrations')}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/intake-requests')}>
                {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentRegistrations.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('dashboard.noData', 'No data yet')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{tTrainer('players.name')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('players.addedOn')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('players.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRegistrations.map(reg => (
                    <TableRow key={reg.id}>
                      <TableCell className="text-sm py-2">{reg.full_name}</TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">{format(new Date(reg.created_at), 'dd MMM')}</TableCell>
                      <TableCell className="py-2">
                        <Badge variant={reg.status === 'confirmed' ? 'default' : 'secondary'} className="text-xs">
                          {reg.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Upcoming Open Spots */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t('dashboard.upcomingSpots', 'Upcoming Open Spots')}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/calendar')}>
                {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {upcomingSlots.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('dashboard.noData', 'No data yet')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t('dashboard.calendar')}</TableHead>
                    <TableHead className="text-xs">{t('locations.title')}</TableHead>
                    <TableHead className="text-xs">Max</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcomingSlots.map(slot => {
                    const location = slot.locations as { name: string } | null;
                    return (
                      <TableRow key={slot.id}>
                        <TableCell className="text-sm py-2">
                          <div>{format(new Date(slot.start_time), 'EEE dd MMM')}</div>
                          <div className="text-xs text-muted-foreground">{format(new Date(slot.start_time), 'HH:mm')} - {format(new Date(slot.end_time), 'HH:mm')}</div>
                        </TableCell>
                        <TableCell className="text-sm py-2 text-muted-foreground">{location?.name || '—'}</TableCell>
                        <TableCell className="text-sm py-2 text-muted-foreground">{slot.max_participants || '—'}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
