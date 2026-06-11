import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, TrendingUp, TrendingDown, Calendar, Euro, Star, Users } from 'lucide-react';
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval, parseISO } from 'date-fns';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, LineChart, Line } from 'recharts';
import { getTrainerAverageRating, getTrainerReviews } from '@/lib/reviews';
import { formatCurrency } from '@/lib/format';

interface MonthlyStats {
  month: string;
  bookings: number;
  earnings: number;
  students: number;
}

interface RatingTrend {
  month: string;
  rating: number;
  reviews: number;
}

export default function TrainerAnalytics() {
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation('trainer');
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [loadingStats, setLoadingStats] = useState(true);
  const [monthlyStats, setMonthlyStats] = useState<MonthlyStats[]>([]);
  const [ratingTrends, setRatingTrends] = useState<RatingTrend[]>([]);
  const [summary, setSummary] = useState({
    totalBookings: 0,
    totalEarnings: 0,
    totalStudents: 0,
    averageRating: 0,
    reviewCount: 0,
    bookingsChange: 0,
    earningsChange: 0,
  });

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
    if (user) {
      fetchTrainerId();
    }
  }, [user]);

  useEffect(() => {
    if (trainerId) {
      fetchAnalytics();
    }
  }, [trainerId]);

  const fetchTrainerId = async () => {
    const { data } = await supabase
      .from('trainer_profiles')
      .select('id')
      .eq('user_id', user!.id)
      .single();
    
    if (data) {
      setTrainerId(data.id);
    }
  };

  const fetchAnalytics = async () => {
    if (!trainerId) return;
    setLoadingStats(true);

    const now = new Date();
    const sixMonthsAgo = subMonths(now, 5);
    const months = eachMonthOfInterval({ start: startOfMonth(sixMonthsAgo), end: endOfMonth(now) });

    // Fetch all bookings for this trainer
    const { data: slots } = await supabase
      .from('availability_slots')
      .select('id')
      .eq('trainer_id', trainerId);

    const slotIds = slots?.map(s => s.id) || [];

    const { data: bookings } = await supabase
      .from('bookings')
      .select(`
        id,
        created_at,
        status,
        payment_amount,
        player_id,
        availability_slots!inner(price_per_session, trainer_id)
      `)
      .eq('availability_slots.trainer_id', trainerId)
      .gte('created_at', sixMonthsAgo.toISOString());

    // Fetch reviews
    const { data: reviews } = await getTrainerReviews(trainerId);
    const { average, count } = await getTrainerAverageRating(trainerId);

    // Calculate monthly stats
    const monthlyData: MonthlyStats[] = months.map(month => {
      const monthStart = startOfMonth(month);
      const monthEnd = endOfMonth(month);
      
      const monthBookings = bookings?.filter(b => {
        const bookingDate = parseISO(b.created_at);
        return bookingDate >= monthStart && bookingDate <= monthEnd;
      }) || [];

      const completedBookings = monthBookings.filter(b => 
        b.status === 'completed' || b.status === 'confirmed'
      );

      const earnings = completedBookings.reduce((sum, b) => {
        return sum + (b.payment_amount || (b.availability_slots as any)?.price_per_session || 0);
      }, 0);

      const uniqueStudents = new Set(monthBookings.map(b => b.player_id)).size;

      return {
        month: format(month, 'MMM'),
        bookings: monthBookings.length,
        earnings,
        students: uniqueStudents,
      };
    });

    setMonthlyStats(monthlyData);

    // Calculate rating trends (from reviews)
    const ratingData: RatingTrend[] = months.map(month => {
      const monthStart = startOfMonth(month);
      const monthEnd = endOfMonth(month);
      
      const monthReviews = reviews?.filter(r => {
        const reviewDate = parseISO(r.created_at);
        return reviewDate >= monthStart && reviewDate <= monthEnd;
      }) || [];

      const avgRating = monthReviews.length > 0
        ? monthReviews.reduce((sum, r) => sum + r.rating, 0) / monthReviews.length
        : 0;

      return {
        month: format(month, 'MMM'),
        rating: Math.round(avgRating * 10) / 10,
        reviews: monthReviews.length,
      };
    });

    setRatingTrends(ratingData);

    // Calculate summary stats
    const totalBookings = bookings?.length || 0;
    const totalEarnings = monthlyData.reduce((sum, m) => sum + m.earnings, 0);
    const uniqueStudents = new Set(bookings?.map(b => b.player_id) || []).size;

    // Calculate month-over-month changes
    const currentMonth = monthlyData[monthlyData.length - 1];
    const previousMonth = monthlyData[monthlyData.length - 2];
    
    const bookingsChange = previousMonth?.bookings 
      ? ((currentMonth.bookings - previousMonth.bookings) / previousMonth.bookings) * 100
      : 0;
    const earningsChange = previousMonth?.earnings
      ? ((currentMonth.earnings - previousMonth.earnings) / previousMonth.earnings) * 100
      : 0;

    setSummary({
      totalBookings,
      totalEarnings,
      totalStudents: uniqueStudents,
      averageRating: average || 0,
      reviewCount: count,
      bookingsChange: Math.round(bookingsChange),
      earningsChange: Math.round(earningsChange),
    });

    setLoadingStats(false);
  };

  if (loading || loadingStats) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const StatCard = ({ 
    title, 
    value, 
    icon: Icon, 
    change, 
    suffix = '',
    prefix = '' 
  }: { 
    title: string; 
    value: number | string; 
    icon: any; 
    change?: number; 
    suffix?: string;
    prefix?: string;
  }) => (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold">{prefix}{value}{suffix}</p>
            {change !== undefined && (
              <div className={`flex items-center gap-1 text-sm mt-1 ${change >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {change >= 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                <span>{change >= 0 ? '+' : ''}{change}% vs last month</span>
              </div>
            )}
          </div>
          <div className="p-3 rounded-full bg-primary/10">
            <Icon className="h-5 w-5 text-primary" />
          </div>
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate('/trainer')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t('analyticsPage.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('analyticsPage.subtitle')}</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Summary Stats */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard 
            title={t('analyticsPage.totalBookings')} 
            value={summary.totalBookings} 
            icon={Calendar}
            change={summary.bookingsChange}
          />
          <StatCard 
            title={t('analyticsPage.totalEarnings')} 
            value={formatCurrency(summary.totalEarnings)}
            icon={Euro}
            change={summary.earningsChange}
          />
          <StatCard 
            title={t('analyticsPage.uniqueStudents')} 
            value={summary.totalStudents} 
            icon={Users}
          />
          <StatCard 
            title={t('analyticsPage.averageRating')} 
            value={summary.averageRating.toFixed(1)} 
            icon={Star}
            suffix={` (${summary.reviewCount})`}
          />
        </div>

        {/* Charts */}
        <Tabs defaultValue="bookings" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 max-w-md">
            <TabsTrigger value="bookings">{t('analyticsPage.bookings')}</TabsTrigger>
            <TabsTrigger value="earnings">{t('analyticsPage.earnings')}</TabsTrigger>
            <TabsTrigger value="ratings">{t('analyticsPage.ratings')}</TabsTrigger>
          </TabsList>

          <TabsContent value="bookings">
            <Card>
              <CardHeader>
                <CardTitle>{t('analyticsPage.bookingTrends')}</CardTitle>
                <CardDescription>{t('analyticsPage.bookingTrendsDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyStats}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" className="text-xs" />
                      <YAxis className="text-xs" />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--background))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }} 
                      />
                      <Bar 
                        dataKey="bookings" 
                        fill="hsl(var(--primary))" 
                        radius={[4, 4, 0, 0]}
                        name="Bookings"
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="earnings">
            <Card>
              <CardHeader>
                <CardTitle>{t('analyticsPage.earningsTrends')}</CardTitle>
                <CardDescription>{t('analyticsPage.earningsTrendsDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={monthlyStats}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" className="text-xs" />
                      <YAxis className="text-xs" tickFormatter={(value) => formatCurrency(value)} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--background))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number) => [formatCurrency(value), 'Earnings']}
                      />
                      <Area 
                        type="monotone" 
                        dataKey="earnings" 
                        stroke="hsl(var(--primary))" 
                        fill="hsl(var(--primary) / 0.2)"
                        name="Earnings"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="ratings">
            <Card>
              <CardHeader>
                <CardTitle>{t('analyticsPage.ratingTrends')}</CardTitle>
                <CardDescription>{t('analyticsPage.ratingTrendsDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={ratingTrends}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" className="text-xs" />
                      <YAxis className="text-xs" domain={[0, 5]} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--background))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number, name: string) => {
                          if (name === 'rating') return [value.toFixed(1), t('analyticsPage.avgRating')];
                          return [value, t('analyticsPage.reviews')];
                        }}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="rating" 
                        stroke="hsl(var(--primary))" 
                        strokeWidth={2}
                        dot={{ fill: 'hsl(var(--primary))' }}
                        name="rating"
                      />
                      <Line 
                        type="monotone" 
                        dataKey="reviews" 
                        stroke="hsl(var(--muted-foreground))" 
                        strokeWidth={1}
                        strokeDasharray="5 5"
                        dot={false}
                        name="reviews"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex items-center justify-center gap-6 mt-4 text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-primary"></div>
                     <span>{t('analyticsPage.averageRating')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-0.5 bg-muted-foreground"></div>
                    <span>{t('analyticsPage.numberOfReviews')}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Additional Stats */}
        <div className="grid md:grid-cols-2 gap-6 mt-8">
          <Card>
            <CardHeader>
                <CardTitle>{t('analyticsPage.studentsOverview')}</CardTitle>
                <CardDescription>{t('analyticsPage.studentsOverviewDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthlyStats}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis dataKey="month" className="text-xs" />
                    <YAxis className="text-xs" />
                    <Tooltip 
                      contentStyle={{ 
                        backgroundColor: 'hsl(var(--background))', 
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px'
                      }} 
                    />
                    <Bar 
                      dataKey="students" 
                      fill="hsl(142 76% 36%)" 
                      radius={[4, 4, 0, 0]}
                      name="Students"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
                <CardTitle>{t('analyticsPage.quickInsights')}</CardTitle>
                <CardDescription>{t('analyticsPage.keyPerformance')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm">{t('analyticsPage.avgBookingsPerMonth')}</span>
                <span className="font-semibold">
                  {(summary.totalBookings / 6).toFixed(1)}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm">{t('analyticsPage.avgEarningsPerMonth')}</span>
                <span className="font-semibold">
                  {formatCurrency(summary.totalEarnings / 6)}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm">{t('analyticsPage.avgPerBooking')}</span>
                <span className="font-semibold">
                  {formatCurrency(summary.totalBookings > 0 ? summary.totalEarnings / summary.totalBookings : 0)}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm">{t('analyticsPage.studentRetention')}</span>
                <span className="font-semibold">
                  {summary.totalStudents > 0 
                    ? Math.round((summary.totalBookings / summary.totalStudents)) 
                    : 0} {t('analyticsPage.bookingsPerStudent')}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
