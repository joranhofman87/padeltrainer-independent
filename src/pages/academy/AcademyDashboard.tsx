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
  ExternalLink,
  EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainers, getAcademyLocations, getAcademyViewStats, getAcademyTrainersWithProfiles } from '@/lib/academy';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { getMarketingUrl } from '@/lib/domains';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { UnpaidBookingsCard } from '@/components/trainer/UnpaidBookingsCard';
import { useQuery } from '@tanstack/react-query';

const DASHBOARD_STALE_TIME = 5 * 60 * 1000; // 5 minutes

export default function AcademyDashboard() {
  const { t, i18n } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  const { t: tCycles } = useTranslation('cycles');
  const navigate = useNavigate();
  const { activeAcademy, isTrialing, trialDaysRemaining, hasActiveSubscription, subscription } = useAcademyContext();

  const academyId = activeAcademy?.id;

  // Stats query
  const { data: stats = { trainers: 0, locations: 0, viewsLast30Days: 0 } } = useQuery({
    queryKey: ['academy-stats', academyId],
    queryFn: async () => {
      const [trainersData, locationsData, viewStats] = await Promise.all([
        getAcademyTrainers(academyId!),
        getAcademyLocations(academyId!),
        getAcademyViewStats(academyId!),
      ]);
      return {
        trainers: trainersData.length,
        locations: locationsData.length,
        viewsLast30Days: viewStats.last30Days,
      };
    },
    enabled: !!academyId,
    staleTime: DASHBOARD_STALE_TIME,
  });

  // Trainers query
  const { data: trainers = [] } = useQuery({
    queryKey: ['academy-trainers-dashboard', academyId],
    queryFn: () => getAcademyTrainersWithProfiles(academyId!),
    enabled: !!academyId,
    staleTime: DASHBOARD_STALE_TIME,
  });

  const activeTrainers = trainers
    .filter((t: any) => t.status === 'active' && t.trainer_profile)
    .slice(0, 6);

  // Activity data query - consolidated into one query with parallelized sub-fetches
  const { data: activity } = useQuery({
    queryKey: ['academy-activity', academyId],
    queryFn: async () => {
      const now = new Date().toISOString();

      // Get academy trainer IDs first
      const { data: academyTrainers } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('academy_profile_id', academyId!)
        .eq('status', 'active');

      const trainerIds = academyTrainers?.map(t => t.trainer_profile_id) || [];

      // Run registrations query in parallel with trainer-dependent queries
      const registrationsPromise = supabase
        .from('intake_requests')
        .select(`
          id, full_name, status, created_at,
          cycles!inner (owner_id, owner_type, name)
        `)
        .eq('cycles.owner_id', academyId!)
        .eq('cycles.owner_type', 'academy')
        .order('created_at', { ascending: false })
        .limit(10);

      let recentBookings: any[] = [];
      let recentPlayers: any[] = [];
      let upcomingSlots: any[] = [];

      if (trainerIds.length > 0) {
        // Run all trainer-dependent queries in parallel
        const [bookingsRes, guestPlayersRes, registeredBookingsRes, slotsRes] = await Promise.all([
          supabase
            .from('bookings')
            .select(`
              id, status, payment_status, paid_externally, created_at,
              profiles:player_id (full_name),
              guest_players:guest_player_id (full_name),
              availability_slots!inner (trainer_id, start_time, cyclus_name)
            `)
            .in('availability_slots.trainer_id', trainerIds)
            .order('created_at', { ascending: false })
            .limit(10),
          supabase
            .from('guest_players')
            .select('id, full_name, email, has_trained, created_at')
            .in('trainer_id', trainerIds)
            .order('created_at', { ascending: false })
            .limit(10),
          supabase
            .from('bookings')
            .select(`
              id, created_at, player_id,
              profiles:player_id (id, full_name),
              availability_slots!inner (trainer_id)
            `)
            .in('availability_slots.trainer_id', trainerIds)
            .not('player_id', 'is', null)
            .order('created_at', { ascending: false })
            .limit(20),
          supabase
            .from('availability_slots')
            .select('id, start_time, end_time, max_participants, is_marked_full, cyclus_name, cyclus_id, locations:location_id (name)')
            .in('trainer_id', trainerIds)
            .eq('is_marked_full', false)
            .gte('start_time', now)
            .order('start_time', { ascending: true })
            .limit(50),
        ]);

        // Process bookings - group by cyclus + player
        const rawBookings = bookingsRes.data || [];
        const groupedBookings: any[] = [];
        const cyclusPlayerMap = new Map<string, any>();
        for (const b of rawBookings) {
          const slot = b.availability_slots as any;
          const cyclusName = slot?.cyclus_name;
          const playerId = (b as any).player_id || (b as any).guest_player_id || '';
          if (cyclusName && playerId) {
            const key = `${cyclusName}::${playerId}`;
            if (!cyclusPlayerMap.has(key)) {
              cyclusPlayerMap.set(key, { ...b, sessionCount: 1 });
              groupedBookings.push(cyclusPlayerMap.get(key));
            } else {
              cyclusPlayerMap.get(key)!.sessionCount++;
            }
          } else {
            groupedBookings.push({ ...b, sessionCount: 1 });
          }
        }
        recentBookings = groupedBookings;

        // Process players - merge guest + registered
        const seenPlayerIds = new Set<string>();
        const registeredPlayers: any[] = [];
        for (const b of registeredBookingsRes.data || []) {
          const profile = b.profiles as any;
          if (profile?.id && !seenPlayerIds.has(profile.id)) {
            seenPlayerIds.add(profile.id);
            registeredPlayers.push({
              id: profile.id,
              full_name: profile.full_name || '—',
              has_trained: true,
              created_at: b.created_at,
              _isRegistered: true,
            });
          }
        }
        recentPlayers = [...(guestPlayersRes.data || []), ...registeredPlayers]
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 10);

        // Process slots - group by cyclus_id
        const rawSlots = slotsRes.data || [];
        const grouped: any[] = [];
        const cyclusMap = new Map<string, any>();
        for (const slot of rawSlots) {
          if (slot.cyclus_id) {
            if (!cyclusMap.has(slot.cyclus_id)) {
              cyclusMap.set(slot.cyclus_id, { ...slot, sessionCount: 1 });
              grouped.push(cyclusMap.get(slot.cyclus_id));
            } else {
              cyclusMap.get(slot.cyclus_id)!.sessionCount++;
            }
          } else {
            grouped.push({ ...slot, sessionCount: 1 });
          }
        }
        upcomingSlots = grouped;
      }

      const registrationsRes = await registrationsPromise;

      return {
        recentBookings,
        recentPlayers,
        recentRegistrations: registrationsRes.data || [],
        upcomingSlots,
      };
    },
    enabled: !!academyId,
    staleTime: DASHBOARD_STALE_TIME,
  });

  const recentPlayers = activity?.recentPlayers || [];
  const recentBookings = activity?.recentBookings || [];
  const recentRegistrations = activity?.recentRegistrations || [];
  const upcomingSlots = activity?.upcomingSlots || [];

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

      {/* Subscription Alert */}
      {activeAcademy && activeAcademy.subscription_status !== 'active' && (
        <Alert className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{t('dashboard.subscriptionRequired', 'Subscription required')}</AlertTitle>
          <AlertDescription>
            {t('dashboard.subscriptionRequiredDescription', 'Subscribe to a paid plan to make your academy visible in the directory.')}
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
            <CardTitle className="text-3xl">{stats.viewsLast30Days}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              variant="ghost"
              size="sm"
              className="p-0 h-auto"
              onClick={() => {
                const lang = i18n.language || 'nl';
                window.open(getMarketingUrl(`academies/${activeAcademy?.slug}`, lang) + '?preview=true', '_blank');
              }}
            >
              {t('dashboard.viewProfile', 'View profile')} <ExternalLink className="ml-2 h-4 w-4" />
            </Button>
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
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/players')}>
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
                    <TableHead className="text-xs">{tTrainer('cycles.cyclus', 'Cyclus')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('players.addedOn')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('bookings.payment', 'Payment')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentBookings.map(booking => {
                    const playerName = (booking.profiles as any)?.full_name || (booking.guest_players as any)?.full_name || '—';
                    const cyclusName = (booking.availability_slots as any)?.cyclus_name;
                    return (
                      <TableRow key={booking.id}>
                        <TableCell className="text-sm py-2">{playerName}</TableCell>
                        <TableCell className="text-sm py-2 text-muted-foreground">
                          {cyclusName ? (
                            <span>{cyclusName} <span className="text-xs">({booking.sessionCount} {booking.sessionCount === 1 ? tTrainer('dashboard.session', 'session') : tTrainer('dashboard.sessions', 'sessions')})</span></span>
                          ) : '—'}
                        </TableCell>
                        <TableCell className="text-sm py-2 text-muted-foreground">{format(new Date(booking.created_at), 'dd MMM', { locale: i18n.language === 'nl' ? nl : enUS })}</TableCell>
                        <TableCell className="py-2">
                          <Badge variant={booking.payment_status === 'paid' ? 'default' : 'secondary'} className="text-xs">
                            {booking.payment_status === 'paid' && (booking as any).paid_externally
                              ? tTrainer('bookings.paidExternally', 'Paid (external)')
                              : booking.payment_status}
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
                      <TableCell className="text-sm py-2 text-muted-foreground">{format(new Date(reg.created_at), 'dd MMM', { locale: i18n.language === 'nl' ? nl : enUS })}</TableCell>
                      <TableCell className="py-2">
                        <Badge variant={reg.status === 'confirmed' ? 'default' : 'secondary'} className="text-xs">
                          {tCycles(`intakeRequests.filters.${reg.status}`, reg.status)}
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
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/open-slots')}>
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
                    <TableHead className="text-xs">{tTrainer('cycles.name', 'Name')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('dashboard.sessions', 'Sessions')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('dashboard.nextSession', 'Next session')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcomingSlots.map((slot) => (
                    <TableRow key={slot.cyclus_id || slot.id}>
                      <TableCell className="text-sm py-2">{slot.cyclus_name || '—'}</TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">
                        {slot.sessionCount} {slot.sessionCount === 1 ? tTrainer('dashboard.session', 'session') : tTrainer('dashboard.sessions', 'sessions')}
                      </TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">
                        <div>{format(new Date(slot.start_time), 'EEE dd MMM', { locale: i18n.language === 'nl' ? nl : enUS })}</div>
                        <div className="text-xs">{format(new Date(slot.start_time), 'HH:mm')}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
