import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Users,
  MapPin,
  AlertCircle,
  AlertTriangle,
  Eye,
  Receipt,
  Banknote,
  CalendarDays,
  ClipboardList,
  Wallet,
  Settings as SettingsIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SubscriptionTrialBanner } from '@/components/ui/subscription-trial-banner';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainers, getAcademyLocations, getAcademyViewStats } from '@/lib/academy';
import { supabase } from '@/lib/supabaseClient';
import { getMarketingUrl } from '@/lib/domains';
import { formatCurrency } from '@/lib/format';
import { UnpaidBookingsCard } from '@/components/dashboard/UnpaidBookingsCard';
import { useAcademyUndeliverableRecipients } from '@/lib/emailBounce';
import { AcademyPublicLinkCard } from '@/components/academy/AcademyPublicLinkCard';
import { useQuery } from '@tanstack/react-query';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { DashboardPageSkeleton } from '@/components/ui/dashboard-page-skeleton';
import { QueryErrorState } from '@/components/ui/QueryErrorState';
import { StatTile } from '@/components/ui/stat-tile';
import { KpiTile } from '@/components/dashboard/KpiTile';
import { MoneyChart } from '@/components/dashboard/charts/MoneyChart';
import { NewPlayersChart } from '@/components/dashboard/charts/NewPlayersChart';
import { DashboardQuickNav, type QuickNavItem } from '@/components/dashboard/DashboardQuickNav';
import { AcademyReportsSummaryCard } from '@/components/dashboard/AcademyReportsSummaryCard';
import { fetchAcademyAnalytics } from '@/lib/dashboardAnalytics';

const DASHBOARD_STALE_TIME = 5 * 60 * 1000; // 5 minutes

export default function AcademyDashboard() {
  const { t, i18n } = useTranslation('academy');
  const navigate = useNavigate();
  const { activeAcademy, isTrialing, trialDaysRemaining, subscription } = useAcademyContext();

  const academyId = activeAcademy?.id;

  // Players whose email is bouncing — reminders aren't reaching them.
  const { data: undeliverableRecipients = [] } = useAcademyUndeliverableRecipients(academyId);

  // Stats query — feeds the non-analytics KPI tiles (outstanding invoices, profile views).
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

  // Analytics query — monthly money + new-players series + KPI deltas (tenant-scoped RPC).
  const { data: analytics, isLoading: analyticsLoading } = useQuery({
    queryKey: ['academy-analytics', academyId],
    queryFn: () => fetchAcademyAnalytics(academyId!, 12),
    enabled: !!academyId,
    staleTime: DASHBOARD_STALE_TIME,
  });

  const kpis = analytics?.kpis;
  const monthly = analytics?.monthly ?? [];

  const isTrialExpired = subscription?.trialExpired && !subscription?.isSubscribed;

  if (!activeAcademy || statsLoading || analyticsLoading) {
    return (
      <AppPage>
        <DashboardPageSkeleton />
      </AppPage>
    );
  }

  // A failed stats fetch must never render as "0 trainers / no players" — that reads
  // as deleted data and invites duplicate entry. (Analytics failures degrade to empty
  // charts / zero KPIs rather than blocking the whole dashboard.)
  if (statsError) {
    return (
      <AppPage>
        <PageHeader
          title={activeAcademy?.name ?? t('dashboard.title')}
          description={t('dashboard.overview')}
        />
        <QueryErrorState onRetry={() => refetchStats()} />
      </AppPage>
    );
  }

  const quickNav: QuickNavItem[] = [
    { label: t('nav.players'), to: '/app/academy/players', icon: Users },
    { label: t('nav.calendar'), to: '/app/academy/calendar', icon: CalendarDays },
    { label: t('nav.registrations'), to: '/app/academy/registrations', icon: ClipboardList },
    { label: t('nav.invoices'), to: '/app/academy/invoices', icon: Receipt },
    { label: t('nav.expenses'), to: '/app/academy/expenses', icon: Wallet },
    { label: t('nav.trainers'), to: '/app/academy/trainers', icon: Users },
    { label: t('nav.locations'), to: '/app/academy/locations', icon: MapPin },
    { label: t('nav.settings'), to: '/app/academy/settings', icon: SettingsIcon },
  ];

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

      {/* KPI row */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t('dashboard.overview')}>
        <KpiTile
          label={t('dashboard.revenueThisMonth', 'Revenue this month')}
          value={formatCurrency(kpis?.revenue_this_month ?? 0)}
          current={kpis?.revenue_this_month ?? 0}
          previous={kpis?.revenue_last_month ?? 0}
          icon={Banknote}
          onClick={() => navigate('/app/academy/invoices')}
        />
        <KpiTile
          label={t('dashboard.newPlayersThisMonth', 'New players')}
          value={String(kpis?.new_players_this_month ?? 0)}
          current={kpis?.new_players_this_month ?? 0}
          previous={kpis?.new_players_last_month ?? 0}
          icon={Users}
          onClick={() => navigate('/app/academy/players')}
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

      {/* Analytics charts */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <MoneyChart data={monthly} />
        <NewPlayersChart data={monthly} />
      </div>

      {/* Reports summary — links to the deep report page */}
      {academyId && <AcademyReportsSummaryCard academyId={academyId} />}

      {/* Quick navigation — replaces the old duplicative preview tables */}
      <div>
        <h2 className="mb-3 text-base font-semibold">{t('dashboard.quickNavTitle', 'Quick navigation')}</h2>
        <DashboardQuickNav items={quickNav} />
      </div>
    </AppPage>
  );
}
