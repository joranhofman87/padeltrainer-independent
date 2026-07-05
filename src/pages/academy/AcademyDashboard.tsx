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
  EyeOff,
  Receipt,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SubscriptionTrialBanner } from '@/components/ui/subscription-trial-banner';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainers, getAcademyLocations, getAcademyViewStats, getAcademyTrainersWithProfiles } from '@/lib/academy';
import { supabase } from '@/lib/supabaseClient';
import { getMarketingUrl } from '@/lib/domains';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { UnpaidBookingsCard } from '@/components/dashboard/UnpaidBookingsCard';
import { useAcademyUndeliverableRecipients } from '@/lib/emailBounce';
import { AcademyPublicLinkCard } from '@/components/academy/AcademyPublicLinkCard';
import { useQuery } from '@tanstack/react-query';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { compactDataTableClass } from '@/components/ui/data-table';
import { DashboardPageSkeleton } from '@/components/ui/dashboard-page-skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { QueryErrorState } from '@/components/ui/QueryErrorState';
import { StatTile } from '@/components/ui/stat-tile';
import { DashboardSectionHeader } from '@/components/dashboard/DashboardActivityList';

const DASHBOARD_STALE_TIME = 5 * 60 * 1000; // 5 minutes

export default function AcademyDashboard() {
  const { t, i18n } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  useTranslation('cycles'); // keep hook call: loads the 'cycles' i18n namespace
  const navigate = useNavigate();
  const { activeAcademy, isTrialing, trialDaysRemaining, subscription } = useAcademyContext();

  const academyId = activeAcademy?.id;

  // Players whose email is bouncing — reminders aren't reaching them.
  const { data: undeliverableRecipients = [] } = useAcademyUndeliverableRecipients(academyId);

  // Stats query
  const { data: stats = { trainers: 0, locations: 0, viewsLast30Days: 0, outstandingInvoices: 0 }, isLoading: statsLoading, isError: statsError, refetch: refetchStats } = useQuery({
    queryKey: ['academy-stats', academyId],
    queryFn: async () => {
      const [trainersData, locationsData, viewStats, invoicesRes] = await Promise.all([
        getAcademyTrainers(academyId!),
        getAcademyLocations(academyId!),
        getAcademyViewStats(academyId!),
        supabase
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('academy_profile_id', academyId!)
          .in('status', ['sent', 'overdue']),
      ]);
      return {
        trainers: trainersData.length,
        locations: locationsData.length,
        viewsLast30Days: viewStats.last30Days,
        outstandingInvoices: invoicesRes.count ?? 0,
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
  const { data: activity, isLoading: activityLoading, isError: activityError, refetch: refetchActivity } = useQuery({
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
          cycles!inner (owner_id, owner_type, name, locations:location_id (name))
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
              player_id, guest_player_id,
              profiles:player_id (full_name),
              guest_players:guest_player_id (full_name),
              availability_slots!inner (trainer_id, start_time, cyclus_name, cyclus_id)
            `)
            .in('availability_slots.trainer_id', trainerIds)
            .order('created_at', { ascending: false })
            .limit(40),
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
            .select('id, start_time, end_time, max_participants, cyclus_name, cyclus_id, locations:location_id (name)')
            .in('trainer_id', trainerIds)
            .eq('is_public', true)
            .gte('start_time', now)
            .order('start_time', { ascending: true })
            .limit(50),
        ]);

        // Process bookings - group by cyclus + player (fall back to cyclus_id when name missing)
        const rawBookings = bookingsRes.data || [];
        const groupedBookings: any[] = [];
        const cyclusPlayerMap = new Map<string, any>();
        for (const b of rawBookings) {
          const slot = (b as any).availability_slots;
          const cyclusKey = slot?.cyclus_name || slot?.cyclus_id || 'no-cyclus';
          const playerId = (b as any).player_id || (b as any).guest_player_id || '';
          if (playerId) {
            const key = `${cyclusKey}::${playerId}`;
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
        recentBookings = groupedBookings.slice(0, 10);

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

  if (!activeAcademy || statsLoading || activityLoading) {
    return (
      <AppPage>
        <DashboardPageSkeleton />
      </AppPage>
    );
  }

  // A failed fetch must never render as "0 trainers / no players" — that reads
  // as deleted data and invites duplicate entry.
  if (statsError || activityError) {
    return (
      <AppPage>
        <PageHeader
          title={activeAcademy?.name ?? t('dashboard.title')}
          description={t('dashboard.overview')}
        />
        <QueryErrorState
          onRetry={() => {
            if (statsError) refetchStats();
            if (activityError) refetchActivity();
          }}
        />
      </AppPage>
    );
  }

  return (
    <AppPage>
      <PageHeader
        title={activeAcademy?.name ?? t('dashboard.title')}
        description={t('dashboard.overview')}
      />

      {activeAcademy?.slug && (
        <AcademyPublicLinkCard academy={activeAcademy} lang={i18n.language} />
      )}

      {/* Trial Banner */}
      {isTrialing && trialDaysRemaining > 0 && (
        <SubscriptionTrialBanner
          expired={false}
          title={t('subscription.trialActive')}
          message={t('subscription.trialDaysRemaining', { days: trialDaysRemaining })}
          ctaLabel={t('subscription.upgradeNow')}
          onCtaClick={() => navigate('/app/academy/subscription')}
        />
      )}

      {/* Trial Expired Banner */}
      {isTrialExpired && (
        <SubscriptionTrialBanner
          expired
          title={t('subscription.trialExpired')}
          message={t('subscription.subscribeToAccess')}
          ctaLabel={t('subscription.upgradeNow')}
          onCtaClick={() => navigate('/app/academy/subscription')}
        />
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

      {/* Undeliverable email alert — reminders/invoices are bouncing for some players */}
      {undeliverableRecipients.length > 0 && (
        <Alert variant="destructive" className="mb-6">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>
            {t('emailDelivery.alertTitle', '{{count}} player(s) have an undeliverable email', { count: undeliverableRecipients.length })}
          </AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{t('emailDelivery.alertBody', "Reminders and invoices aren't reaching them. Update their email address to fix delivery.")}</span>
            <Button variant="outline" size="sm" className="shrink-0" onClick={() => navigate('/app/academy/players')}>
              {t('emailDelivery.reviewPlayers', 'Review players')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t('dashboard.overview')}>
        <StatTile
          label={t('stats.trainers')}
          value={String(stats.trainers)}
          icon={Users}
          onClick={() => navigate('/app/academy/trainers')}
        />
        <StatTile
          label={t('stats.locations')}
          value={String(stats.locations)}
          icon={MapPin}
          onClick={() => navigate('/app/academy/locations')}
        />
        <StatTile
          label={t('stats.outstandingInvoices', 'Outstanding invoices')}
          value={String(stats.outstandingInvoices)}
          icon={Receipt}
          highlight={stats.outstandingInvoices > 0}
          onClick={() => navigate('/app/academy/invoices?status=outstanding')}
        />
        <StatTile
          label={t('stats.profileViews')}
          value={String(stats.viewsLast30Days)}
          icon={Eye}
          onClick={() => {
            const lang = i18n.language || 'nl';
            window.open(getMarketingUrl(`academies/${activeAcademy?.slug}`, lang) + '?preview=true', '_blank');
          }}
        />
      </section>

      {/* Unpaid Bookings */}
      {activeAcademy && (
        <UnpaidBookingsCard academyId={activeAcademy.id} />
      )}

      {/* Activity Sections */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card className={flushOnMobileCardClass("overflow-hidden border-border/80 shadow-sm")}>
          <DashboardSectionHeader
            title={t('dashboard.recentPlayers', 'Recent Players')}
            viewAllLabel={t('dashboard.viewAll', 'View all')}
            onViewAll={() => navigate('/app/academy/players')}
          />
          {recentPlayers.length === 0 ? (
            <EmptyState
              icon={Users}
              title={t('dashboard.noData', 'No data yet')}
              description={t('dashboard.emptyPlayersHint', 'Players appear here once they join your academy.')}
              action={
                <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/players')}>
                  {t('dashboard.emptyPlayersAction', 'Add your first player')}
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              }
              className="py-6"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table className={compactDataTableClass}>
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
                      <TableCell className="truncate">{player.full_name}</TableCell>
                      <TableCell className="text-muted-foreground">{format(new Date(player.created_at), 'dd MMM')}</TableCell>
                      <TableCell>
                        <Badge variant={player.has_trained ? 'success' : 'muted'} className="text-xs">
                          {player.has_trained ? tTrainer('players.statuses.active') : tTrainer('players.statuses.prospect')}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>

        <Card className={flushOnMobileCardClass("overflow-hidden border-border/80 shadow-sm")}>
          <DashboardSectionHeader
            title={t('dashboard.recentBookings', 'Recent Bookings')}
            viewAllLabel={t('dashboard.viewAll', 'View all')}
            onViewAll={() => navigate('/app/academy/calendar')}
          />
          {recentBookings.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title={t('dashboard.noData', 'No data yet')}
              description={t('dashboard.emptyBookingsHint', 'Bookings appear once your trainers have open slots.')}
              action={
                <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/calendar')}>
                  {t('dashboard.emptyBookingsAction', 'Open the calendar')}
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              }
              className="py-6"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table className={compactDataTableClass}>
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
                          <Badge variant={booking.payment_status === 'paid' ? 'success' : 'warning'} className="text-xs">
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
            </div>
          )}
        </Card>

        <Card className={flushOnMobileCardClass("overflow-hidden border-border/80 shadow-sm")}>
          <DashboardSectionHeader
            title={t('dashboard.registrations', 'Registrations')}
            viewAllLabel={t('dashboard.viewAll', 'View all')}
            onViewAll={() => navigate('/app/academy/intake-requests')}
          />
          {recentRegistrations.length === 0 ? (
            <EmptyState
              icon={Users}
              title={t('dashboard.noData', 'No data yet')}
              description={t('dashboard.emptyRegistrationsHint', 'Registrations appear once players sign up for a cycle.')}
              action={
                <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/registrations')}>
                  {t('dashboard.emptyRegistrationsAction', 'Create a registration')}
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              }
              className="py-6"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table className={compactDataTableClass}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{tTrainer('players.name')}</TableHead>
                    <TableHead className="text-xs">{tTrainer('players.addedOn')}</TableHead>
                    <TableHead className="text-xs">{t('locations.title', 'Location')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRegistrations.map(reg => {
                    const locationName = (reg.cycles as any)?.locations?.name;
                    return (
                    <TableRow key={reg.id}>
                      <TableCell className="text-sm py-2">{reg.full_name}</TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">{format(new Date(reg.created_at), 'dd MMM', { locale: i18n.language === 'nl' ? nl : enUS })}</TableCell>
                      <TableCell className="text-sm py-2 text-muted-foreground">{locationName || '—'}</TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>

        <Card className={flushOnMobileCardClass("overflow-hidden border-border/80 shadow-sm")}>
          <DashboardSectionHeader
            title={t('dashboard.upcomingSpots', 'Upcoming Open Spots')}
            viewAllLabel={t('dashboard.viewAll', 'View all')}
            onViewAll={() => navigate('/app/academy/calendar?tab=cycles')}
          />
          {upcomingSlots.length === 0 ? (
            <EmptyState
              icon={Clock}
              title={t('dashboard.noData', 'No data yet')}
              description={t('dashboard.emptySpotsHint', 'Open spots appear once cycles with free places are planned.')}
              action={
                <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/calendar')}>
                  {t('dashboard.emptySpotsAction', 'Plan open spots')}
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              }
              className="py-6"
            />
          ) : (
            <div className="overflow-x-auto">
              <Table className={compactDataTableClass}>
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
                        <div>{format(new Date(slot.start_time), 'EEEEEE dd MMM', { locale: i18n.language === 'nl' ? nl : enUS })}</div>
                        <div className="text-xs">{format(new Date(slot.start_time), 'HH:mm')}</div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      {/* Trainers Section */}
      {activeTrainers.length > 0 && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">{t('trainers.title')}</h2>
            <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/trainers')}>
              {t('dashboard.viewAll', 'View all')} <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeTrainers.map((trainer: any) => {
              const profile = trainer.profile;
              const tp = trainer.trainer_profile;
              const initials = (profile?.full_name || '?').split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();

              return (
                <Card key={trainer.id} className="flex items-start gap-3 p-4">
                  <Avatar className="h-10 w-10 shrink-0">
                    {profile?.avatar_url && <AvatarImage src={profile.avatar_url} alt={profile?.full_name || ''} />}
                    <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm truncate">{profile?.full_name || '—'}</span>
                      {trainer.show_on_academy_page ? (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                          <Eye className="h-3 w-3 mr-0.5" /> {t('trainers.visible', 'Visible')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                          <EyeOff className="h-3 w-3 mr-0.5" /> {t('trainers.hidden', 'Hidden')}
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 mb-1">
                      {(tp?.specializations || []).slice(0, 2).map((s: string) => (
                        <Badge key={s} variant="secondary" className="text-[10px]">{s}</Badge>
                      ))}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {tp?.hourly_rate != null && <span>€{tp.hourly_rate}/h</span>}
                      {tp?.experience_years != null && <span>{tp.experience_years} {t('trainers.yearsExp', 'yr exp')}</span>}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </AppPage>
  );
}
