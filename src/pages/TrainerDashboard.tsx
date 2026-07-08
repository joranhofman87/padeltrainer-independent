import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import {
  Users,
  Banknote,
  Clock,
  Eye,
  CalendarDays,
  ClipboardList,
  Plus,
  UserPlus,
  Wallet,
  BarChart3,
  Settings as SettingsIcon,
} from 'lucide-react';
import { AppPage } from '@/components/ui/app-page';
import { DashboardPageSkeleton } from '@/components/ui/dashboard-page-skeleton';
import { TrainerPageHeader } from '@/components/trainer/shell/TrainerPageHeader';
import { supabase } from '@/lib/supabaseClient';
import { sumReceivedInRange } from '@/lib/trainerEarnings';
import { startOfMonth, endOfMonth } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { TrainerTrialBanner } from '@/components/trainer/TrainerTrialBanner';
import { getTrainerShortUrl } from '@/lib/domains';
import { formatCurrency } from '@/lib/format';
import { PendingAttendanceCard } from '@/components/dashboard/PendingAttendanceCard';
import { getTrainerAcademy } from '@/lib/academy';
import { useQuery } from '@tanstack/react-query';
import { StatTile } from '@/components/ui/stat-tile';
import { KpiTile } from '@/components/dashboard/KpiTile';
import { MoneyChart } from '@/components/dashboard/charts/MoneyChart';
import { NewPlayersChart } from '@/components/dashboard/charts/NewPlayersChart';
import { DashboardQuickNav, type QuickNavItem } from '@/components/dashboard/DashboardQuickNav';
import { fetchTrainerAnalytics } from '@/lib/dashboardAnalytics';
import { DashboardSetupBanner } from '@/components/trainer/dashboard/DashboardSetupBanner';
import { computeTrainerPaymentsSetupComplete } from '@/lib/trainerSetupPlan';
import { getAcademyPaymentInfo } from '@/lib/academyTrainerPayments';
import {
  fetchRemovedPlayerKeys,
  filterGuestRowsByRemoval,
} from '@/lib/playerRemovalVisibility';
import { fetchPlayersOverview } from '@/lib/playersOverview';

interface DashboardStats {
  totalStudents: number;
  openSlots: number;
  monthlyEarnings: number;
  followerCount: number;
  profileViews: number;
}

export interface TrainerDashboardSetupFields {
  fullName: string | null;
  bio: string | null;
  hourlyRate: number | null;
  isPublic: boolean;
  slug: string | null;
}

async function fetchTrainerStats(userId: string): Promise<{
  stats: DashboardStats;
  trainerId: string;
  slug: string | null;
  setupFields: TrainerDashboardSetupFields;
  paymentsComplete: boolean;
} | null> {
  const { data: trainerProfile } = await supabase
    .from('trainer_profiles')
    .select('id, slug, hourly_rate, is_public, use_manual_invoicing')
    .eq('user_id', userId)
    .maybeSingle();

  if (!trainerProfile) return null;

  const currentTrainerId = trainerProfile.id;
  const now = new Date();
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);

  const [
    profileResult,
    activeStudentCount,
    futureSlots,
    monthlyBookings,
    followerResult,
    viewsResult,
    mollieResult,
    academyPaymentInfo,
  ] = await Promise.all([
    supabase.from('profiles').select('full_name, bio').eq('user_id', userId).maybeSingle(),
    // Total students must match the Players page header: the get_players_overview
    // total (guests + registered), not a guests-only count.
    fetchPlayersOverview({ kind: 'trainer', id: currentTrainerId }, { pageSize: 1 }).then((r) => r.total),
    supabase.from('availability_slots')
      .select('id, max_participants, bookings(id, status)')
      .eq('trainer_id', currentTrainerId)
      .eq('is_public', true)
      .gte('start_time', now.toISOString()),
    supabase.from('bookings')
      .select('payment_amount, paid_at, payment_status, availability_slots!inner(trainer_id, price_per_session)')
      .eq('availability_slots.trainer_id', currentTrainerId)
      .eq('payment_status', 'paid')
      .gte('paid_at', monthStart.toISOString())
      .lte('paid_at', monthEnd.toISOString()),
    supabase.from('trainer_followers').select('id', { count: 'exact', head: true }).eq('trainer_id', currentTrainerId),
    (() => {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return supabase.from('trainer_profile_views')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId)
        .gte('viewed_at', thirtyDaysAgo.toISOString());
    })(),
    supabase
      .from('trainer_mollie_accounts')
      .select('onboarding_complete, charges_enabled')
      .eq('trainer_id', currentTrainerId)
      .maybeSingle(),
    getAcademyPaymentInfo(currentTrainerId),
  ]);

  const paymentsComplete = computeTrainerPaymentsSetupComplete({
    useManualInvoicing: !!trainerProfile.use_manual_invoicing,
    mollieOnboardingComplete: !!mollieResult.data?.onboarding_complete,
    mollieChargesEnabled: !!mollieResult.data?.charges_enabled,
    academyChargesEnabled: !!academyPaymentInfo.academyChargesEnabled,
  });

  const slug = (trainerProfile as { slug?: string | null }).slug ?? null;

  let openSlotsCount = 0;
  futureSlots.data?.forEach(slot => {
    const maxParticipants = slot.max_participants || 4;
    const confirmedBookings = slot.bookings?.filter((b: { status: string }) => b.status === 'confirmed').length || 0;
    if (confirmedBookings < maxParticipants) openSlotsCount++;
  });

  // Money actually received this month — same rule the Earnings page uses
  // (sumReceivedInRange), no platform fee.
  const totalEarnings = sumReceivedInRange(monthlyBookings.data ?? [], monthStart, monthEnd);

  return {
    trainerId: currentTrainerId,
    slug,
    setupFields: {
      fullName: profileResult.data?.full_name ?? null,
      bio: profileResult.data?.bio ?? null,
      hourlyRate: trainerProfile.hourly_rate ?? null,
      isPublic: !!trainerProfile.is_public,
      slug,
    },
    stats: {
      totalStudents: activeStudentCount,
      openSlots: openSlotsCount,
      monthlyEarnings: totalEarnings,
      followerCount: followerResult.count || 0,
      profileViews: viewsResult.count || 0,
    },
    paymentsComplete,
  };
}

async function fetchTrainerActivity(trainerId: string) {
  const now = new Date().toISOString();

  const [guestPlayersRaw, registeredBookings, bookings, registrations, slots] = await Promise.all([
    supabase.from('guest_players')
      .select('id, full_name, email, skill_rating, rating_system, has_trained, created_at')
      .eq('trainer_id', trainerId)
      .order('created_at', { ascending: false })
      .limit(10)
      .then(r => r.data),
    supabase.from('bookings')
      .select('id, created_at, player_id, profiles:player_id (id, full_name), availability_slots!inner (trainer_id)')
      .eq('availability_slots.trainer_id', trainerId)
      .not('player_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(r => r.data),
    supabase.from('bookings')
      .select('id, status, payment_status, created_at, player_id, guest_player_id, profiles:player_id (full_name), guest_players:guest_player_id (full_name), availability_slots!inner (trainer_id, start_time, cyclus_name)')
      .eq('availability_slots.trainer_id', trainerId)
      .order('created_at', { ascending: false })
      .limit(50)
      .then(r => r.data),
    supabase.from('intake_requests')
      .select('id, full_name, status, created_at, cycles!inner (owner_id, name)')
      .eq('cycles.owner_id', trainerId)
      .order('created_at', { ascending: false })
      .limit(10)
      .then(r => r.data),
    supabase.from('availability_slots')
      .select('id, start_time, end_time, max_participants, cyclus_name, cyclus_id, locations:location_id (name)')
      .eq('trainer_id', trainerId)
      .eq('is_public', true)
      .gte('start_time', now)
      .order('start_time', { ascending: true })
      .limit(50)
      .then(r => r.data),
  ]);

  const removedKeys = await fetchRemovedPlayerKeys({ kind: 'trainer', trainerProfileId: trainerId });
  const guestPlayers = filterGuestRowsByRemoval(guestPlayersRaw || [], removedKeys);

  const seenPlayerIds = new Set<string>();
  const regPlayers: any[] = [];
  for (const b of registeredBookings || []) {
    const profile = b.profiles as any;
    if (profile?.id && !seenPlayerIds.has(profile.id) && !removedKeys.profileIds.has(profile.id)) {
      seenPlayerIds.add(profile.id);
      regPlayers.push({ id: profile.id, full_name: profile.full_name || '—', has_trained: true, created_at: b.created_at, _isRegistered: true });
    }
  }
  const allPlayers = [...guestPlayers, ...regPlayers]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10);

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

  return {
    recentPlayers: allPlayers,
    recentBookings: groupedBookings.slice(0, 10),
    recentRegistrations: registrations || [],
    upcomingSlots: grouped,
  };
}

export default function TrainerDashboard() {
  const { user, profile, role, loading, subscription } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['trainer-stats', user?.id],
    queryFn: () => fetchTrainerStats(user!.id),
    enabled: !!user && role === 'trainer',
    staleTime: 60_000,
  });

  const trainerId = statsData?.trainerId ?? null;
  const trainerSlug = statsData?.slug ?? null;
  const stats = statsData?.stats ?? { totalStudents: 0, openSlots: 0, monthlyEarnings: 0, followerCount: 0, profileViews: 0 };

  const { data: hasAcademy = false } = useQuery({
    queryKey: ['trainer-has-academy', trainerId],
    queryFn: async () => {
      const academy = await getTrainerAcademy(trainerId!);
      return !!academy;
    },
    enabled: !!trainerId,
    staleTime: 5 * 60 * 1000,
  });

  // Monthly money + new-players series + KPI deltas (caller-scoped RPC).
  const { data: analytics, isLoading: analyticsLoading } = useQuery({
    queryKey: ['trainer-analytics', trainerId],
    queryFn: () => fetchTrainerAnalytics(12),
    enabled: !!trainerId && role === 'trainer',
    staleTime: 60_000,
  });

  const kpis = analytics?.kpis;
  const monthly = analytics?.monthly ?? [];

  // The activity query still feeds the setup banner counts + the pending-registrations
  // action banner (the duplicative preview tables it used to render are gone).
  const { data: activityData } = useQuery({
    queryKey: ['trainer-activity', trainerId],
    queryFn: () => fetchTrainerActivity(trainerId!),
    enabled: !!trainerId,
    staleTime: 60_000,
  });

  const recentBookings = activityData?.recentBookings ?? [];
  const recentRegistrations = activityData?.recentRegistrations ?? [];
  const upcomingSlots = activityData?.upcomingSlots ?? [];

  const firstName = profile?.full_name?.split(' ')[0];
  const dashboardTitle = firstName
    ? t('dashboard.greeting', { name: firstName })
    : t('nav.dashboard');

  const pendingRegistrations = recentRegistrations.filter((r) => r.status !== 'confirmed');

  const quickNav: QuickNavItem[] = [
    { label: t('nav.players'), to: '/app/trainer/players', icon: Users },
    { label: t('nav.agenda'), to: '/app/trainer/agenda', icon: CalendarDays },
    { label: t('nav.openSlots'), to: '/app/trainer/open-slots', icon: Clock },
    { label: t('nav.registrations'), to: '/app/trainer/intake-requests', icon: ClipboardList },
    { label: t('nav.earnings'), to: '/app/trainer/earnings', icon: Banknote },
    { label: t('nav.expenses'), to: '/app/trainer/expenses', icon: Wallet },
    { label: t('nav.analytics'), to: '/app/trainer/analytics', icon: BarChart3 },
    { label: t('nav.settings'), to: '/app/trainer/settings', icon: SettingsIcon },
  ];

  if (loading) {
    return (
      <AppPage data-testid="page-trainer-dashboard">
        <DashboardPageSkeleton />
      </AppPage>
    );
  }

  return (
    <AppPage className="space-y-6" data-testid="page-trainer-dashboard">
      <TrainerPageHeader
        title={dashboardTitle}
        description={t('dashboard.subtitleShort')}
        primaryAction={{
          label: t('dashboard.addSlot'),
          onClick: () => navigate('/app/trainer/slot/new'),
          icon: Plus,
        }}
      />

      {subscription && !subscription.isSubscribed && !hasAcademy && (
        <TrainerTrialBanner
          trialEndsAt={subscription.trialEndsAt}
          onUpgrade={() => navigate('/app/trainer/subscription')}
        />
      )}

      <PendingAttendanceCard mode="trainer" trainerId={trainerId ?? undefined} />

      <DashboardSetupBanner
        setupFields={
          statsData?.setupFields ?? {
            fullName: profile?.full_name ?? null,
            bio: profile?.bio ?? null,
            hourlyRate: null,
            isPublic: false,
            slug: trainerSlug,
          }
        }
        shortUrl={trainerSlug ? getTrainerShortUrl(trainerSlug) : null}
        stats={{ openSlots: stats.openSlots, totalStudents: stats.totalStudents }}
        upcomingSlotsCount={upcomingSlots.length}
        recentBookingsCount={recentBookings.length}
        showPaymentsStep={!hasAcademy}
        paymentsComplete={statsData?.paymentsComplete ?? false}
      />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t('nav.dashboard')}>
        <KpiTile
          label={t('dashboard.stats.revenue')}
          value={formatCurrency(kpis?.revenue_this_month ?? 0)}
          current={kpis?.revenue_this_month ?? 0}
          previous={kpis?.revenue_last_month ?? 0}
          icon={Banknote}
          loading={analyticsLoading}
          onClick={() => navigate('/app/trainer/earnings')}
        />
        <KpiTile
          label={t('dashboard.stats.totalStudents')}
          value={String(kpis?.new_players_this_month ?? 0)}
          current={kpis?.new_players_this_month ?? 0}
          previous={kpis?.new_players_last_month ?? 0}
          icon={Users}
          loading={analyticsLoading}
          onClick={() => navigate('/app/trainer/players')}
        />
        <StatTile
          label={t('dashboard.stats.openSlots')}
          value={String(stats.openSlots)}
          icon={Clock}
          loading={statsLoading}
          highlight
          onClick={() => navigate('/app/trainer/open-slots')}
        />
        <StatTile
          label={t('dashboard.stats.profileViews')}
          value={String(stats.profileViews)}
          icon={Eye}
          loading={statsLoading}
          onClick={() => navigate('/app/trainer/analytics')}
        />
      </section>

      {/* Analytics charts */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <MoneyChart data={monthly} />
        <NewPlayersChart data={monthly} />
      </div>

      {pendingRegistrations.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-[hsl(var(--brand-200))] bg-[hsl(var(--brand-50))]/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--brand-100))]">
              <UserPlus className="h-4 w-4 text-[hsl(var(--brand-600))]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[hsl(var(--navy-900))]">
                {t('dashboard.newRegistrations', { count: pendingRegistrations.length })}
              </p>
              <p className="text-xs text-muted-foreground">{t('dashboard.registrations')}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-[hsl(var(--brand-300))] bg-background"
            onClick={() => navigate('/app/trainer/intake-requests')}
          >
            {t('dashboard.reviewRegistrations')}
          </Button>
        </div>
      )}

      {/* Quick navigation — replaces the old duplicative preview tables */}
      <div>
        <h2 className="mb-3 text-base font-semibold">{t('dashboard.quickNavTitle', 'Quick navigation')}</h2>
        <DashboardQuickNav items={quickNav} />
      </div>
    </AppPage>
  );
}
