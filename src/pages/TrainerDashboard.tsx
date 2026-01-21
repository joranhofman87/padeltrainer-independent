import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { Calendar, Users, DollarSign, Settings, LogOut, BarChart3, Clock, ClipboardList, Check, ChevronDown, ChevronUp, ArrowRight, Bell, Eye, UserCircle } from 'lucide-react';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { supabase } from '@/integrations/supabase/client';
import { startOfMonth, endOfMonth } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { DashboardCalendar } from '@/components/trainer/DashboardCalendar';

interface DashboardStats {
  totalStudents: number;
  openSlots: number;
  monthlyEarnings: number;
  followerCount: number;
  profileViews: number;
}

interface SetupStatus {
  profileComplete: boolean;
  hasLessons: boolean;
  hasAvailability: boolean;
  stripeComplete: boolean;
  hasPlayers: boolean;
}

export default function TrainerDashboard() {
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation('trainer');
  const [stats, setStats] = useState<DashboardStats>({
    totalStudents: 0,
    openSlots: 0,
    monthlyEarnings: 0,
    followerCount: 0,
    profileViews: 0,
  });
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [setupStatus, setSetupStatus] = useState<SetupStatus>({
    profileComplete: false,
    hasLessons: false,
    hasAvailability: false,
    stripeComplete: false,
    hasPlayers: false,
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
        .select('id, hourly_rate, use_manual_invoicing')
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

      // Payment is complete if Stripe is set up OR manual invoicing is enabled
      const paymentsComplete = !!(stripeData?.onboarding_complete && stripeData?.charges_enabled) || !!trainerProfile.use_manual_invoicing;

      // Check if trainer has players
      const { count: playerCount } = await supabase
        .from('guest_players')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', trainerId);

      const hasPlayers = (playerCount || 0) > 0;

      setSetupStatus({
        profileComplete,
        hasLessons,
        hasAvailability,
        stripeComplete: paymentsComplete,
        hasPlayers,
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

      setTrainerId(trainerProfile.id);
      const currentTrainerId = trainerProfile.id;
      const now = new Date();
      const monthStart = startOfMonth(now);
      const monthEnd = endOfMonth(now);

      // 1. Unique students (distinct player_ids from all confirmed bookings)
      const { data: allBookings } = await supabase
        .from('bookings')
        .select(`
          player_id,
          guest_player_id,
          availability_slots!inner(trainer_id)
        `)
        .eq('availability_slots.trainer_id', currentTrainerId)
        .eq('status', 'confirmed');

      // Count unique players (both registered players and guest players)
      const uniquePlayerIds = new Set<string>();
      allBookings?.forEach(b => {
        if (b.player_id) uniquePlayerIds.add(b.player_id);
        if (b.guest_player_id) uniquePlayerIds.add(b.guest_player_id);
      });

      // 2. Open slots - future slots that are not marked full and have available spots
      const { data: futureSlots } = await supabase
        .from('availability_slots')
        .select(`
          id,
          is_marked_full,
          lesson_id,
          lessons(max_participants),
          bookings(id, status)
        `)
        .eq('trainer_id', currentTrainerId)
        .eq('is_marked_full', false)
        .gte('start_time', now.toISOString());

      // Count slots that have available spots
      let openSlotsCount = 0;
      futureSlots?.forEach(slot => {
        const maxParticipants = slot.lessons?.max_participants || 4;
        const confirmedBookings = slot.bookings?.filter((b: { status: string }) => b.status === 'confirmed').length || 0;
        if (confirmedBookings < maxParticipants) {
          openSlotsCount++;
        }
      });

      // 3. Monthly earnings (sum of payment_amount for paid bookings this month)
      const { data: monthlyBookings } = await supabase
        .from('bookings')
        .select(`
          payment_amount,
          paid_at,
          availability_slots!inner(trainer_id)
        `)
        .eq('availability_slots.trainer_id', currentTrainerId)
        .eq('payment_status', 'paid')
        .gte('paid_at', monthStart.toISOString())
        .lte('paid_at', monthEnd.toISOString());

      const totalEarnings = monthlyBookings?.reduce((sum, b) => sum + (b.payment_amount || 0), 0) || 0;
      // Apply platform fee (trainer gets 90%)
      const netEarnings = totalEarnings * 0.9;

      // 4. Follower count
      const { count: followerCount } = await supabase
        .from('trainer_followers')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      // 5. Profile views (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const { count: profileViews } = await supabase
        .from('trainer_profile_views')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId)
        .gte('viewed_at', thirtyDaysAgo.toISOString());

      setStats({
        totalStudents: uniquePlayerIds.size,
        openSlots: openSlotsCount,
        monthlyEarnings: netEarnings,
        followerCount: followerCount || 0,
        profileViews: profileViews || 0,
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
        <div className="container mx-auto px-4 py-2 sm:py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg sm:text-xl">PadelTrainer<span className="text-primary">.ai</span></span>
            <span className="text-xs bg-orange-500 text-white px-1.5 py-0.5 rounded-full hidden sm:inline">
              {t('badge')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <ProfileSwitcher context="trainer" />
            <Button variant="ghost" size="icon" onClick={() => navigate('/trainer/settings')}>
              <Settings className="h-5 w-5" />
            </Button>
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
        {/* Setup Checklist - Only show if not all complete */}
        {!setupLoading && !(setupStatus.profileComplete && setupStatus.hasLessons && setupStatus.hasAvailability && setupStatus.stripeComplete && setupStatus.hasPlayers) && (
          <SetupChecklist
            setupStatus={setupStatus}
            isExpanded={isSetupExpanded}
            onToggle={() => setIsSetupExpanded(!isSetupExpanded)}
            onNavigate={navigate}
          />
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => navigate('/analytics')}>
            <CardContent className="p-4 sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.profileViews')}</p>
                  <p className="text-2xl sm:text-3xl font-bold">
                    {statsLoading ? '...' : stats.profileViews}
                  </p>
                </div>
                <div className="p-2 sm:p-3 rounded-full bg-sky-100 dark:bg-sky-900">
                  <Eye className="h-4 w-4 sm:h-5 sm:w-5 text-sky-600 dark:text-sky-400" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewProfileViews')}</p>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:shadow-lg transition-shadow" onClick={() => navigate('/analytics')}>
            <CardContent className="p-4 sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.followers')}</p>
                  <p className="text-2xl sm:text-3xl font-bold">
                    {statsLoading ? '...' : stats.followerCount}
                  </p>
                </div>
                <div className="p-2 sm:p-3 rounded-full bg-purple-100 dark:bg-purple-900">
                  <Bell className="h-4 w-4 sm:h-5 sm:w-5 text-purple-600 dark:text-purple-400" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewFollowers')}</p>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => navigate('/trainer/players')}
          >
            <CardContent className="p-4 sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.totalStudents')}</p>
                  <p className="text-2xl sm:text-3xl font-bold">
                    {statsLoading ? '...' : stats.totalStudents}
                  </p>
                </div>
                <div className="p-2 sm:p-3 rounded-full bg-green-100 dark:bg-green-900">
                  <Users className="h-4 w-4 sm:h-5 sm:w-5 text-green-600 dark:text-green-400" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewStudents')}</p>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow"
            onClick={() => navigate('/trainer/open-slots')}
          >
            <CardContent className="p-4 sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.openSlots')}</p>
                  <p className="text-2xl sm:text-3xl font-bold">
                    {statsLoading ? '...' : stats.openSlots}
                  </p>
                </div>
                <div className="p-2 sm:p-3 rounded-full bg-blue-100 dark:bg-blue-900">
                  <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-blue-600 dark:text-blue-400" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewSlots')}</p>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:shadow-lg transition-shadow col-span-2 sm:col-span-1" onClick={() => navigate('/earnings')}>
            <CardContent className="p-4 sm:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs sm:text-sm text-muted-foreground">{t('dashboard.stats.revenue')}</p>
                  <p className="text-2xl sm:text-3xl font-bold">
                    {statsLoading ? '...' : `€${stats.monthlyEarnings.toFixed(0)}`}
                  </p>
                </div>
                <div className="p-2 sm:p-3 rounded-full bg-orange-100 dark:bg-orange-900">
                  <DollarSign className="h-4 w-4 sm:h-5 sm:w-5 text-orange-600 dark:text-orange-400" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2 hidden sm:block">{t('dashboard.stats.viewEarnings')}</p>
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions - 4 cards */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/lessons')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Calendar className="h-5 w-5 text-primary" />
                </div>
                <CardTitle className="text-lg">{t('dashboard.quickActions.myLessons.title')}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                {t('dashboard.quickActions.myLessons.description')}
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/trainer/calendar')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-500/10">
                  <Calendar className="h-5 w-5 text-indigo-600" />
                </div>
                <CardTitle className="text-lg">{t('calendar.title')}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                {t('dashboard.quickActions.workingHours.description').replace('Set your weekly schedule and generate slots', 'View your schedule at a glance')}
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
                <CardTitle className="text-lg">{t('dashboard.quickActions.bookings.title')}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                {t('dashboard.quickActions.bookings.description')}
              </CardDescription>
            </CardContent>
          </Card>

          <Card 
            className="cursor-pointer hover:shadow-lg transition-shadow hover:border-primary/50"
            onClick={() => navigate('/profile/edit')}
          >
            <CardHeader className="pb-2">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10">
                  <UserCircle className="h-5 w-5 text-emerald-600" />
                </div>
                <CardTitle className="text-lg">{t('dashboard.quickActions.myProfile.title', 'My Profile')}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription>
                {t('dashboard.quickActions.myProfile.description', 'Edit your profile, add locations and update your details')}
              </CardDescription>
            </CardContent>
          </Card>
        </div>

        {/* Calendar Widget */}
        <div className="mb-8">
          <DashboardCalendar trainerId={trainerId} />
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
    { key: 'hasAvailability', label: 'Create training cyclus or slots', route: '/trainer/calendar', complete: setupStatus.hasAvailability },
    { key: 'stripeComplete', label: 'Connect Stripe or setup manual payments', route: '/earnings', complete: setupStatus.stripeComplete },
    { key: 'hasPlayers', label: 'Add your players', route: '/trainer/players', complete: setupStatus.hasPlayers },
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
