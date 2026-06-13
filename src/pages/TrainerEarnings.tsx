import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useIsAdmin } from '@/hooks/useAdminData';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import {
  Euro,
  CreditCard,
  Clock,
  CheckCircle2,
  Calendar,
  ExternalLink,
  Wallet,
  AlertCircle,
  Loader2,
  FileText,
  Settings,
  Building2,
} from 'lucide-react';
import { TrainerPageHeader } from '@/components/trainer/shell/TrainerPageHeader';
import { TrainerIconWell } from '@/components/trainer/shell/TrainerIconWell';
import { DashboardStatTile } from '@/components/trainer/dashboard/DashboardStatTile';
import { DashboardEmptyState } from '@/components/trainer/dashboard/DashboardEmptyState';
import { EarningsBookingRow } from '@/components/trainer/earnings/EarningsBookingRow';
import { cn } from '@/lib/utils';
import { format, parseISO, startOfMonth, endOfMonth, subMonths } from 'date-fns';
import { bookingReceivedAmount, isReceivedPayment, sumReceivedInRange } from '@/lib/trainerEarnings';
import { getBookedPlayerName } from '@/lib/bookedPlayerName';
import { supabase } from '@/lib/supabaseClient';
// CreateInvoiceDialog removed — now using /app/trainer/invoices/new page
import { InvoiceList } from '@/components/trainer/InvoiceList';
import { InvoiceSettingsCard } from '@/components/trainer/InvoiceSettingsCard';
import { getAcademyPaymentInfo, type AcademyPaymentInfo } from '@/lib/academyTrainerPayments';
import { formatCurrency } from '@/lib/format';
import { logger } from '@/lib/logger';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorState } from '@/components/ui/QueryErrorState';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';

interface EarningsBooking {
  id: string;
  status: string;
  payment_status: string;
  payment_amount: number | null;
  paid_at: string | null;
  paid_externally: boolean | null;
  created_at: string;
  availability_slots: {
    start_time: string;
    end_time: string;
    price_per_session: number | null;
    cyclus_name: string | null;
  };
  player: {
    full_name: string | null;
    email: string | null;
  } | null;
  guest_players: {
    full_name: string | null;
  } | null;
}

interface ConnectStatus {
  connected: boolean;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  onboardingComplete?: boolean;
  balance?: {
    available: number;
    pending: number;
    currency: string;
  };
}

interface TrainerBusinessInfo {
  id: string;
  business_name: string | null;
  business_address: string | null;
  kvk_number: string | null;
  btw_number: string | null;
  iban: string | null;
  bic: string | null;
  payment_terms_days: number;
  use_manual_invoicing: boolean;
  default_vat_rate: number | null;
  invoice_forward_emails: string[] | null;
  invoice_logo_url: string | null;
  invoice_prefix: string | null;
  invoice_next_number: number | null;
}

export default function TrainerEarnings() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, role, loading } = useAuth();
  const { data: isAdmin } = useIsAdmin();
  const { toast } = useToast();
  
  const [bookings, setBookings] = useState<EarningsBooking[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [trainerInfo, setTrainerInfo] = useState<TrainerBusinessInfo | null>(null);
  // invoiceDialogOpen removed — using page navigation now
  const [invoiceRefreshTrigger] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [academyPaymentInfo, setAcademyPaymentInfo] = useState<AcademyPaymentInfo | null>(null);
  const [connectStatusLoading, setConnectStatusLoading] = useState(true);
  const { t } = useTranslation('trainer');

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/app/auth');
      } else if (role !== 'trainer') {
        navigate('/app/player');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (user && role === 'trainer') {
      fetchEarnings();
      fetchTrainerInfo();
      checkConnectStatus();
      fetchAcademyPaymentInfo();
    }
  }, [user, role]);

  const fetchAcademyPaymentInfo = async () => {
    const { data: trainerProfile } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user!.id)
      .single();

    if (trainerProfile) {
      const info = await getAcademyPaymentInfo(trainerProfile.id);
      setAcademyPaymentInfo(info);
    }
  };

  // Handle return from Mollie Connect onboarding
  useEffect(() => {
    if (searchParams.get('connected') === 'true') {
      toast({ title: t('earningsPage.mollieConnectedToast'), description: t('earningsPage.mollieConnectedDescription') });
      checkConnectStatus();
    }
    if (searchParams.get('refresh') === 'true') {
      checkConnectStatus();
    }
  }, [searchParams]);

  const fetchTrainerInfo = async () => {
    const { data } = await supabase
      .from('trainer_profiles_owner' as any)
      .select('id, business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, use_manual_invoicing, default_vat_rate, invoice_forward_emails, invoice_logo_url, invoice_banner_color, invoice_reply_to_email, invoice_prefix, invoice_next_number, invoice_include_year, invoice_language')
      .eq('user_id', user!.id)
      .single();

    if (data) {
      setTrainerInfo(data as unknown as TrainerBusinessInfo);
    }
  };

  const fetchEarnings = async () => {
    setLoadingData(true);
    setLoadError(false);

    const { data: trainerProfile, error: profileError } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user!.id)
      .single();

    if (profileError || !trainerProfile) {
      logger.error('Error fetching trainer profile for earnings', undefined, { error: profileError, component: 'TrainerEarnings' });
      setLoadError(true);
      setLoadingData(false);
      return;
    }

    const { data, error } = await supabase
      .from('bookings')
      .select(`
        id,
        status,
        payment_status,
        payment_amount,
        paid_at,
        paid_externally,
        created_at,
        player_id,
        availability_slots!inner(start_time, end_time, trainer_id, price_per_session, cyclus_name),
        player:profiles!bookings_player_id_fkey(full_name, email),
        guest_players:guest_player_id(full_name)
      `)
      .eq('availability_slots.trainer_id', trainerProfile.id)
      .in('status', ['completed', 'confirmed', 'cancelled'])
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching earnings', undefined, { error, component: 'TrainerEarnings' });
      setLoadError(true);
    } else {
      setBookings((data as any) || []);
    }
    setLoadingData(false);
  };

  const checkConnectStatus = async () => {
    try {
      const { data: tp } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user!.id)
        .single();

      if (!tp) {
        setConnectStatus({ connected: false });
        return;
      }

      const { data, error } = await supabase.functions.invoke('check-mollie-connect-status', {
        body: { entityType: 'trainer', entityId: tp.id },
      });
      if (error) throw error;
      setConnectStatus({
        connected: data?.connected || false,
        chargesEnabled: data?.chargesEnabled,
        payoutsEnabled: data?.payoutsEnabled,
        onboardingComplete: data?.onboardingComplete,
        balance: data?.balance,
      });
    } catch (err) {
      logger.warn('Error checking connect status', { error: err, component: 'TrainerEarnings' });
      setConnectStatus({ connected: false });
    } finally {
      setConnectStatusLoading(false);
    }
  };

  const handleConnectMollie = async () => {
    setConnectLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('mollie-connect-trainer');
      if (error) throw error;
      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (err: any) {
      toast({
        title: 'Error',
        description: getFriendlyErrorMessage(err, 'Failed to connect Mollie'),
        variant: 'destructive',
      });
      setConnectLoading(false);
    }
  };

  const handleToggleManualInvoicing = async (checked: boolean) => {
    const { error } = await supabase
      .from('trainer_profiles')
      .update({ use_manual_invoicing: checked })
      .eq('user_id', user!.id);

    if (error) {
      toast({
        title: t('common:error', 'Error'),
        description: getFriendlyErrorMessage(error, t('earningsPage.settingsUpdateError', 'Could not update your payment settings. Please try again.')),
        variant: 'destructive',
      });
    } else {
      setTrainerInfo(prev => prev ? { ...prev, use_manual_invoicing: checked } : null);
      toast({ 
        title: checked ? t('earningsPage.manualEnabledToast') : t('earningsPage.autoEnabledToast'),
        description: checked 
          ? t('earningsPage.manualEnabledDescription')
          : t('earningsPage.autoEnabledDescription')
      });
    }
  };

  const handleMarkPaid = async (bookingId: string, amount: number) => {
    const { error } = await supabase
      .from('bookings')
      .update({ 
        payment_status: 'paid', 
        payment_amount: amount,
        paid_at: new Date().toISOString()
      })
      .eq('id', bookingId);

    if (error) {
      toast({
        title: t('common:error', 'Error'),
        description: getFriendlyErrorMessage(error, t('earningsPage.markPaidError', 'Could not record the payment. Please try again.')),
        variant: 'destructive',
      });
    } else {
      toast({ title: t('earningsPage.paymentRecorded'), description: t('earningsPage.paymentRecordedDescription') });
      fetchEarnings();
    }
  };

  const handleCreateInvoice = () => {
    navigate('/app/trainer/invoices/new');
  };

  // Calculate earnings
  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const thisMonthEnd = endOfMonth(now);
  const lastMonthStart = startOfMonth(subMonths(now, 1));
  const lastMonthEnd = endOfMonth(subMonths(now, 1));

  const completedBookings = bookings.filter(b => b.status === 'completed');

  // Earnings = money actually received (payment_status='paid' + paid_at), gross,
  // no fee — the shared rule the TrainerDashboard "Revenue" tile also uses, so
  // the two tiles always agree.
  const getAmount = (b: EarningsBooking) => bookingReceivedAmount(b);

  const totalEarnings = bookings
    .filter(isReceivedPayment)
    .reduce((sum, b) => sum + getAmount(b), 0);

  const thisMonthEarnings = sumReceivedInRange(bookings, thisMonthStart, thisMonthEnd);

  const lastMonthEarnings = sumReceivedInRange(bookings, lastMonthStart, lastMonthEnd);

  const pendingPayments = bookings.filter(b => 
    (b.status === 'completed' || b.status === 'confirmed') && 
    (b.payment_status === 'pending' || b.payment_status === 'invoiced')
  );
  
  const pendingAmount = pendingPayments.reduce((sum, b) => sum + getAmount(b), 0);

  const monthlyGrowth = lastMonthEarnings > 0 
    ? ((thisMonthEarnings - lastMonthEarnings) / lastMonthEarnings * 100).toFixed(0)
    : thisMonthEarnings > 0 ? '+100' : '0';

  const useManualInvoicing = trainerInfo?.use_manual_invoicing ?? false;
  const isBusinessInfoComplete = trainerInfo?.business_name && trainerInfo?.business_address && trainerInfo?.kvk_number && trainerInfo?.iban;

  const needsMollieConnect =
    !academyPaymentInfo?.isAcademyTrainer &&
    !useManualInvoicing &&
    !connectStatusLoading &&
    !!connectStatus &&
    !connectStatus.chargesEnabled;

  const earningsPrimaryAction = needsMollieConnect
    ? {
        label: t('earningsPage.connectMollie'),
        onClick: handleConnectMollie,
        icon: ExternalLink,
        loading: connectLoading,
      }
    : !academyPaymentInfo?.isAcademyTrainer && useManualInvoicing && !isBusinessInfoComplete
      ? {
          label: t('earningsPage.addDetails'),
          onClick: () => setShowSettings(true),
        }
      : !academyPaymentInfo?.isAcademyTrainer && useManualInvoicing
        ? {
            label: t('earningsPage.createInvoice'),
            onClick: handleCreateInvoice,
            icon: FileText,
          }
        : undefined;

  const earningsMoreMenu =
    !academyPaymentInfo?.isAcademyTrainer
      ? [
          {
            label: showSettings ? t('earningsPage.hideSettings') : t('earningsPage.invoiceSettings'),
            onClick: () => setShowSettings(!showSettings),
            icon: Settings,
          },
        ]
      : undefined;

  if (loading || loadingData) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-4 py-2">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
        <div className="grid gap-4 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 py-2">
        <TrainerPageHeader
          title={t('earningsPage.title')}
          description={t('earningsPage.subtitle')}
          primaryAction={earningsPrimaryAction}
          moreMenuItems={earningsMoreMenu}
        />
        {academyPaymentInfo?.isAcademyTrainer && (
          <Card
            className={cn(
              'border-border/80 shadow-sm',
              !academyPaymentInfo.academyChargesEnabled && 'border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning-soft))]/30',
            )}
          >
            <CardContent className="p-4 sm:p-5">
              <div className="flex items-start gap-4">
                <TrainerIconWell icon={Building2} />
                <div className="flex-1">
                  {academyPaymentInfo.academyChargesEnabled ? (
                    <>
                      <p className="font-medium text-foreground">
                        {t('academyPayments.handledByAcademy', { academyName: academyPaymentInfo.academyName || 'Your academy' })}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('academyPayments.academyCollectsPayments')}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-foreground">
                        {t('academyPayments.academyNeedsSetup', { academyName: academyPaymentInfo.academyName || 'Your academy' })}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('academyPayments.contactAcademyOwner')}
                      </p>
                    </>
                  )}
                </div>
                {academyPaymentInfo.academyChargesEnabled && (
                  <Badge variant="secondary">
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    {t('earningsPage.activeStatus')}
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Payment Mode Toggle - Only show if NOT an academy trainer (academy trainers don't choose payment method) */}
        {!academyPaymentInfo?.isAcademyTrainer && (
          <Card className="border-border/80 shadow-sm">
            <CardContent className="p-4 sm:p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <TrainerIconWell icon={FileText} />
                  <div>
                    <p className="font-medium">{t('earningsPage.manualPayments')}</p>
                    <p className="text-sm text-muted-foreground max-w-md">
                      {useManualInvoicing 
                        ? t('earningsPage.manualEnabled')
                        : t('earningsPage.manualDisabled')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor="manual-invoicing" className="text-sm text-muted-foreground sr-only">
                    Toggle manual invoicing
                  </Label>
                  <Switch
                    id="manual-invoicing"
                    checked={useManualInvoicing}
                    onCheckedChange={handleToggleManualInvoicing}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Invoice Settings (collapsible) - Only for non-academy trainers */}
        {!academyPaymentInfo?.isAcademyTrainer && showSettings && trainerInfo && (
          <div className="mb-6">
            <InvoiceSettingsCard 
              userId={user!.id}
              initialData={trainerInfo}
              onSave={fetchTrainerInfo}
            />
          </div>
        )}

        {/* Manual invoicing: Business info warning - Only for non-academy trainers */}
        {!academyPaymentInfo?.isAcademyTrainer && !isBusinessInfoComplete && (
          <Card className="border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning-soft))]/40 shadow-sm">
            <CardContent className="flex items-center gap-4 p-4 sm:p-5">
              <TrainerIconWell icon={AlertCircle} />
              <div className="flex-1">
                <p className="font-medium text-foreground">{t('earningsPage.completeBusinessDetails')}</p>
                <p className="text-sm text-muted-foreground">{t('earningsPage.addBusinessDetails')}</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
                {t('earningsPage.addDetails')}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Mollie Connect Card Skeleton */}
        {!academyPaymentInfo?.isAcademyTrainer && !useManualInvoicing && connectStatusLoading && (
          <Card className="mb-8">
            <CardHeader>
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-5 w-48" />
                  <Skeleton className="h-4 w-72" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-56" />
                  <Skeleton className="h-4 w-64" />
                  <Skeleton className="h-4 w-48" />
                </div>
                <Skeleton className="h-10 w-44" />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Mollie Connect Card - only show when NOT using manual invoicing and NOT an academy trainer */}
        {!academyPaymentInfo?.isAcademyTrainer && !useManualInvoicing && !connectStatusLoading && connectStatus && !connectStatus.chargesEnabled && (
          <Card className="border-[hsl(var(--brand-200))] shadow-sm">
            <CardHeader>
              <div className="flex items-center gap-3">
                <TrainerIconWell icon={Wallet} />
                <div>
                  <CardTitle className="text-lg">{t('earningsPage.connectBank')}</CardTitle>
                  <CardDescription>
                    {t('earningsPage.connectBankDescription')}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-[hsl(var(--brand-600))]" />
                    {t('earningsPage.autoPayout')}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-[hsl(var(--brand-600))]" />
                    {t('earningsPage.acceptMethods')}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-[hsl(var(--brand-600))]" />
                    {t('earningsPage.platformFee')}
                  </div>
                </div>
                <Button onClick={handleConnectMollie} disabled={connectLoading} size="lg">
                  {connectLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <ExternalLink className="h-4 w-4 mr-2" />
                  )}
                  {t('earningsPage.connectMollie')}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Mollie Balance Card - only show when NOT using manual invoicing and NOT an academy trainer */}
        {!academyPaymentInfo?.isAcademyTrainer && !useManualInvoicing && connectStatus?.chargesEnabled && connectStatus.balance && (
          <Card className="border-border/80 shadow-sm">
            <CardContent className="p-5 sm:p-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-4">
                  <TrainerIconWell icon={Wallet} />
                  <div>
                     <p className="text-sm text-muted-foreground">{t('earningsPage.mollieBalance')}</p>
                     <div className="flex flex-wrap items-baseline gap-3">
                       <span className="font-display text-2xl font-semibold tabular-nums text-[hsl(var(--navy-900))]">
                         {formatCurrency(connectStatus.balance.available)}
                       </span>
                       <span className="text-sm text-muted-foreground">{t('earningsPage.available')}</span>
                      {connectStatus.balance.pending > 0 && (
                        <span className="text-sm text-[hsl(var(--warning))]">
                          +{formatCurrency(connectStatus.balance.pending)} pending
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <Badge variant="secondary">
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  {t('earningsPage.mollieConnected')}
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {!academyPaymentInfo?.isAcademyTrainer && !useManualInvoicing &&
          connectStatus?.chargesEnabled && !connectStatus.balance && (
          <Card className="border-border/80 shadow-sm">
            <CardContent className="p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <TrainerIconWell icon={Wallet} />
                  <div>
                    <p className="font-medium text-[hsl(var(--navy-900))]">{t('earningsPage.mollieConnected')}</p>
                    <p className="text-sm text-muted-foreground">
                      {t('earningsPage.accountSetUp')}
                    </p>
                  </div>
                </div>
                <Badge variant="secondary">
                  <CheckCircle2 className="mr-1 h-3 w-3" />
                  {t('earningsPage.activeStatus')}
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {!useManualInvoicing && connectStatus?.connected && !connectStatus.onboardingComplete && (
          <Card className="border-[hsl(var(--warning))]/30 bg-[hsl(var(--warning-soft))]/40 shadow-sm">
            <CardContent className="flex items-center gap-4 p-4">
              <AlertCircle className="h-5 w-5 shrink-0 text-[hsl(var(--warning))]" />
              <div className="flex-1">
                <p className="font-medium text-foreground">{t('earningsPage.completeMollieSetup')}</p>
                <p className="text-sm text-muted-foreground">{t('earningsPage.finishOnboarding')}</p>
              </div>
              <Button variant="outline" onClick={handleConnectMollie} disabled={connectLoading}>
                {t('earningsPage.continueSetup')}
              </Button>
            </CardContent>
          </Card>
        )}

        {loadError ? (
          <QueryErrorState onRetry={fetchEarnings} />
        ) : (
        <>
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <DashboardStatTile
            label={t('earningsPage.totalEarned')}
            value={formatCurrency(totalEarnings)}
            icon={Euro}
          />
          <DashboardStatTile
            label={t('earningsPage.thisMonth')}
            value={formatCurrency(thisMonthEarnings)}
            icon={Calendar}
            subtext={`${Number(monthlyGrowth) >= 0 ? '+' : ''}${monthlyGrowth}%`}
          />
          <DashboardStatTile
            label={t('earningsPage.lastMonth')}
            value={formatCurrency(lastMonthEarnings)}
            icon={Clock}
          />
          <DashboardStatTile
            label={t('earningsPage.pending')}
            value={formatCurrency(pendingAmount)}
            icon={CreditCard}
            subtext={`${pendingPayments.length} payments`}
            highlight={pendingAmount > 0}
          />
        </section>

        <div className="space-y-4">
          <h2 className="font-display text-lg font-semibold text-[hsl(var(--navy-900))]">{t('earningsPage.payments')}</h2>
          <Tabs defaultValue="pending" className="space-y-4">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="pending" className="gap-1 flex-1 sm:flex-none">
                {t('manageBookings.pending')}
                {pendingPayments.length > 0 && (
                  <Badge variant="secondary" className="ml-1">{pendingPayments.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="history" className="flex-1 sm:flex-none">{t('earningsPage.history')}</TabsTrigger>
              <TabsTrigger value="invoices" className="flex-1 sm:flex-none">
                {t('earningsPage.invoicesTab')}
              </TabsTrigger>
            </TabsList>

          <TabsContent value="pending" className="space-y-3">
            {pendingPayments.length === 0 ? (
              <Card className="overflow-hidden border-border/80 shadow-sm">
                <DashboardEmptyState
                  icon={CheckCircle2}
                  message={t('earningsPage.allCaughtUp')}
                  hint={t('earningsPage.noPendingPayments')}
                />
              </Card>
            ) : (
              pendingPayments.map((booking) => (
                <EarningsBookingRow
                  key={booking.id}
                  title={booking.availability_slots.cyclus_name || t('earningsPage.trainingSession')}
                  subtitle={getBookedPlayerName(booking)}
                  meta={
                    <div className="flex flex-wrap items-center gap-4">
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="h-4 w-4" />
                        {format(parseISO(booking.availability_slots.start_time), 'MMM d, yyyy')}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-4 w-4" />
                        {format(parseISO(booking.availability_slots.start_time), 'HH:mm')}
                      </span>
                    </div>
                  }
                  badges={
                    booking.payment_status === 'invoiced' ? (
                      <Badge variant="secondary">Invoiced</Badge>
                    ) : undefined
                  }
                  amount={formatCurrency(getAmount(booking))}
                  actions={
                    useManualInvoicing ? (
                      <div className="flex flex-wrap gap-2">
                        {booking.payment_status !== 'invoiced' && (
                          <Button
                            variant="outline"
                            onClick={() => handleCreateInvoice()}
                            disabled={!isBusinessInfoComplete}
                          >
                            <FileText className="mr-2 h-4 w-4" />
                            {t('earningsPage.createInvoice')}
                          </Button>
                        )}
                        <Button
                          className="bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))]"
                          onClick={() => handleMarkPaid(booking.id, getAmount(booking))}
                        >
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          {t('earningsPage.markPaid')}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        className="bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))]"
                        onClick={() => handleMarkPaid(booking.id, getAmount(booking))}
                      >
                        <CheckCircle2 className="mr-2 h-4 w-4" />
                        {t('earningsPage.markPaid')}
                      </Button>
                    )
                  }
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="history" className="space-y-3">
            {completedBookings.filter(b => b.payment_status === 'paid').length === 0 ? (
              <Card className="overflow-hidden border-border/80 shadow-sm">
                <DashboardEmptyState
                  icon={Euro}
                  message={t('earningsPage.noPaymentHistory')}
                  hint={t('earningsPage.completedPaymentsAppear')}
                />
              </Card>
            ) : (
              completedBookings
                .filter(b => b.payment_status === 'paid')
                .map((booking) => (
                  <EarningsBookingRow
                    key={booking.id}
                    className="opacity-90"
                    title={booking.availability_slots.cyclus_name || t('earningsPage.trainingSession')}
                    subtitle={getBookedPlayerName(booking)}
                    meta={
                      <div className="flex flex-wrap items-center gap-4">
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="h-4 w-4" />
                          {format(parseISO(booking.availability_slots.start_time), 'MMM d, yyyy')}
                        </span>
                        {booking.paid_at && (
                          <span>
                            {t('earningsPage.paidOn', { date: format(parseISO(booking.paid_at), 'MMM d') })}
                          </span>
                        )}
                      </div>
                    }
                    badges={
                      <Badge variant="secondary">
                        {(booking as { paid_externally?: boolean }).paid_externally
                          ? t('bookings.paidExternally', 'Paid (external)')
                          : 'Paid'}
                      </Badge>
                    }
                    amount={`+${formatCurrency(getAmount(booking))}`}
                    amountClassName="text-[hsl(var(--brand-600))]"
                  />
                ))
            )}
          </TabsContent>

          {trainerInfo && (
            <TabsContent value="invoices">
              <InvoiceList 
                trainerId={trainerInfo.id} 
                refreshTrigger={invoiceRefreshTrigger}
                forwardEmails={trainerInfo.invoice_forward_emails || []}
                isAdmin={isAdmin === true}
              />
            </TabsContent>
          )}
          </Tabs>
        </div>
        </>
        )}

      {/* CreateInvoiceDialog removed — using /app/trainer/invoices/new page */}
    </div>
  );
}
