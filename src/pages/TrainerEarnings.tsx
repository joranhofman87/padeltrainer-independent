import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { 
  ArrowLeft, 
  TrendingUp, 
  Euro,
  CreditCard,
  Clock,
  CheckCircle2,
  Calendar
} from 'lucide-react';
import { format, parseISO, startOfMonth, endOfMonth, subMonths, isWithinInterval } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';

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
  } | null;
}

export default function TrainerEarnings() {
  const navigate = useNavigate();
  const { user, role, loading } = useAuth();
  const { toast } = useToast();
  
  const [bookings, setBookings] = useState<EarningsBooking[]>([]);
  const [loadingData, setLoadingData] = useState(true);

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
    }
  }, [user, role]);

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
        player:profiles!bookings_player_id_fkey(full_name)
      `)
      .eq('availability_slots.trainer_id', trainerProfile.id)
      .in('status', ['completed', 'confirmed', 'cancelled'])
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching earnings:', error);
      toast({ title: 'Error', description: 'Failed to load earnings data', variant: 'destructive' });
    } else {
      setBookings((data as any) || []);
    }
    setLoadingData(false);
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
    b.payment_status === 'pending'
  );
  
  const pendingAmount = pendingPayments.reduce((sum, b) => sum + getAmount(b), 0);

  const monthlyGrowth = lastMonthEarnings > 0 
    ? ((thisMonthEarnings - lastMonthEarnings) / lastMonthEarnings * 100).toFixed(0)
    : thisMonthEarnings > 0 ? '+100' : '0';

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
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-xl font-bold">Earnings</h1>
              <p className="text-sm text-muted-foreground">Track your income and payments</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
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

        <Tabs defaultValue="pending" className="space-y-4">
          <TabsList>
            <TabsTrigger value="pending" className="gap-2">
              Pending Payments
              {pendingPayments.length > 0 && (
                <Badge variant="secondary">{pendingPayments.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history">Payment History</TabsTrigger>
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
                        <p className="font-semibold">{booking.lessons?.title || 'Training Session'}</p>
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
                        <Button onClick={() => handleMarkPaid(booking.id, getAmount(booking))}>
                          <CheckCircle2 className="h-4 w-4 mr-2" />
                          Mark Paid
                        </Button>
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
        </Tabs>
      </main>
    </div>
  );
}