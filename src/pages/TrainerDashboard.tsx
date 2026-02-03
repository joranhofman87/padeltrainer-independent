import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { signOut } from '@/lib/auth';
import { useToast } from '@/hooks/use-toast';
import { 
  Calendar, Users, DollarSign, Clock, Check, ChevronDown, ChevronUp, 
  ArrowRight, Bell, Eye, Building2, CalendarDays, AlertTriangle,
  ChevronLeft, ChevronRight, LayoutGrid, Plus, Repeat, Copy
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { 
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, addWeeks, subWeeks,
  addMonths, subMonths, addDays, subDays, format
} from 'date-fns';
import { useTranslation } from 'react-i18next';
import { getClubPaymentInfo, type ClubPaymentInfo } from '@/lib/clubTrainerPayments';
import { FeatureErrorBoundary } from '@/components/FeatureErrorBoundary';
import { logger } from '@/lib/logger';
import { getTrialDaysRemaining } from '@/lib/subscription';

// Calendar components
import { TrainerCalendarGrid } from '@/components/trainer/TrainerCalendarGrid';
import { SlotWithBookings, BookedPlayer } from '@/components/trainer/CalendarSlotCard';
import { AddSlotDialog, BulkCreateSheet } from '@/components/trainer/AddSlotDialog';
import { SlotTypeChoiceDialog } from '@/components/trainer/SlotTypeChoiceDialog';
import { BookForPlayerDialog } from '@/components/trainer/BookForPlayerDialog';
import { DuplicateCyclusDialog } from '@/components/trainer/DuplicateCyclusDialog';
import { DeleteSlotDialog } from '@/components/trainer/DeleteSlotDialog';
import { EditBookingDialog } from '@/components/trainer/EditBookingDialog';

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
  paymentsComplete: boolean;
  hasPlayers: boolean;
  clubPaymentInfo?: ClubPaymentInfo;
}

interface Lesson {
  id: string;
  title: string;
  price: number;
  location: string | null;
}

interface ScheduleSettings {
  slot_duration_minutes: number;
  schedule_weeks_ahead: number;
}

export default function TrainerDashboard() {
  const { user, profile, role, loading, subscription } = useAuth();
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
    paymentsComplete: false,
    hasPlayers: false,
    clubPaymentInfo: undefined,
  });
  const [setupLoading, setSetupLoading] = useState(true);
  const [isSetupExpanded, setIsSetupExpanded] = useState(() => {
    const stored = localStorage.getItem('trainer_setup_expanded');
    return stored !== null ? stored === 'true' : true;
  });

  // Calendar state
  const [view, setView] = useState<"day" | "week" | "month">("week");
  const [currentDate, setCurrentDate] = useState(new Date());
  const [calendarSlots, setCalendarSlots] = useState<SlotWithBookings[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [settings, setSettings] = useState<ScheduleSettings>({
    slot_duration_minutes: 60,
    schedule_weeks_ahead: 4,
  });

  // Dialog states
  const [slotTypeChoiceOpen, setSlotTypeChoiceOpen] = useState(false);
  const [addSlotOpen, setAddSlotOpen] = useState(false);
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  const [bookForPlayerOpen, setBookForPlayerOpen] = useState(false);
  const [duplicateCyclusOpen, setDuplicateCyclusOpen] = useState(false);
  const [deleteSlotOpen, setDeleteSlotOpen] = useState(false);
  const [editBookingOpen, setEditBookingOpen] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithBookings | null>(null);
  const [slotToDelete, setSlotToDelete] = useState<SlotWithBookings | null>(null);
  const [bookingToEdit, setBookingToEdit] = useState<any>(null);
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);
  const [preselectedCyclusId, setPreselectedCyclusId] = useState<string | undefined>();
  const [defaultSlotDate, setDefaultSlotDate] = useState<Date | undefined>();
  const [defaultSlotTime, setDefaultSlotTime] = useState<string | undefined>();

  useEffect(() => {
    if (user && role === 'trainer') {
      fetchStats();
      fetchSetupStatus();
      fetchTrainerData();
    }
  }, [user, role]);

  useEffect(() => {
    if (trainerId) {
      fetchCalendarSlots();
    }
  }, [trainerId, currentDate, view]);

  useEffect(() => {
    localStorage.setItem('trainer_setup_expanded', String(isSetupExpanded));
  }, [isSetupExpanded]);

  const fetchTrainerData = async () => {
    try {
      const { data: trainerProfile } = await supabase
        .from("trainer_profiles")
        .select("id, slot_duration_minutes, schedule_weeks_ahead")
        .eq("user_id", user!.id)
        .maybeSingle();

      if (!trainerProfile) return;

      setTrainerId(trainerProfile.id);
      setSettings({
        slot_duration_minutes: trainerProfile.slot_duration_minutes || 60,
        schedule_weeks_ahead: trainerProfile.schedule_weeks_ahead || 4,
      });

      // Fetch lessons with more details
      const { data: lessonData } = await supabase
        .from("lessons")
        .select("id, title, price, location")
        .eq("trainer_id", trainerProfile.id)
        .eq("is_active", true);

      setLessons(lessonData || []);
    } catch (error) {
      console.error("Error fetching trainer data:", error);
    }
  };

  const fetchCalendarSlots = async () => {
    if (!trainerId) return;
    
    setCalendarLoading(true);
    try {
      // Calculate date range
      let rangeStart: Date;
      let rangeEnd: Date;

      if (view === "day") {
        rangeStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 0, 0, 0);
        rangeEnd = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 23, 59, 59);
      } else if (view === "week") {
        rangeStart = startOfWeek(currentDate, { weekStartsOn: 1 });
        rangeEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
      } else {
        rangeStart = startOfMonth(currentDate);
        rangeEnd = endOfMonth(currentDate);
        rangeStart = startOfWeek(rangeStart, { weekStartsOn: 1 });
        rangeEnd = endOfWeek(rangeEnd, { weekStartsOn: 1 });
      }

      // Fetch availability slots with lessons
      const { data: availabilitySlots, error: slotsError } = await supabase
        .from("availability_slots")
        .select(`
          id,
          start_time,
          end_time,
          lesson_id,
          cyclus_id,
          cyclus_name,
          is_marked_full,
          location_id,
          locations:location_id (
            name
          ),
          lessons:lesson_id (
            title,
            max_participants,
            price
          )
        `)
        .eq("trainer_id", trainerId)
        .gte("start_time", rangeStart.toISOString())
        .lte("start_time", rangeEnd.toISOString())
        .order("start_time");

      if (slotsError) throw slotsError;

      // Fetch bookings for these slots with player names
      const slotIds = availabilitySlots?.map((s) => s.id) || [];
      let bookings: any[] = [];
      
      if (slotIds.length > 0) {
        const { data: bookingsData, error: bookingsError } = await supabase
          .from("bookings")
          .select(`
            id,
            slot_id,
            status,
            player_id,
            guest_player_id,
            profiles:player_id (full_name, skill_rating, rating_system),
            guest_players:guest_player_id (full_name, skill_rating, rating_system)
          `)
          .in("slot_id", slotIds);

        if (bookingsError) throw bookingsError;
        bookings = bookingsData || [];
      }

      // Aggregate booking counts and player info
      const bookingCounts: Record<
        string,
        { confirmed: number; pending: number; players: BookedPlayer[] }
      > = {};
      bookings?.forEach((b) => {
        if (!bookingCounts[b.slot_id]) {
          bookingCounts[b.slot_id] = { confirmed: 0, pending: 0, players: [] };
        }
        if (b.status === "confirmed") {
          bookingCounts[b.slot_id].confirmed++;
        } else if (b.status === "pending") {
          bookingCounts[b.slot_id].pending++;
        }
        
        const profile = b.profiles as { full_name: string | null; skill_rating: number | null; rating_system: string } | null;
        const guestPlayer = b.guest_players as { full_name: string | null; skill_rating: number | null; rating_system: string } | null;
        const playerName = profile?.full_name || guestPlayer?.full_name || "Unknown";
        const skillRating = profile?.skill_rating ?? guestPlayer?.skill_rating ?? null;
        const ratingSystem = profile?.rating_system || guestPlayer?.rating_system || 'knltb';
        
        if (b.status === "confirmed" || b.status === "pending") {
          bookingCounts[b.slot_id].players.push({
            id: b.player_id || b.guest_player_id || b.id,
            bookingId: b.id,
            name: playerName,
            status: b.status as "confirmed" | "pending",
            isGuest: !!b.guest_player_id,
            skillRating,
            ratingSystem,
          });
        }
      });

      // Transform to SlotWithBookings
      const now = new Date();
      const transformedSlots: SlotWithBookings[] = (availabilitySlots || []).map(
        (slot) => {
          const lesson = slot.lessons as { title: string; max_participants: number; price: number } | null;
          const location = slot.locations as { name: string } | null;
          const counts = bookingCounts[slot.id] || { confirmed: 0, pending: 0, players: [] };

          return {
            id: slot.id,
            start_time: slot.start_time,
            end_time: slot.end_time,
            lesson_id: slot.lesson_id,
            lesson_title: lesson?.title || null,
            max_participants: lesson?.max_participants || 1,
            price: lesson?.price || null,
            active_bookings: counts.confirmed,
            pending_bookings: counts.pending,
            is_past: new Date(slot.start_time) < now,
            cyclus_id: slot.cyclus_id || null,
            cyclus_name: slot.cyclus_name || null,
            booked_players: counts.players,
            is_marked_full: slot.is_marked_full || false,
            location_name: location?.name || null,
          };
        }
      );

      setCalendarSlots(transformedSlots);
    } catch (error) {
      console.error("Error fetching calendar slots:", error);
    } finally {
      setCalendarLoading(false);
    }
  };

  // Calendar navigation
  const navigatePrevious = () => {
    if (view === "day") {
      setCurrentDate(subDays(currentDate, 1));
    } else if (view === "week") {
      setCurrentDate(subWeeks(currentDate, 1));
    } else {
      setCurrentDate(subMonths(currentDate, 1));
    }
  };

  const navigateNext = () => {
    if (view === "day") {
      setCurrentDate(addDays(currentDate, 1));
    } else if (view === "week") {
      setCurrentDate(addWeeks(currentDate, 1));
    } else {
      setCurrentDate(addMonths(currentDate, 1));
    }
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const getDateRangeLabel = () => {
    if (view === "day") {
      return format(currentDate, "EEEE, MMMM d, yyyy");
    }
    if (view === "week") {
      const start = startOfWeek(currentDate, { weekStartsOn: 1 });
      const end = endOfWeek(currentDate, { weekStartsOn: 1 });
      return `${format(start, "MMM d")} - ${format(end, "MMM d, yyyy")}`;
    }
    return format(currentDate, "MMMM yyyy");
  };

  // Calendar stats
  const freeSlots = calendarSlots.filter(
    (s) => !s.is_past && s.active_bookings === 0 && s.pending_bookings === 0
  ).length;
  const bookedSlots = calendarSlots.filter((s) => !s.is_past && s.active_bookings > 0).length;
  const pendingSlots = calendarSlots.filter(
    (s) => !s.is_past && s.pending_bookings > 0 && s.active_bookings === 0
  ).length;

  // Calendar handlers
  const handleCellClick = (date: Date, hour: number) => {
    setDefaultSlotDate(date);
    setDefaultSlotTime(`${String(hour).padStart(2, "0")}:00`);
    setSlotTypeChoiceOpen(true);
  };

  const handleChooseSingleSlot = () => {
    setAddSlotOpen(true);
  };

  const handleChooseCyclus = () => {
    setBulkCreateOpen(true);
  };

  const handleSlotsCreated = () => {
    fetchCalendarSlots();
    fetchStats();
  };

  const handleBookForPlayer = (slot: SlotWithBookings) => {
    setSelectedSlot(slot);
    if (slot.lesson_id) {
      const lesson = lessons.find(l => l.id === slot.lesson_id);
      setSelectedLesson(lesson || null);
    } else {
      setSelectedLesson(null);
    }
    setBookForPlayerOpen(true);
  };

  const handleDuplicateCyclus = (cyclusId: string) => {
    setPreselectedCyclusId(cyclusId);
    setDuplicateCyclusOpen(true);
  };

  const handleDeleteSlot = (slot: SlotWithBookings) => {
    setSlotToDelete(slot);
    setDeleteSlotOpen(true);
  };

  const handleEditBooking = async (bookingId: string) => {
    try {
      const { data, error } = await supabase
        .from("bookings")
        .select(`
          id,
          status,
          notes,
          payment_status,
          payment_amount,
          guest_player_id,
          availability_slots (id, start_time, end_time),
          lessons (id, title, price, location),
          profiles:player_id (id, full_name, email)
        `)
        .eq("id", bookingId)
        .single();

      if (error) throw error;

      setBookingToEdit({
        ...data,
        player: data.profiles,
      });
      setEditBookingOpen(true);
    } catch (error) {
      console.error("Error fetching booking:", error);
    }
  };

  const handleToggleMarkedFull = async (
    slotId: string,
    value: boolean,
    applyToCyclus?: boolean
  ) => {
    try {
      if (applyToCyclus) {
        const slot = calendarSlots.find((s) => s.id === slotId);
        if (slot?.cyclus_id) {
          const { error } = await supabase
            .from("availability_slots")
            .update({ is_marked_full: value })
            .eq("cyclus_id", slot.cyclus_id)
            .gte("start_time", new Date().toISOString());

          if (error) throw error;

          toast({
            title: value
              ? t("calendar.cyclusMarkedFull")
              : t("calendar.cyclusMarkedOpen"),
          });
        }
      } else {
        const { error } = await supabase
          .from("availability_slots")
          .update({ is_marked_full: value })
          .eq("id", slotId);

        if (error) throw error;

        toast({
          title: value
            ? t("calendar.slotMarkedFull")
            : t("calendar.slotMarkedOpen"),
        });
      }
      fetchCalendarSlots();
    } catch (error) {
      console.error("Error toggling marked full:", error);
    }
  };

  const fetchSetupStatus = async () => {
    try {
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id, hourly_rate, use_manual_invoicing')
        .eq('user_id', user?.id)
        .maybeSingle();

      if (!trainerProfile) {
        setSetupLoading(false);
        return;
      }

      const { data: profileData } = await supabase
        .from('profiles')
        .select('bio')
        .eq('user_id', user?.id)
        .maybeSingle();

      const profileComplete = !!(trainerProfile.hourly_rate && profileData?.bio);
      const currentTrainerId = trainerProfile.id;

      const { count: lessonCount } = await supabase
        .from('lessons')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      const hasLessons = (lessonCount || 0) > 0;

      const { count: slotCount } = await supabase
        .from('availability_slots')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      const hasAvailability = (slotCount || 0) > 0;

      const { data: mollieData } = await supabase
        .from('trainer_mollie_accounts')
        .select('onboarding_complete, charges_enabled')
        .eq('trainer_id', currentTrainerId)
        .maybeSingle();

      const clubPaymentInfo = await getClubPaymentInfo(currentTrainerId);

      const paymentsComplete = 
        !!(mollieData?.onboarding_complete && mollieData?.charges_enabled) || 
        !!trainerProfile.use_manual_invoicing ||
        (clubPaymentInfo.isClubTrainer && clubPaymentInfo.clubChargesEnabled);

      const { count: playerCount } = await supabase
        .from('guest_players')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      const hasPlayers = (playerCount || 0) > 0;

      setSetupStatus({
        profileComplete,
        hasLessons,
        hasAvailability,
        paymentsComplete,
        hasPlayers,
        clubPaymentInfo,
      });
    } catch (error) {
      console.error('Error fetching setup status:', error);
    } finally {
      setSetupLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
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

      const { count: guestPlayerCount } = await supabase
        .from('guest_players')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

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

      let openSlotsCount = 0;
      futureSlots?.forEach(slot => {
        const maxParticipants = slot.lessons?.max_participants || 4;
        const confirmedBookings = slot.bookings?.filter((b: { status: string }) => b.status === 'confirmed').length || 0;
        if (confirmedBookings < maxParticipants) {
          openSlotsCount++;
        }
      });

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
      const netEarnings = totalEarnings * 0.9;

      const { count: followerCount } = await supabase
        .from('trainer_followers')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId);

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const { count: profileViews } = await supabase
        .from('trainer_profile_views')
        .select('id', { count: 'exact', head: true })
        .eq('trainer_id', currentTrainerId)
        .gte('viewed_at', thirtyDaysAgo.toISOString());

      setStats({
        totalStudents: guestPlayerCount || 0,
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
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <>
      <main className="container mx-auto px-4 py-8">
        {/* Trial Banner */}
        {subscription && !subscription.isSubscribed && (
          <TrialBanner 
            trialEndsAt={subscription.trialEndsAt}
            onUpgrade={() => navigate('/subscription')}
          />
        )}

        {/* Setup Checklist - Only show if not all complete */}
        {!setupLoading && !(setupStatus.profileComplete && setupStatus.hasLessons && setupStatus.hasAvailability && setupStatus.paymentsComplete && setupStatus.hasPlayers) && (
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

        {/* Calendar Section */}
        <div className="space-y-4">
          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDefaultSlotDate(undefined);
                setDefaultSlotTime(undefined);
                setAddSlotOpen(true);
              }}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.addSlot")}</span>
              <span className="sm:hidden">{t("calendar.addSlot")}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPreselectedCyclusId(undefined);
                setDuplicateCyclusOpen(true);
              }}
              className="gap-2"
            >
              <Copy className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.duplicateCyclus")}</span>
            </Button>
            <Button
              size="sm"
              onClick={() => setBulkCreateOpen(true)}
              className="gap-2"
            >
              <Repeat className="h-4 w-4" />
              <span className="hidden sm:inline">{t("calendar.createCyclus")}</span>
              <span className="sm:hidden">{t("calendar.createCyclus")}</span>
            </Button>
          </div>

          {/* Controls Card */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
                {/* Date Navigation */}
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="icon" onClick={navigatePrevious}>
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <div className="min-w-[120px] sm:min-w-[200px] text-center font-medium text-sm sm:text-base">
                    {getDateRangeLabel()}
                  </div>
                  <Button variant="outline" size="icon" onClick={navigateNext}>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" onClick={goToToday}>
                    {t("calendar.today")}
                  </Button>
                </div>

                {/* View Toggle */}
                <div className="flex items-center gap-1">
                  <Button
                    variant={view === "day" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setView("day")}
                  >
                    <Calendar className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">{t("calendar.dayView")}</span>
                  </Button>
                  <Button
                    variant={view === "week" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setView("week")}
                  >
                    <CalendarDays className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">{t("calendar.weekView")}</span>
                  </Button>
                  <Button
                    variant={view === "month" ? "default" : "outline"}
                    size="sm"
                    onClick={() => setView("month")}
                  >
                    <LayoutGrid className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">{t("calendar.monthView")}</span>
                  </Button>
                </div>
              </div>

              {/* Quick Stats */}
              <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded bg-muted border border-border" />
                  <span className="text-sm">
                    {t("calendar.available")}: {freeSlots}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-300 dark:border-yellow-700" />
                  <span className="text-sm">
                    {t("calendar.pending")}: {pendingSlots}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded bg-green-100 dark:bg-green-900/30 border border-green-300 dark:border-green-700" />
                  <span className="text-sm">
                    {t("calendar.booked")}: {bookedSlots}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Calendar Grid */}
          <Card>
            <CardContent className="p-4">
              {calendarLoading ? (
                <div className="space-y-4">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-[500px] w-full" />
                </div>
              ) : (
                <TrainerCalendarGrid
                  slots={calendarSlots}
                  currentDate={currentDate}
                  view={view}
                  onCellClick={handleCellClick}
                  onBookForPlayer={handleBookForPlayer}
                  onDuplicateCyclus={handleDuplicateCyclus}
                  onDeleteSlot={handleDeleteSlot}
                  onEditBooking={handleEditBooking}
                  onToggleMarkedFull={handleToggleMarkedFull}
                  onNavigatePrevious={navigatePrevious}
                  onNavigateNext={navigateNext}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Slot Type Choice Dialog */}
      <SlotTypeChoiceDialog
        open={slotTypeChoiceOpen}
        onOpenChange={setSlotTypeChoiceOpen}
        onChooseSingleSlot={handleChooseSingleSlot}
        onChooseCyclus={handleChooseCyclus}
      />

      {/* Add Slot Dialog */}
      <AddSlotDialog
        open={addSlotOpen}
        onOpenChange={setAddSlotOpen}
        trainerId={trainerId}
        lessons={lessons}
        defaultDate={defaultSlotDate}
        defaultTime={defaultSlotTime}
        defaultDuration={settings.slot_duration_minutes}
        defaultWeeks={settings.schedule_weeks_ahead}
        onSlotsCreated={handleSlotsCreated}
      />

      {/* Bulk Create Sheet */}
      <BulkCreateSheet
        open={bulkCreateOpen}
        onOpenChange={setBulkCreateOpen}
        trainerId={trainerId}
        lessons={lessons}
        defaultDate={defaultSlotDate}
        defaultTime={defaultSlotTime}
        defaultDuration={settings.slot_duration_minutes}
        defaultWeeks={settings.schedule_weeks_ahead}
        onSlotsCreated={handleSlotsCreated}
      />

      {/* Book for Player Dialog */}
      {selectedSlot && (
        <BookForPlayerDialog
          open={bookForPlayerOpen}
          onOpenChange={(open) => {
            setBookForPlayerOpen(open);
            if (!open) {
              setSelectedSlot(null);
              setSelectedLesson(null);
            }
          }}
          trainerId={trainerId!}
          slot={{
            id: selectedSlot.id,
            start_time: selectedSlot.start_time,
            end_time: selectedSlot.end_time,
            lesson_id: selectedSlot.lesson_id,
            cyclus_id: selectedSlot.cyclus_id,
            cyclus_name: selectedSlot.cyclus_name,
            booked_players: selectedSlot.booked_players,
          }}
          lesson={selectedLesson}
          onBookingCreated={handleSlotsCreated}
        />
      )}

      {/* Duplicate Cyclus Dialog */}
      <DuplicateCyclusDialog
        open={duplicateCyclusOpen}
        onOpenChange={(open) => {
          setDuplicateCyclusOpen(open);
          if (!open) {
            setPreselectedCyclusId(undefined);
          }
        }}
        trainerId={trainerId || ""}
        preselectedCyclusId={preselectedCyclusId}
        onCyclusCreated={handleSlotsCreated}
      />

      {/* Delete Slot Dialog */}
      <DeleteSlotDialog
        open={deleteSlotOpen}
        onOpenChange={(open) => {
          setDeleteSlotOpen(open);
          if (!open) {
            setSlotToDelete(null);
          }
        }}
        slot={slotToDelete}
        trainerId={trainerId || ""}
        onSlotDeleted={handleSlotsCreated}
      />

      {/* Edit Booking Dialog */}
      <EditBookingDialog
        open={editBookingOpen}
        onOpenChange={(open) => {
          setEditBookingOpen(open);
          if (!open) {
            setBookingToEdit(null);
          }
        }}
        booking={bookingToEdit}
        trainerId={trainerId || ""}
        onBookingUpdated={handleSlotsCreated}
      />
    </>
  );
}

// Trial Banner Component
interface TrialBannerProps {
  trialEndsAt: string | null;
  onUpgrade: () => void;
}

function TrialBanner({ trialEndsAt, onUpgrade }: TrialBannerProps) {
  const { t } = useTranslation('trainer');
  const daysRemaining = getTrialDaysRemaining(trialEndsAt);
  const isExpired = daysRemaining === 0;
  
  return (
    <Alert variant={isExpired ? 'destructive' : 'default'} className="mb-6">
      <AlertTriangle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between">
        <span>
          {isExpired 
            ? t('dashboard.trialBanner.expired')
            : daysRemaining === 1
              ? t('dashboard.trialBanner.lastDay')
              : t('dashboard.trialBanner.daysLeft', { days: daysRemaining })
          }
        </span>
        <Button size="sm" variant={isExpired ? 'default' : 'outline'} onClick={onUpgrade}>
          {isExpired ? t('dashboard.trialBanner.subscribe') : t('dashboard.trialBanner.upgrade')}
        </Button>
      </AlertDescription>
    </Alert>
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
  const { t } = useTranslation('trainer');
  const clubInfo = setupStatus.clubPaymentInfo;
  
  let paymentLabel = 'Connect payment account or setup manual payments';
  let paymentSubLabel = '';
  
  if (clubInfo?.isClubTrainer && clubInfo?.clubChargesEnabled) {
    paymentLabel = t('dashboard.setup.steps.payments.clubManaged', { clubName: clubInfo.clubName || 'Your club' });
    paymentSubLabel = t('dashboard.setup.steps.payments.clubManagedDescription');
  } else if (clubInfo?.isClubTrainer && !clubInfo?.clubChargesEnabled) {
    paymentLabel = t('clubPayments.clubNeedsSetup', { clubName: clubInfo.clubName || 'Your club' });
  }
  
  const steps = [
    { key: 'profileComplete', label: 'Complete your profile information', route: '/profile/edit', complete: setupStatus.profileComplete },
    { key: 'hasLessons', label: 'Create your first lesson', route: '/lessons', complete: setupStatus.hasLessons },
    { key: 'hasAvailability', label: 'Create training cyclus or slots', route: '/trainer/calendar', complete: setupStatus.hasAvailability },
    { key: 'paymentsComplete', label: paymentLabel, subLabel: paymentSubLabel, route: '/earnings', complete: setupStatus.paymentsComplete, isClubManaged: clubInfo?.isClubTrainer && clubInfo?.clubChargesEnabled },
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
                      <div className={`h-6 w-6 rounded-full flex items-center justify-center ${(step as any).isClubManaged ? 'bg-blue-500' : 'bg-green-500'}`}>
                        {(step as any).isClubManaged ? (
                          <Building2 className="h-3.5 w-3.5 text-white" />
                        ) : (
                          <Check className="h-4 w-4 text-white" />
                        )}
                      </div>
                    ) : (
                      <div className="h-6 w-6 rounded-full border-2 border-orange-400 flex items-center justify-center text-xs font-medium text-orange-600">
                        {index + 1}
                      </div>
                    )}
                    <div className="flex flex-col">
                      <span className={step.complete ? 'text-muted-foreground line-through' : ''}>
                        {step.label}
                      </span>
                      {(step as any).subLabel && (
                        <span className="text-xs text-blue-600 dark:text-blue-400">
                          {(step as any).subLabel}
                        </span>
                      )}
                    </div>
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
