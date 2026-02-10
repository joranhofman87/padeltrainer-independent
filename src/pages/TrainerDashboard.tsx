import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { 
  Users, DollarSign, Clock, 
  Bell, Eye, ArrowRight,
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { startOfMonth, endOfMonth, format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TrainerTrialBanner } from '@/components/trainer/TrainerTrialBanner';
import { UnpaidBookingsCard } from '@/components/trainer/UnpaidBookingsCard';

interface DashboardStats {
  totalStudents: number;
  openSlots: number;
  monthlyEarnings: number;
  followerCount: number;
  profileViews: number;
}

export default function TrainerDashboard() {
  const { user, profile, role, loading, subscription } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation('trainer');
  const [stats, setStats] = useState<DashboardStats>({
    totalStudents: 0,
    openSlots: 0,
    monthlyEarnings: 0,
    followerCount: 0,
    profileViews: 0,
  });
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // Activity data
  const [recentPlayers, setRecentPlayers] = useState<any[]>([]);
  const [recentBookings, setRecentBookings] = useState<any[]>([]);
  const [recentRegistrations, setRecentRegistrations] = useState<any[]>([]);
  const [upcomingSlots, setUpcomingSlots] = useState<any[]>([]);

  useEffect(() => {
    if (user && role === 'trainer') {
      fetchStats();
    }
  }, [user, role]);

  useEffect(() => {
    if (trainerId) {
      fetchActivityData();
    }
  }, [trainerId]);

  const fetchActivityData = async () => {
    if (!trainerId) return;
    try {
      const now = new Date().toISOString();

      // Recent Players (guest_players by created_at desc, limit 10)
      const { data: players } = await supabase
        .from('guest_players')
        .select('id, full_name, email, skill_rating, rating_system, has_trained, created_at')
        .eq('trainer_id', trainerId)
        .order('created_at', { ascending: false })
        .limit(10);

      // Recent Bookings (last 10 by created_at)
      const { data: bookings } = await supabase
        .from('bookings')
        .select(`
          id, status, payment_status, created_at,
          profiles:player_id (full_name),
          guest_players:guest_player_id (full_name),
          availability_slots!inner (trainer_id, start_time, cyclus_name)
        `)
        .eq('availability_slots.trainer_id', trainerId)
        .order('created_at', { ascending: false })
        .limit(10);

      // Registrations (intake_requests via cycles owned by trainer)
      const { data: registrations } = await supabase
        .from('intake_requests')
        .select(`
          id, full_name, status, created_at,
          cycles!inner (owner_id, name)
        `)
        .eq('cycles.owner_id', trainerId)
        .order('created_at', { ascending: false })
        .limit(10);

      // Upcoming Open Spots (next 10 available slots)
      const { data: slots } = await supabase
        .from('availability_slots')
        .select('id, start_time, end_time, max_participants, is_marked_full, cyclus_name, cyclus_id, locations:location_id (name)')
        .eq('trainer_id', trainerId)
        .eq('is_marked_full', false)
        .gte('start_time', now)
        .order('start_time', { ascending: true })
        .limit(50);

      // Group upcoming slots by cyclus_id
      const rawSlots = slots || [];
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

      setRecentPlayers(players || []);

      // Group bookings by cyclus + player to show cyclus bookings as one row
      const rawBookings = bookings || [];
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

      setRecentBookings(groupedBookings);
      setRecentRegistrations(registrations || []);
      setUpcomingSlots(grouped);
    } catch (error) {
      logger.error('Error fetching activity data', error as Error, { component: 'TrainerDashboard' });
    }
  };

  const fetchStats = async () => {
    try {
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user?.id)
        .maybeSingle();

      if (!trainerProfile) {
        setStatsLoading(false);
        return;
      }

      setTrainerId(trainerProfile.id);
      const currentTrainerId = trainerProfile.id;
      const now = new Date();
      const monthStart = startOfMonth(now);
      const monthEnd = endOfMonth(now);

      const { count: guestPlayerCount } = await supabase
        .from('guest_players')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      const { data: futureSlots } = await supabase
        .from('availability_slots')
        .select(`id, is_marked_full, max_participants, bookings(id, status)`)
        .eq('trainer_id', currentTrainerId)
        .eq('is_marked_full', false)
        .gte('start_time', now.toISOString());

      let openSlotsCount = 0;
      futureSlots?.forEach(slot => {
        const maxParticipants = slot.max_participants || 4;
        const confirmedBookings = slot.bookings?.filter((b: { status: string }) => b.status === 'confirmed').length || 0;
        if (confirmedBookings < maxParticipants) {
          openSlotsCount++;
        }
      });

      const { data: monthlyBookings } = await supabase
        .from('bookings')
        .select(`payment_amount, paid_at, availability_slots!inner(trainer_id)`)
        .eq('availability_slots.trainer_id', currentTrainerId)
        .eq('payment_status', 'paid')
        .gte('paid_at', monthStart.toISOString())
        .lte('paid_at', monthEnd.toISOString());

      const totalEarnings = monthlyBookings?.reduce((sum, b) => sum + (b.payment_amount || 0), 0) || 0;
      const netEarnings = totalEarnings * 0.9;

      const { count: followerCount } = await supabase
        .from('trainer_followers')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const { count: profileViews } = await supabase
        .from('trainer_profile_views')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId)
        .gte('viewed_at', thirtyDaysAgo.toISOString());

      setStats({
        totalStudents: guestPlayerCount || 0,
        openSlots: openSlotsCount,
        monthlyEarnings: netEarnings,
        followerCount: followerCount || 0,
        profileViews: profileViews || 0,
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      setStatsLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <main className="container mx-auto px-4 py-8">
      {/* Trial Banner */}
      {subscription && !subscription.isSubscribed && (
        <TrainerTrialBanner 
          trialEndsAt={subscription.trialEndsAt}
          onUpgrade={() => navigate('/app/trainer/subscription')}
        />
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
        <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => navigate('/app/trainer/analytics')}>
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.profileViews')}</p>
                <p className="text-2xl sm:text-3xl font-bold">{statsLoading ? '...' : stats.profileViews}</p>
              </div>
              <div className="p-2 sm:p-3 rounded-full bg-sky-100 dark:bg-sky-900">
                <Eye className="h-4 w-4 sm:h-5 sm:w-5 text-sky-600 dark:text-sky-400" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewProfileViews')}</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => navigate('/app/trainer/analytics')}>
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.followers')}</p>
                <p className="text-2xl sm:text-3xl font-bold">{statsLoading ? '...' : stats.followerCount}</p>
              </div>
              <div className="p-2 sm:p-3 rounded-full bg-purple-100 dark:bg-purple-900">
                <Bell className="h-4 w-4 sm:h-5 sm:w-5 text-purple-600 dark:text-purple-400" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewFollowers')}</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => navigate('/app/trainer/players')}>
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.totalStudents')}</p>
                <p className="text-2xl sm:text-3xl font-bold">{statsLoading ? '...' : stats.totalStudents}</p>
              </div>
              <div className="p-2 sm:p-3 rounded-full bg-green-100 dark:bg-green-900">
                <Users className="h-4 w-4 sm:h-5 sm:w-5 text-green-600 dark:text-green-400" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewStudents')}</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => navigate('/app/trainer/open-slots')}>
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.openSlots')}</p>
                <p className="text-2xl sm:text-3xl font-bold">{statsLoading ? '...' : stats.openSlots}</p>
              </div>
              <div className="p-2 sm:p-3 rounded-full bg-blue-100 dark:bg-blue-900">
                <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-blue-600 dark:text-blue-400" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewSlots')}</p>
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:shadow-lg transition-shadow col-span-2 sm:col-span-1" onClick={() => navigate('/app/trainer/earnings')}>
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.revenue')}</p>
                <p className="text-2xl sm:text-3xl font-bold">{statsLoading ? '...' : `€${stats.monthlyEarnings.toFixed(0)}`}</p>
              </div>
              <div className="p-2 sm:p-3 rounded-full bg-orange-100 dark:bg-orange-900">
                <DollarSign className="h-4 w-4 sm:h-5 sm:w-5 text-orange-600 dark:text-orange-400" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewEarnings')}</p>
          </CardContent>
        </Card>
      </div>

      {/* Unpaid Bookings */}
      <UnpaidBookingsCard trainerId={trainerId} />

      {/* Activity Sections */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
        {/* Recent Players */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t('dashboard.recentPlayers', 'Recent Players')}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/trainer/players')}>
                {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentPlayers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('players.noPlayers')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t('players.name')}</TableHead>
                    <TableHead className="text-xs">{t('players.addedOn')}</TableHead>
                    <TableHead className="text-xs">{t('players.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentPlayers.map(player => (
                    <TableRow key={player.id}>
                      <TableCell className="text-sm py-2">{player.full_name}</TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">{format(new Date(player.created_at), 'dd MMM')}</TableCell>
                      <TableCell className="py-2">
                        <Badge variant={player.has_trained ? 'default' : 'secondary'} className="text-xs">
                          {player.has_trained ? t('players.active') : t('players.prospect')}
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
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/trainer/bookings')}>
                {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentBookings.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('bookings.empty')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t('bookings.player')}</TableHead>
                    <TableHead className="text-xs">{t('cycles.cyclus', 'Cyclus')}</TableHead>
                    <TableHead className="text-xs">{t('players.addedOn')}</TableHead>
                    <TableHead className="text-xs">{t('bookings.payment', 'Payment')}</TableHead>
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
                            <span>{cyclusName} <span className="text-xs">({booking.sessionCount} {booking.sessionCount === 1 ? t('dashboard.session', 'session') : t('dashboard.sessions', 'sessions')})</span></span>
                          ) : '—'}
                        </TableCell>
                        <TableCell className="text-sm py-2 text-muted-foreground">{format(new Date(booking.created_at), 'dd MMM')}</TableCell>
                        <TableCell className="py-2">
                          <Badge variant={booking.payment_status === 'paid' ? 'default' : 'secondary'} className="text-xs">
                            {booking.payment_status}
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
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/trainer/intake-requests')}>
                {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {recentRegistrations.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('dashboard.noRegistrations', 'No registrations yet')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t('players.name')}</TableHead>
                    <TableHead className="text-xs">{t('players.addedOn')}</TableHead>
                    <TableHead className="text-xs">{t('players.status')}</TableHead>
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
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/trainer/open-slots')}>
                {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {upcomingSlots.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">{t('availability.noSlots')}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t('cycles.name', 'Name')}</TableHead>
                    <TableHead className="text-xs">{t('dashboard.sessions', 'Sessions')}</TableHead>
                    <TableHead className="text-xs">{t('dashboard.nextSession', 'Next session')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcomingSlots.map((slot, idx) => (
                    <TableRow key={slot.cyclus_id || slot.id}>
                      <TableCell className="text-sm py-2">{slot.cyclus_name || '—'}</TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">
                        {slot.sessionCount} {slot.sessionCount === 1 ? t('dashboard.session', 'session') : t('dashboard.sessions', 'sessions')}
                      </TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">
                        <div>{format(new Date(slot.start_time), 'EEE dd MMM')}</div>
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
    </main>
  );
}
