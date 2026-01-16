import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Calendar, Users, DollarSign, Settings, LogOut, Plus, BarChart3, Clock, CreditCard, Crown, ClipboardList, Check, ChevronDown, ChevronUp, ArrowRight, CalendarSync } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { startOfMonth, endOfMonth } from 'date-fns';

interface DashboardStats {
  upcomingLessons: number;
  totalStudents: number;
  monthlyEarnings: number;
}

interface SetupStatus {
  profileComplete: boolean;
  hasLessons: boolean;
  hasAvailability: boolean;
  stripeComplete: boolean;
}

export default function TrainerDashboard() {
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [stats, setStats] = useState<DashboardStats>({
    upcomingLessons: 0,
    totalStudents: 0,
    monthlyEarnings: 0,
  });
  const [statsLoading, setStatsLoading] = useState(true);
  const [setupStatus, setSetupStatus] = useState<SetupStatus>({
    profileComplete: false,
    hasLessons: false,
    hasAvailability: false,
    stripeComplete: false,
  });
  const [setupLoading, setSetupLoading] = useState(true);
  const [isSetupExpanded, setIsSetupExpanded] = useState(() => {
    const stored = localStorage.getItem('trainer_setup_expanded');
    return stored !== null ? stored === 'true' : true;
  });

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate('/auth');
      } else if (!role) {
        navigate('/select-role');
      } else if (role !== 'trainer') {
        navigate('/player');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (user && role === 'trainer') {
      fetchStats();
      fetchSetupStatus();
    }
  }, [user, role]);

  useEffect(() => {
    localStorage.setItem('trainer_setup_expanded', String(isSetupExpanded));
  }, [isSetupExpanded]);

  const fetchSetupStatus = async () => {
    try {
      // Get trainer profile
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id, hourly_rate')
        .eq('user_id', user?.id)
        .maybeSingle();

      if (!trainerProfile) {
        setSetupLoading(false);
        return;
      }

      // Check profile: bio from profiles table
      const { data: profileData } = await supabase
        .from('profiles')
        .select('bio')
        .eq('user_id', user?.id)
        .maybeSingle();

      const profileComplete = !!(trainerProfile.hourly_rate && profileData?.bio);

      const trainerId = trainerProfile.id;

      // Check lessons exist
      const { count: lessonCount } = await supabase
        .from('lessons')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', trainerId);

      const hasLessons = (lessonCount || 0) > 0;

      // Check availability slots exist
      const { count: slotCount } = await supabase
        .from('availability_slots')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', trainerId);

      const hasAvailability = (slotCount || 0) > 0;

      // Check Stripe status
      const { data: stripeData } = await supabase
        .from('trainer_stripe_accounts')
        .select('onboarding_complete, charges_enabled')
        .eq('trainer_id', trainerId)
        .maybeSingle();

      const stripeComplete = !!(stripeData?.onboarding_complete && stripeData?.charges_enabled);

      setSetupStatus({
        profileComplete,
        hasLessons,
        hasAvailability,
        stripeComplete,
      });
    } catch (error) {
      console.error('Error fetching setup status:', error);
    } finally {
      setSetupLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      // Get trainer profile ID
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id')
        .eq('user_id', user?.id)
        .maybeSingle();

      if (!trainerProfile) {
        setStatsLoading(false);
        return;
      }

      const trainerId = trainerProfile.id;
      const now = new Date();
      const monthStart = startOfMonth(now);
      const monthEnd = endOfMonth(now);

      // 1. Upcoming lessons (confirmed bookings in future)
      const { data: upcomingBookings } = await supabase
        .from('availability_slots')
        .select(`
          id,
          start_time,
          bookings!inner(id, status)
        `)
        .eq('trainer_id', trainerId)
        .gte('start_time', now.toISOString())
        .eq('bookings.status', 'confirmed');

      // 2. Unique students (distinct player_ids from all confirmed bookings)
      const { data: allBookings } = await supabase
        .from('bookings')
        .select(`
          player_id,
          availability_slots!inner(trainer_id)
        `)
        .eq('availability_slots.trainer_id', trainerId)
        .eq('status', 'confirmed');

      const uniqueStudents = new Set(allBookings?.map(b => b.player_id) || []);

      // 3. Monthly earnings (sum of payment_amount for paid bookings this month)
      const { data: monthlyBookings } = await supabase
        .from('bookings')
        .select(`
          payment_amount,
          paid_at,
          availability_slots!inner(trainer_id)
        `)
        .eq('availability_slots.trainer_id', trainerId)
        .eq('payment_status', 'paid')
        .gte('paid_at', monthStart.toISOString())
        .lte('paid_at', monthEnd.toISOString());

      const totalEarnings = monthlyBookings?.reduce((sum, b) => sum + (b.payment_amount || 0), 0) || 0;
      // Apply platform fee (trainer gets 90%)
      const netEarnings = totalEarnings * 0.9;

      setStats({
        upcomingLessons: upcomingBookings?.length || 0,
        totalStudents: uniqueStudents.size,
        monthlyEarnings: netEarnings,
      });
    } catch (error) {
      console.error('Error fetching stats:', error);
    } finally {
      setStatsLoading(false);
    }
  };

  const handleSignOut = async () => {
    const { error } = await signOut();
    if (error) {
      toast({
        title: 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } else {
      navigate('/auth');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const initials = profile?.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'T';

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-background to-orange-100/30 dark:from-orange-950/20 dark:via-background dark:to-orange-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🎾</span>
            <span className="font-bold text-xl">PadelMatch</span>
            <span className="text-xs bg-orange-500 text-white px-2 py-0.5 rounded-full">
              Trainer
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Avatar className="h-9 w-9">
                <AvatarImage src={profile?.avatar_url || undefined} />
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="font-medium hidden sm:inline">{profile?.full_name || 'Trainer'}</span>
            </div>
            <Button variant="ghost" size="icon" onClick={handleSignOut}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Welcome Section */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold mb-2">
              Welcome back, Coach {profile?.full_name?.split(' ')[0] || ''}! 💪
            </h1>
            <p className="text-muted-foreground">
              Manage your lessons, view bookings, and grow your padel training business
            </p>
          </div>
          <Button className="hidden md:flex gap-2" onClick={() => navigate('/lessons')}>
            <Plus className="h-4 w-4" />
            Create Lesson
          </Button>
        </div>

        {/* Setup Checklist - Only show if not all complete */}
        {!setupLoading && !(setupStatus.profileComplete && setupStatus.hasLessons && setupStatus.hasAvailability && setupStatus.stripeComplete) && (
          <SetupChecklist
            setupStatus={setupStatus}
            isExpanded={isSetupExpanded}
            onToggle={() => setIsSetupExpanded(!isSetupExpanded)}
            onNavigate={navigate}
          />
        )}

        {/* Stats Cards */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Upcoming Lessons</p>
                  <p className="text-3xl font-bold">
                    {statsLoading ? '...' : stats.upcomingLessons}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900">
                  <Calendar className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Students</p>
                  <p className="text-3xl font-bold">
                    {statsLoading ? '...' : stats.totalStudents}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-green-100 dark:bg-green-900">
                  <Users className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => navigate('/earnings')}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">This Month</p>
                  <p className="text-3xl font-bold">
                    {statsLoading ? '...' : `€${stats.monthlyEarnings.toFixed(0)}`}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-orange-100 dark:bg-orange-900">
                  <DollarSign className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">Click to view earnings →</p>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => navigate('/analytics')}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Analytics</p>
                  <p className="text-3xl font-bold">📊</p>
                </div>
                <div className="p-3 rounded-full bg-purple-100 dark:bg-purple-900">
                  <BarChart3 className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">View detailed stats →</p>
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/trainer/calendar')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-500/10">
                  <Calendar className="h-5 w-5 text-indigo-600" />
                </div>
                <CardTitle className="text-lg">Calendar</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                View your schedule at a glance
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/trainer-bookings')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <ClipboardList className="h-5 w-5 text-blue-600" />
                </div>
                <CardTitle className="text-lg">Bookings</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                View and manage player bookings
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/schedule')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-green-500/10">
                  <Clock className="h-5 w-5 text-green-600" />
                </div>
                <CardTitle className="text-lg">Working Hours</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Set your training cycle and generate slots
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/lessons')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Calendar className="h-5 w-5 text-primary" />
                </div>
                <CardTitle className="text-lg">My Lessons</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Create and manage your training sessions
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/availability')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <Plus className="h-5 w-5 text-purple-600" />
                </div>
                <CardTitle className="text-lg">Individual Slots</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Add one-off time slots manually
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/earnings')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-500/10">
                  <CreditCard className="h-5 w-5 text-orange-600" />
                </div>
                <CardTitle className="text-lg">Earnings</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                View payouts and transaction history
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/subscription')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-purple-500/10">
                  <Crown className="h-5 w-5 text-purple-600" />
                </div>
                <CardTitle className="text-lg">Subscription</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Upgrade your plan for more features
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/profile/edit')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-gray-500/10">
                  <Settings className="h-5 w-5 text-gray-600" />
                </div>
                <CardTitle className="text-lg">Profile Settings</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Update your profile and payment settings
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/settings/calendar')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <CalendarSync className="h-5 w-5 text-blue-600" />
                </div>
                <CardTitle className="text-lg">Calendar Sync</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                Connect Google Calendar for automatic booking sync
              </CardDescription>
            </CardContent>
          </Card>
        </div>

      </main>
    </div>
  );
}

// Setup Checklist Component
interface SetupChecklistProps {
  setupStatus: SetupStatus;
  isExpanded: boolean;
  onToggle: () => void;
  onNavigate: (path: string) => void;
}

function SetupChecklist({ setupStatus, isExpanded, onToggle, onNavigate }: SetupChecklistProps) {
  const steps = [
    { key: 'profileComplete', label: 'Complete your profile information', route: '/profile/edit', complete: setupStatus.profileComplete },
    { key: 'hasLessons', label: 'Create your first lesson', route: '/lessons', complete: setupStatus.hasLessons },
    { key: 'hasAvailability', label: 'Set your availability', route: '/schedule', complete: setupStatus.hasAvailability },
    { key: 'stripeComplete', label: 'Set up payments with Stripe Connect', route: '/earnings', complete: setupStatus.stripeComplete },
  ];

  const completedCount = steps.filter(s => s.complete).length;
  const totalSteps = steps.length;

  return (
    <Card className="border-orange-200 dark:border-orange-800 bg-orange-50/50 dark:bg-orange-950/20 mb-8">
      <Collapsible open={isExpanded} onOpenChange={onToggle}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-orange-100/50 dark:hover:bg-orange-900/20 transition-colors rounded-t-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">🚀</span>
                <div>
                  <CardTitle className="text-orange-700 dark:text-orange-400">
                    Complete Your Setup
                  </CardTitle>
                  <CardDescription className="mt-1">
                    {completedCount}/{totalSteps} steps complete
                  </CardDescription>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="shrink-0">
                {isExpanded ? (
                  <ChevronUp className="h-5 w-5 text-orange-600" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-orange-600" />
                )}
              </Button>
            </div>
            {/* Progress bar */}
            <div className="mt-3 h-2 bg-orange-200 dark:bg-orange-900 rounded-full overflow-hidden">
              <div 
                className="h-full bg-orange-500 transition-all duration-300"
                style={{ width: `${(completedCount / totalSteps) * 100}%` }}
              />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            <p className="text-sm text-muted-foreground mb-4">
              Finish setting up your trainer profile to start receiving bookings
            </p>
            <div className="space-y-2">
              {steps.map((step, index) => (
                <button
                  key={step.key}
                  onClick={() => onNavigate(step.route)}
                  className="w-full flex items-center justify-between gap-3 p-3 bg-background rounded-lg hover:bg-muted/50 transition-colors text-left group"
                >
                  <div className="flex items-center gap-3">
                    {step.complete ? (
                      <div className="h-6 w-6 rounded-full bg-green-500 flex items-center justify-center">
                        <Check className="h-4 w-4 text-white" />
                      </div>
                    ) : (
                      <div className="h-6 w-6 rounded-full border-2 border-orange-400 flex items-center justify-center text-xs font-medium text-orange-600">
                        {index + 1}
                      </div>
                    )}
                    <span className={step.complete ? 'text-muted-foreground line-through' : ''}>
                      {step.label}
                    </span>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
