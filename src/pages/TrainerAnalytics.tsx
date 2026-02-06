import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, TrendingUp, TrendingDown, Calendar, Euro, Star, Users } from 'lucide-react';
import { format, subMonths, startOfMonth, endOfMonth, eachMonthOfInterval, parseISO } from 'date-fns';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, LineChart, Line } from 'recharts';
import { getTrainerAverageRating, getTrainerReviews } from '@/lib/reviews';

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
        navigate('/auth');
      } else if (role !== 'trainer') {
        navigate('/player');
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
        lessons(price)
      `)
      .in('slot_id', slotIds)
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
        return sum + (b.payment_amount || (b.lessons as any)?.price || 0);
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
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/trainer')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">Analytics</h1>
            <p className="text-sm text-muted-foreground">Track your performance and growth</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {/* Summary Stats */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatCard 
            title="Total Bookings" 
            value={summary.totalBookings} 
            icon={Calendar}
            change={summary.bookingsChange}
          />
          <StatCard 
            title="Total Earnings" 
            value={summary.totalEarnings} 
            icon={Euro}
            prefix="€"
            change={summary.earningsChange}
          />
          <StatCard 
            title="Unique Students" 
            value={summary.totalStudents} 
            icon={Users}
          />
          <StatCard 
            title="Average Rating" 
            value={summary.averageRating.toFixed(1)} 
            icon={Star}
            suffix={` (${summary.reviewCount})`}
          />
        </div>

        {/* Charts */}
        <Tabs defaultValue="bookings" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 max-w-md">
            <TabsTrigger value="bookings">Bookings</TabsTrigger>
            <TabsTrigger value="earnings">Earnings</TabsTrigger>
            <TabsTrigger value="ratings">Ratings</TabsTrigger>
          </TabsList>

          <TabsContent value="bookings">
            <Card>
              <CardHeader>
                <CardTitle>Booking Trends</CardTitle>
                <CardDescription>Monthly bookings over the last 6 months</CardDescription>
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
                <CardTitle>Earnings Trends</CardTitle>
                <CardDescription>Monthly earnings over the last 6 months</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[350px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={monthlyStats}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="month" className="text-xs" />
                      <YAxis className="text-xs" tickFormatter={(value) => `€${value}`} />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: 'hsl(var(--background))', 
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px'
                        }}
                        formatter={(value: number) => [`€${value}`, 'Earnings']}
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
                <CardTitle>Rating Trends</CardTitle>
                <CardDescription>Average rating by month</CardDescription>
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
                          if (name === 'rating') return [value.toFixed(1), 'Avg Rating'];
                          return [value, 'Reviews'];
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
                    <span>Average Rating</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-0.5 bg-muted-foreground"></div>
                    <span>Number of Reviews</span>
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
              <CardTitle>Students Overview</CardTitle>
              <CardDescription>Unique students per month</CardDescription>
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
              <CardTitle>Quick Insights</CardTitle>
              <CardDescription>Key performance indicators</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm">Avg. Bookings per Month</span>
                <span className="font-semibold">
                  {(summary.totalBookings / 6).toFixed(1)}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm">Avg. Earnings per Month</span>
                <span className="font-semibold">
                  €{(summary.totalEarnings / 6).toFixed(0)}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm">Avg. per Booking</span>
                <span className="font-semibold">
                  €{summary.totalBookings > 0 ? (summary.totalEarnings / summary.totalBookings).toFixed(0) : 0}
                </span>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <span className="text-sm">Student Retention</span>
                <span className="font-semibold">
                  {summary.totalStudents > 0 
                    ? Math.round((summary.totalBookings / summary.totalStudents)) 
                    : 0} bookings/student
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
