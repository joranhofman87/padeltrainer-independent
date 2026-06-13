import { useNavigate } from 'react-router-dom';
import { getMarketingPath } from '@/lib/domains';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Search, Calendar, User, ChevronRight, Clock, Users, ArrowRight, Building2, FileText } from 'lucide-react';
import { AppPage, surfaceCardClass } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { BookingStatusBadge } from '@/components/player/BookingStatusBadge';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabaseClient';
import { format, isAfter } from 'date-fns';
import { fetchPlayerBookings } from '@/lib/playerBookings';
import { RatingHistoryChart } from '@/components/player/RatingHistoryChart';
import { MyWaitingListEntries } from '@/components/waitingList';
import { PendingAttendanceCard } from '@/components/dashboard/PendingAttendanceCard';
import { PlayerRebookCard } from '@/components/dashboard/PlayerRebookCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

interface FollowedTrainer {
  id: string;
  trainer_id: string;
  trainer_slug: string | null;
  full_name: string | null;
  avatar_url: string | null;
}

interface UpcomingBooking {
  id: string;
  sessionTitle: string;
  trainerName: string;
  startTime: Date;
  location: string | null;
  status: string;
}

const DASHBOARD_BOOKING_LIMIT = 10;

interface FollowedTrainerSlot {
  id: string;
  type: 'slot' | 'cycle';
  cyclusName: string | null;
  trainerName: string;
  trainerSlug: string | null;
  startTime: Date;
  location: string | null;
  sessionCount?: number;
  cyclusId?: string | null;
}

interface PlayerClub {
  id: string;
  clubProfileId: string;
  locationName: string;
  locationSlug: string;
  logoUrl: string | null;
}

// --- Query functions ---

/**
 * Upcoming bookings for the dashboard table. Routes through the shared
 * fetchPlayerBookings so payment-status/confirmed overrides match the bookings
 * page exactly, then keeps only active, future sessions (newest-first, capped).
 */
async function fetchUpcomingBookings(profileId: string): Promise<UpcomingBooking[]> {
  const now = new Date();
  const bookings = await fetchPlayerBookings(profileId);

  return bookings
    .filter((b) => ['confirmed', 'pending', 'pending_approval'].includes(b.status))
    .filter((b) => b.start_time && isAfter(new Date(b.start_time), now))
    .slice(0, DASHBOARD_BOOKING_LIMIT)
    .map((b) => ({
      id: b.id,
      sessionTitle: b.cyclus_name || 'Training Session',
      trainerName: b.trainer_name,
      startTime: new Date(b.start_time!),
      location: b.location_name,
      status: b.status,
    }));
}

async function fetchFollowedTrainersData(profileId: string): Promise<{
  trainers: FollowedTrainer[];
  slots: FollowedTrainerSlot[];
}> {
  const { data: follows } = await supabase
    .from('trainer_followers')
    .select('id, trainer_id')
    .eq('player_id', profileId)
    .limit(10);

  if (!follows || follows.length === 0) return { trainers: [], slots: [] };

  const trainerIds = follows.map(f => f.trainer_id);
  const { data: trainers } = await supabase
    .from('trainer_profiles')
    .select('id, user_id, slug')
    .in('id', trainerIds);

  if (!trainers) return { trainers: [], slots: [] };

  const userIds = trainers.map(t => t.user_id);
  const { data: profiles } = await supabase
    .from('profiles_public')
    .select('user_id, full_name, avatar_url')
    .in('user_id', userIds);

  const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);
  const trainerMap = new Map(trainers.map(t => [t.id, t]));

  const enrichedTrainers: FollowedTrainer[] = follows.map(f => {
    const trainer = trainerMap.get(f.trainer_id);
    const p = trainer ? profileMap.get(trainer.user_id) : null;
    return {
      id: f.id,
      trainer_id: trainer?.id || '',
      trainer_slug: trainer?.slug || null,
      full_name: p?.full_name || null,
      avatar_url: p?.avatar_url || null,
    };
  });

  // Fetch open slots
  const now = new Date().toISOString();
  const { data: slotsData } = await supabase
    .from('availability_slots')
    .select('id, cyclus_name, cyclus_id, allow_single_booking, trainer_id, start_time, location_id, locations(name)')
    .in('trainer_id', trainerIds)
    .eq('is_public', true)
    
    .gte('start_time', now)
    .order('start_time', { ascending: true })
    .limit(50);

  const slots = slotsData || [];
  const trainerSlugMap = new Map(trainers.map(t => [t.id, t]));
  const cycleGroups = new Map<string, typeof slots>();
  const individualSlots: typeof slots = [];

  for (const slot of slots) {
    if (slot.cyclus_id && !slot.allow_single_booking) {
      const group = cycleGroups.get(slot.cyclus_id) || [];
      group.push(slot);
      cycleGroups.set(slot.cyclus_id, group);
    } else {
      individualSlots.push(slot);
    }
  }

  const enrichedSlots: FollowedTrainerSlot[] = [];

  for (const [cyclusId, groupSlots] of cycleGroups) {
    const first = groupSlots[0];
    const trainer = trainerSlugMap.get(first.trainer_id);
    const p = trainer ? profileMap.get(trainer.user_id) : null;
    enrichedSlots.push({
      id: first.id,
      type: 'cycle',
      cyclusName: first.cyclus_name,
      trainerName: p?.full_name || 'Trainer',
      trainerSlug: trainer?.slug || null,
      startTime: new Date(first.start_time),
      location: (first.locations as any)?.name || null,
      sessionCount: groupSlots.length,
      cyclusId,
    });
  }

  for (const slot of individualSlots) {
    const trainer = trainerSlugMap.get(slot.trainer_id);
    const p = trainer ? profileMap.get(trainer.user_id) : null;
    enrichedSlots.push({
      id: slot.id,
      type: 'slot',
      cyclusName: slot.cyclus_name,
      trainerName: p?.full_name || 'Trainer',
      trainerSlug: trainer?.slug || null,
      startTime: new Date(slot.start_time),
      location: (slot.locations as any)?.name || null,
    });
  }

  enrichedSlots.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  return { trainers: enrichedTrainers, slots: enrichedSlots.slice(0, 10) };
}

async function fetchPlayerClubsData(profileId: string): Promise<PlayerClub[]> {
  const { data: follows } = await supabase
    .from('club_followers')
    .select('id, club_profile_id, club_profiles(id, location_id, logo_url, locations(name, slug))')
    .eq('player_id', profileId)
    .limit(10);

  if (!follows || follows.length === 0) return [];

  return follows.map(f => {
    const cp = f.club_profiles as any;
    const loc = cp?.locations;
    return {
      id: f.id,
      clubProfileId: f.club_profile_id,
      locationName: loc?.name || 'Club',
      locationSlug: loc?.slug || '',
      logoUrl: cp?.logo_url || null,
    };
  });
}

// --- Component ---

export default function PlayerDashboard() {
  const { profile, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('player');
  const profileId = profile?.id;

  const { data: upcomingBookings = [], isLoading: statsLoading } = useQuery({
    queryKey: ['player-bookings', profileId],
    queryFn: () => fetchUpcomingBookings(profileId!),
    enabled: !!profileId,
    staleTime: 60_000,
  });

  const { data: followedData, isLoading: followingLoading } = useQuery({
    queryKey: ['player-followed-trainers', profileId],
    queryFn: () => fetchFollowedTrainersData(profileId!),
    enabled: !!profileId,
    staleTime: 60_000,
  });

  const followedTrainers = followedData?.trainers ?? [];
  const followedTrainerSlots = followedData?.slots ?? [];
  const slotsLoading = followingLoading;

  const { data: playerClubs = [], isLoading: clubsLoading } = useQuery({
    queryKey: ['player-clubs', profileId],
    queryFn: () => fetchPlayerClubsData(profileId!),
    enabled: !!profileId,
    staleTime: 60_000,
  });

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
      </div>
    );
  }

  const quickActionCardClass = cn(
    surfaceCardClass(),
    'cursor-pointer transition-colors hover:bg-muted/30',
  );

  return (
    <AppPage as="main" data-testid="page-player-dashboard">
      <PageHeader
        title={t('dashboard.welcome', { name: profile?.full_name?.split(' ')[0] || 'Player' })}
        description={t('dashboard.subtitle')}
      />

      <PlayerRebookCard profileId={profileId ?? undefined} />

      <PendingAttendanceCard mode="player" profileId={profileId ?? undefined} />

      {profile?.id && (
        <RatingHistoryChart
          profileId={profile.id}
          currentRating={profile.skill_rating ?? null}
          ratingSystem={(profile as any)?.rating_system || 'knltb'}
          playerName={profile.full_name || ''}
        />
      )}

      {/* Primary shortcuts: bookings + invoices */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card
          className={quickActionCardClass}
          data-testid="dashboard-shortcut-bookings"
          onClick={() => navigate('/app/player/bookings')}
        >
          <CardContent className="flex items-center justify-between p-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="rounded-lg bg-green-500/10 p-2.5">
                <Calendar className="h-5 w-5 text-green-600" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">{t('dashboard.quickActions.myBookings.title')}</p>
                <p className="text-sm text-muted-foreground">{t('dashboard.viewSchedule')}</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </CardContent>
        </Card>

        <Card
          className={quickActionCardClass}
          data-testid="dashboard-shortcut-invoices"
          onClick={() => navigate('/app/player/invoices')}
        >
          <CardContent className="flex items-center justify-between p-5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="rounded-lg bg-blue-500/10 p-2.5">
                <FileText className="h-5 w-5 text-blue-600" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">{t('nav.invoices', 'Invoices')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('invoices.description', 'View and download invoices for your training sessions.')}
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card
          className={quickActionCardClass}
          onClick={() => navigate(getMarketingPath('trainers'))}
        >
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="rounded-lg bg-primary/10 p-2">
                <Search className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">{t('dashboard.quickActions.findTrainers.title')}</p>
                <p className="text-sm text-muted-foreground">{t('dashboard.browseAvailableTrainers')}</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </CardContent>
        </Card>

        <Card className={quickActionCardClass} onClick={() => navigate('/app/player/profile')}>
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="rounded-lg bg-orange-500/10 p-2">
                <User className="h-5 w-5 text-orange-600" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold">{t('dashboard.myProfile.title')}</p>
                <p className="text-sm text-muted-foreground">{t('dashboard.myProfile.description')}</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card className={surfaceCardClass()}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Calendar className="h-5 w-5 text-primary" />
                {t('dashboard.upcomingBookings')}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate('/app/player/bookings')} className="gap-1">
                {t('dashboard.viewAll')} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0">
            {statsLoading ? (
              <div className="flex justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            ) : upcomingBookings.length === 0 ? (
              <EmptyState icon={Calendar} title={t('dashboard.noUpcomingBookings')} />
            ) : (
              <div className="overflow-x-auto -mx-1">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('dashboard.tableSession')}</TableHead>
                    <TableHead>{t('dashboard.tableDate')}</TableHead>
                    <TableHead>{t('dashboard.tableStatus')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {upcomingBookings.map((booking) => (
                    <TableRow key={booking.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium truncate">{booking.sessionTitle}</p>
                          <p className="text-xs text-muted-foreground">{booking.trainerName}</p>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div>
                          <p className="text-sm">{format(booking.startTime, 'EEE, MMM d')}</p>
                          <p className="text-xs text-muted-foreground">{format(booking.startTime, 'HH:mm')}</p>
                        </div>
                      </TableCell>
                      <TableCell><BookingStatusBadge status={booking.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={surfaceCardClass()}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                {t('dashboard.followedTrainers')}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate(getMarketingPath('trainers'))} className="gap-1">
                {t('dashboard.allTrainers')} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0">
            {followingLoading ? (
              <div className="flex justify-center py-8">
                <div className="h-5 w-5 animate-spin rounded-full border-b-2 border-primary" />
              </div>
            ) : followedTrainers.length === 0 ? (
              <EmptyState icon={Users} title={t('dashboard.notFollowingYet')} />
            ) : (
              <div className="overflow-x-auto -mx-1">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('dashboard.tableTrainer')}</TableHead>
                    <TableHead className="text-right">{t('dashboard.tableProfile')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {followedTrainers.map((trainer) => (
                    <TableRow key={trainer.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7">
                            <AvatarImage src={trainer.avatar_url || undefined} />
                            <AvatarFallback>{trainer.full_name?.[0] || 'T'}</AvatarFallback>
                          </Avatar>
                          <span className="font-medium text-sm">{trainer.full_name || 'Trainer'}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('dashboard.viewTrainer', 'View trainer')}
                          onClick={() => navigate(getMarketingPath(`trainer/${trainer.trainer_slug || trainer.trainer_id}`))}
                        >
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={surfaceCardClass()}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" />
                {t('dashboard.openSlots')}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate(getMarketingPath('trainers'))} className="gap-1">
                {t('dashboard.browse')} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <CardDescription>{t('dashboard.openSlotsDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {slotsLoading ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
              </div>
            ) : followedTrainerSlots.length === 0 ? (
              <EmptyState icon={Clock} title={t('dashboard.noOpenSlots')} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('dashboard.tableSession')}</TableHead>
                    <TableHead>{t('dashboard.tableDate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {followedTrainerSlots.map((slot) => (
                    <TableRow
                      key={slot.id}
                      className="cursor-pointer"
                      onClick={() => navigate(getMarketingPath(`trainer/${slot.trainerSlug || ''}`))}
                    >
                      <TableCell>
                        <div>
                          <p className="font-medium truncate">
                            {slot.cyclusName || t('dashboard.openSession')}
                            {slot.type === 'cycle' && slot.sessionCount && (
                              <span className="text-xs text-muted-foreground ml-1">· {slot.sessionCount} {t('dashboard.sessions')}</span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">{slot.trainerName}{slot.location ? ` • ${slot.location}` : ''}</p>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div>
                          <p className="text-sm">{slot.type === 'cycle' ? t('dashboard.starting', { date: format(slot.startTime, 'MMM d') }) : format(slot.startTime, 'EEE, MMM d')}</p>
                          <p className="text-xs text-muted-foreground">{format(slot.startTime, 'HH:mm')}</p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className={surfaceCardClass()}>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Building2 className="h-5 w-5 text-primary" />
                {t('dashboard.myClubs')}
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => navigate(getMarketingPath('locations'))} className="gap-1">
                {t('dashboard.allClubs')} <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {clubsLoading ? (
              <div className="flex justify-center py-6">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary" />
              </div>
            ) : playerClubs.length === 0 ? (
              <EmptyState icon={Building2} title={t('dashboard.noClubsYet')} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('dashboard.tableClub')}</TableHead>
                    <TableHead className="text-right">{t('dashboard.tableProfile')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {playerClubs.map((club) => (
                    <TableRow key={club.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7">
                            <AvatarImage src={club.logoUrl || undefined} />
                            <AvatarFallback>{club.locationName?.[0] || 'C'}</AvatarFallback>
                          </Avatar>
                          <span className="font-medium text-sm">{club.locationName}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t('dashboard.viewLocation', 'View location')}
                          onClick={() => navigate(getMarketingPath(`locations/${club.locationSlug}`))}
                        >
                          <ArrowRight className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className={surfaceCardClass()}>
          <CardContent className="p-0">
            <MyWaitingListEntries />
          </CardContent>
        </Card>

      </div>
    </AppPage>
  );
}
