import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useTranslation } from 'react-i18next';
import { 
  ArrowLeft, 
  TrendingUp, 
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
  Info
} from 'lucide-react';
import { format, parseISO, startOfMonth, endOfMonth, subMonths, isWithinInterval } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import { CreateInvoiceDialog } from '@/components/trainer/CreateInvoiceDialog';
import { InvoiceList } from '@/components/trainer/InvoiceList';
import { InvoiceSettingsCard } from '@/components/trainer/InvoiceSettingsCard';
import { getAcademyPaymentInfo, type AcademyPaymentInfo } from '@/lib/academyTrainerPayments';
import { logger } from '@/lib/logger';

interface EarningsBooking {
  id: string;
  status: string;
  payment_status: string;
  payment_amount: number | null;
  paid_at: string | null;
  created_at: string;
  availability_slots: {
    start_time: string;
    end_time: string;
  };
  lessons: {
    title: string;
    price: number;
    payment_timing: string;
  } | null;
  player: {
    full_name: string | null;
    email: string | null;
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
}

export default function TrainerEarnings() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, role, loading } = useAuth();
  const { toast } = useToast();
  
  const [bookings, setBookings] = useState<EarningsBooking[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus | null>(null);
  const [connectLoading, setConnectLoading] = useState(false);
  const [trainerInfo, setTrainerInfo] = useState<TrainerBusinessInfo | null>(null);
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<any>(null);
  const [invoiceRefreshTrigger, setInvoiceRefreshTrigger] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [academyPaymentInfo, setAcademyPaymentInfo] = useState<AcademyPaymentInfo | null>(null);
  const { t } = useTranslation('trainer');

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
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
      toast({ title: 'Mollie Connected!', description: 'Your account is now set up to receive payments' });
      checkConnectStatus();
    }
    if (searchParams.get('refresh') === 'true') {
      checkConnectStatus();
    }
  }, [searchParams]);

  const fetchTrainerInfo = async () => {
    const { data, error } = await supabase
      .from('trainer_profiles')
      .select('id, business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, use_manual_invoicing')
      .eq('user_id', user!.id)
      .single();

    if (data) {
      setTrainerInfo(data as TrainerBusinessInfo);
    }
  };

  const fetchEarnings = async () => {
    const { data: trainerProfile } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user!.id)
      .single();

    if (!trainerProfile) {
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
        created_at,
        availability_slots!inner(start_time, end_time, trainer_id),
        lessons(title, price, payment_timing),
        player:profiles!bookings_player_id_fkey(full_name, email)
      `)
      .eq('availability_slots.trainer_id', trainerProfile.id)
      .in('status', ['completed', 'confirmed', 'cancelled'])
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Error fetching earnings', undefined, { error, component: 'TrainerEarnings' });
      toast({ title: 'Error', description: 'Failed to load earnings data', variant: 'destructive' });
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
        description: err.message || 'Failed to connect Mollie',
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
      toast({ title: 'Error', description: 'Failed to update settings', variant: 'destructive' });
    } else {
      setTrainerInfo(prev => prev ? { ...prev, use_manual_invoicing: checked } : null);
      toast({ 
        title: checked ? 'Manual invoicing enabled' : 'Automatic payments enabled',
        description: checked 
          ? 'You create invoices and handle payments yourself' 
          : 'Players pay online via Mollie when booking'
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
      toast({ title: 'Error', description: 'Failed to mark as paid', variant: 'destructive' });
    } else {
      toast({ title: 'Payment Recorded', description: 'The booking has been marked as paid' });
      fetchEarnings();
    }
  };

  const handleCreateInvoice = (booking: EarningsBooking) => {
    setSelectedBooking({
      id: booking.id,
      lessonTitle: booking.lessons?.title || 'Training Session',
      playerName: booking.player?.full_name || 'Unknown',
      playerEmail: booking.player?.email || '',
      date: format(parseISO(booking.availability_slots.start_time), 'yyyy-MM-dd'),
      time: format(parseISO(booking.availability_slots.start_time), 'HH:mm'),
      price: booking.lessons?.price || 0,
    });
    setInvoiceDialogOpen(true);
  };

  // Calculate earnings
  const now = new Date();
  const thisMonthStart = startOfMonth(now);
  const thisMonthEnd = endOfMonth(now);
  const lastMonthStart = startOfMonth(subMonths(now, 1));
  const lastMonthEnd = endOfMonth(subMonths(now, 1));

  const completedBookings = bookings.filter(b => b.status === 'completed');
  
  const getAmount = (b: EarningsBooking) => b.payment_amount || b.lessons?.price || 0;
  
  const totalEarnings = completedBookings
    .filter(b => b.payment_status === 'paid')
    .reduce((sum, b) => sum + getAmount(b), 0);

  const thisMonthEarnings = completedBookings
    .filter(b => b.payment_status === 'paid' && b.paid_at && 
      isWithinInterval(parseISO(b.paid_at), { start: thisMonthStart, end: thisMonthEnd }))
    .reduce((sum, b) => sum + getAmount(b), 0);

  const lastMonthEarnings = completedBookings
    .filter(b => b.payment_status === 'paid' && b.paid_at &&
      isWithinInterval(parseISO(b.paid_at), { start: lastMonthStart, end: lastMonthEnd }))
    .reduce((sum, b) => sum + getAmount(b), 0);

  const pendingPayments = bookings.filter(b => 
    (b.status === 'completed' || (b.status === 'confirmed' && b.lessons?.payment_timing === 'after')) && 
    (b.payment_status === 'pending' || b.payment_status === 'invoiced')
  );
  
  const pendingAmount = pendingPayments.reduce((sum, b) => sum + getAmount(b), 0);

  const monthlyGrowth = lastMonthEarnings > 0 
    ? ((thisMonthEarnings - lastMonthEarnings) / lastMonthEarnings * 100).toFixed(0)
    : thisMonthEarnings > 0 ? '+100' : '0';

  const useManualInvoicing = trainerInfo?.use_manual_invoicing ?? false;
  const isBusinessInfoComplete = trainerInfo?.business_name && trainerInfo?.business_address && trainerInfo?.kvk_number && trainerInfo?.iban;

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <h1 className="text-xl font-bold">Earnings</h1>
                <p className="text-sm text-muted-foreground">Track your income and payments</p>
              </div>
            </div>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowSettings(!showSettings)}
            >
              <Settings className="h-4 w-4 mr-2" />
              {showSettings ? 'Hide Settings' : 'Invoice Settings'}
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Club Payment Info Card - Show for club trainers */}
        {academyPaymentInfo?.isAcademyTrainer && (
          <Card className={`mb-6 ${academyPaymentInfo.academyChargesEnabled 
            ? 'border-blue-200 bg-gradient-to-r from-blue-50 to-sky-50 dark:from-blue-950/20 dark:to-sky-950/20' 
            : 'border-orange-300 bg-orange-50 dark:bg-orange-950/20'}`}>
            <CardContent className="p-4">
              <div className="flex items-start gap-4">
                <div className={`p-2 rounded-full ${academyPaymentInfo.academyChargesEnabled ? 'bg-blue-100 dark:bg-blue-900' : 'bg-orange-100 dark:bg-orange-900'}`}>
                  <Building2 className={`h-5 w-5 ${academyPaymentInfo.academyChargesEnabled ? 'text-blue-600' : 'text-orange-600'}`} />
                </div>
                <div className="flex-1">
                  {academyPaymentInfo.academyChargesEnabled ? (
                    <>
                      <p className="font-medium text-blue-800 dark:text-blue-200">
                        {t('academyPayments.handledByAcademy', { academyName: academyPaymentInfo.academyName || 'Your academy' })}
                      </p>
                      <p className="text-sm text-blue-600 dark:text-blue-300">
                        {t('academyPayments.academyCollectsPayments')}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-medium text-orange-800 dark:text-orange-200">
                        {t('academyPayments.academyNeedsSetup', { academyName: academyPaymentInfo.academyName || 'Your academy' })}
                      </p>
                      <p className="text-sm text-orange-600 dark:text-orange-300">
                        {t('academyPayments.contactAcademyOwner')}
                      </p>
                    </>
                  )}
                </div>
                {academyPaymentInfo.academyChargesEnabled && (
                  <Badge variant="outline" className="border-blue-300 text-blue-600">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Active
                  </Badge>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Payment Mode Toggle - Only show if NOT an academy trainer (academy trainers don't choose payment method) */}
        {!academyPaymentInfo?.isAcademyTrainer && (
          <Card className="mb-6">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-full bg-primary/10">
                    <FileText className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium">Manual payments by invoice</p>
                    <p className="text-sm text-muted-foreground max-w-md">
                      {useManualInvoicing 
                        ? 'You create invoices and players pay you directly (bank transfer, cash, etc.)' 
                        : 'Players pay you online via Mollie when booking. Money goes to your bank automatically.'}
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
        {!academyPaymentInfo?.isAcademyTrainer && useManualInvoicing && !isBusinessInfoComplete && (
          <Card className="mb-6 border-orange-300 bg-orange-50 dark:bg-orange-950/20">
            <CardContent className="p-4 flex items-center gap-4">
              <AlertCircle className="h-5 w-5 text-orange-500 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-orange-800 dark:text-orange-200">Complete your business details</p>
                <p className="text-sm text-orange-600 dark:text-orange-300">Add your KvK, BTW, and bank details to create invoices</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowSettings(true)}>
                Add Details
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Mollie Connect Card - only show when NOT using manual invoicing and NOT an academy trainer */}
        {!academyPaymentInfo?.isAcademyTrainer && !useManualInvoicing && connectStatus && !connectStatus.chargesEnabled && (
          <Card className="mb-8 border-primary/50 bg-gradient-to-r from-primary/5 to-primary/10">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-primary/10">
                  <Wallet className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Connect Your Bank Account</CardTitle>
                  <CardDescription>
                    Receive payments directly to your bank account with Mollie
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <div className="flex-1 space-y-2">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    Automatic payouts to your bank
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    Accept iDEAL, cards, and Bancontact
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                    Platform fee: 5% per transaction
                  </div>
                </div>
                <Button onClick={handleConnectMollie} disabled={connectLoading} size="lg">
                  {connectLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <ExternalLink className="h-4 w-4 mr-2" />
                  )}
                  Connect with Mollie
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Mollie Balance Card - only show when NOT using manual invoicing and NOT an academy trainer */}
        {!academyPaymentInfo?.isAcademyTrainer && !useManualInvoicing && connectStatus?.chargesEnabled && connectStatus.balance && (
          <Card className="mb-8 border-green-200 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950/20 dark:to-emerald-950/20">
            <CardContent className="p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-full bg-green-100 dark:bg-green-900">
                    <Wallet className="h-6 w-6 text-green-600" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Mollie Balance</p>
                    <div className="flex items-baseline gap-3">
                      <span className="text-2xl font-bold text-green-600">
                        €{connectStatus.balance.available.toFixed(2)}
                      </span>
                      <span className="text-sm text-muted-foreground">available</span>
                      {connectStatus.balance.pending > 0 && (
                        <span className="text-sm text-orange-600">
                          +€{connectStatus.balance.pending.toFixed(2)} pending
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <Badge variant="outline" className="border-green-300 text-green-600">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Mollie Connected
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Mollie Connected (no balance data) */}
        {!academyPaymentInfo?.isAcademyTrainer && !useManualInvoicing && 
          connectStatus?.chargesEnabled && !connectStatus.balance && (
          <Card className="mb-8 border-green-200">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-full bg-green-100 dark:bg-green-900">
                    <Wallet className="h-6 w-6 text-green-600" />
                  </div>
                  <div>
                    <p className="font-medium">Mollie Connected</p>
                    <p className="text-sm text-muted-foreground">
                      Your account is set up to receive payments
                    </p>
                  </div>
                </div>
                <Badge variant="outline" className="border-green-300 text-green-600">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  Active
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pending onboarding warning - only show when NOT using manual invoicing */}
        {!useManualInvoicing && connectStatus?.connected && !connectStatus.onboardingComplete && (
          <Card className="mb-8 border-orange-300 bg-orange-50 dark:bg-orange-950/20">
            <CardContent className="p-4 flex items-center gap-4">
              <AlertCircle className="h-5 w-5 text-orange-500 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-orange-800 dark:text-orange-200">Complete your Mollie setup</p>
                <p className="text-sm text-orange-600 dark:text-orange-300">Finish onboarding to start receiving payments</p>
              </div>
              <Button variant="outline" onClick={handleConnectMollie} disabled={connectLoading}>
                Continue Setup
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Stats Cards */}
        <div className="grid md:grid-cols-4 gap-4 mb-8">
          <Card className="bg-gradient-to-br from-green-500 to-green-600 text-white border-0">
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-green-100 text-sm">Total Earned</p>
                  <p className="text-3xl font-bold">€{totalEarnings.toFixed(0)}</p>
                </div>
                <Euro className="h-10 w-10 text-green-200" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-muted-foreground text-sm">This Month</p>
                  <p className="text-2xl font-bold">€{thisMonthEarnings.toFixed(0)}</p>
                  <div className="flex items-center gap-1 mt-1">
                    <TrendingUp className={`h-4 w-4 ${Number(monthlyGrowth) >= 0 ? 'text-green-500' : 'text-red-500'}`} />
                    <span className={`text-sm ${Number(monthlyGrowth) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {monthlyGrowth}%
                    </span>
                  </div>
                </div>
                <Calendar className="h-8 w-8 text-muted-foreground" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-muted-foreground text-sm">Last Month</p>
                  <p className="text-2xl font-bold">€{lastMonthEarnings.toFixed(0)}</p>
                </div>
                <Clock className="h-8 w-8 text-muted-foreground" />
              </div>
            </CardContent>
          </Card>

          <Card className={pendingAmount > 0 ? 'border-orange-300' : ''}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-muted-foreground text-sm">Pending</p>
                  <p className="text-2xl font-bold text-orange-600">€{pendingAmount.toFixed(0)}</p>
                  <p className="text-xs text-muted-foreground">{pendingPayments.length} payments</p>
                </div>
                <CreditCard className="h-8 w-8 text-orange-500" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Payments Section */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Payments</h2>
          <Tabs defaultValue="pending" className="space-y-4">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="pending" className="gap-1 flex-1 sm:flex-none">
                Pending
                {pendingPayments.length > 0 && (
                  <Badge variant="secondary" className="ml-1">{pendingPayments.length}</Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="history" className="flex-1 sm:flex-none">History</TabsTrigger>
              {useManualInvoicing && (
                <TabsTrigger value="invoices" className="flex-1 sm:flex-none">
                  Invoices
                </TabsTrigger>
              )}
            </TabsList>

          <TabsContent value="pending" className="space-y-4">
            {pendingPayments.length === 0 ? (
              <Card className="p-8 text-center">
                <CheckCircle2 className="h-12 w-12 text-green-500 mx-auto mb-4" />
                <h3 className="font-semibold text-lg mb-2">All caught up!</h3>
                <p className="text-muted-foreground">No pending payments to collect</p>
              </Card>
            ) : (
              pendingPayments.map(booking => (
                <Card key={booking.id}>
                  <CardContent className="p-6">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <p className="font-semibold">{booking.lessons?.title || 'Training Session'}</p>
                          {booking.payment_status === 'invoiced' && (
                            <Badge variant="secondary">Invoiced</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{booking.player?.full_name || 'Player'}</p>
                        <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Calendar className="h-4 w-4" />
                            {format(parseISO(booking.availability_slots.start_time), 'MMM d, yyyy')}
                          </span>
                          <span className="flex items-center gap-1">
                            <Clock className="h-4 w-4" />
                            {format(parseISO(booking.availability_slots.start_time), 'HH:mm')}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <p className="text-2xl font-bold">€{getAmount(booking)}</p>
                        {useManualInvoicing ? (
                          <div className="flex gap-2">
                            {booking.payment_status !== 'invoiced' && (
                              <Button 
                                variant="outline"
                                onClick={() => handleCreateInvoice(booking)}
                                disabled={!isBusinessInfoComplete}
                              >
                                <FileText className="h-4 w-4 mr-2" />
                                Create Invoice
                              </Button>
                            )}
                            <Button onClick={() => handleMarkPaid(booking.id, getAmount(booking))}>
                              <CheckCircle2 className="h-4 w-4 mr-2" />
                              Mark Paid
                            </Button>
                          </div>
                        ) : (
                          <Button onClick={() => handleMarkPaid(booking.id, getAmount(booking))}>
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                            Mark Paid
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          <TabsContent value="history" className="space-y-4">
            {completedBookings.filter(b => b.payment_status === 'paid').length === 0 ? (
              <Card className="p-8 text-center">
                <Euro className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="font-semibold text-lg mb-2">No payment history yet</h3>
                <p className="text-muted-foreground">Completed payments will appear here</p>
              </Card>
            ) : (
              completedBookings
                .filter(b => b.payment_status === 'paid')
                .map(booking => (
                  <Card key={booking.id} className="opacity-85">
                    <CardContent className="p-6">
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <p className="font-semibold">{booking.lessons?.title || 'Training Session'}</p>
                            <Badge variant="outline" className="border-green-300 text-green-600">Paid</Badge>
                          </div>
                          <p className="text-sm text-muted-foreground">{booking.player?.full_name || 'Player'}</p>
                          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Calendar className="h-4 w-4" />
                              {format(parseISO(booking.availability_slots.start_time), 'MMM d, yyyy')}
                            </span>
                            {booking.paid_at && (
                              <span className="text-xs">
                                Paid on {format(parseISO(booking.paid_at), 'MMM d')}
                              </span>
                            )}
                          </div>
                        </div>
                        <p className="text-xl font-bold text-green-600">+€{getAmount(booking)}</p>
                      </div>
                    </CardContent>
                  </Card>
                ))
            )}
          </TabsContent>

          {useManualInvoicing && trainerInfo && (
            <TabsContent value="invoices">
              <InvoiceList 
                trainerId={trainerInfo.id} 
                refreshTrigger={invoiceRefreshTrigger}
              />
            </TabsContent>
          )}
          </Tabs>
        </div>
      </main>

      {/* Invoice Dialog */}
      {trainerInfo && (
        <CreateInvoiceDialog
          open={invoiceDialogOpen}
          onOpenChange={setInvoiceDialogOpen}
          booking={selectedBooking}
          trainerId={trainerInfo.id}
          trainerBusinessInfo={{
            business_name: trainerInfo.business_name,
            business_address: trainerInfo.business_address,
            kvk_number: trainerInfo.kvk_number,
            btw_number: trainerInfo.btw_number,
            iban: trainerInfo.iban,
            bic: trainerInfo.bic,
            payment_terms_days: trainerInfo.payment_terms_days,
          }}
          onInvoiceCreated={() => {
            setInvoiceRefreshTrigger(prev => prev + 1);
            fetchEarnings();
          }}
        />
      )}
    </div>
  );
}
