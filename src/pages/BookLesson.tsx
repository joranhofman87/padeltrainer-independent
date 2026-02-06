import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ArrowLeft, Calendar, Clock, Euro, MapPin, Star, Check, Users, SendHorizontal, FileText, Repeat, AlertCircle, Building2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { format, parseISO } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import { hasValidPaymentSetup } from '@/lib/academyTrainerPayments';

interface BookedPlayerInfo {
  skillRating: number | null;
  ratingSystem: string;
}

interface SlotWithDetails {
  id: string;
  start_time: string;
  end_time: string;
  lesson_id: string | null;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  court_type?: 'indoor' | 'outdoor' | null;
  bookedPlayers?: BookedPlayerInfo[];
  averageRating?: number | null;
  ratingSystem?: string;
  spotsLeft?: number;
  location_id?: string | null;
  location?: {
    id: string;
    name: string;
    city: string;
    street_address: string | null;
  } | null;
  lessons?: {
    id: string;
    title: string;
    description: string | null;
    price: number;
    duration_minutes: number;
    min_skill_rating: number | null;
    max_skill_rating: number | null;
  } | null;
}

interface CyclusBundle {
  cyclus_id: string;
  cyclus_name: string;
  slots: SlotWithDetails[];
  totalPrice: number;
  firstDate: string;
  lastDate: string;
  lesson: SlotWithDetails['lessons'];
  location?: SlotWithDetails['location'];
}

interface TrainerWithProfile {
  id: string;
  hourly_rate: number | null;
  experience_years: number | null;
  specializations: string[] | null;
  require_booking_approval: boolean | null;
  use_manual_invoicing: boolean | null;
  profiles: {
    full_name: string;
    avatar_url: string | null;
    location: string | null;
    bio: string | null;
    email: string | null;
  };
}

export default function BookLesson() {
  const { trainerId } = useParams();
  const { user, profile, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [trainer, setTrainer] = useState<TrainerWithProfile | null>(null);
  const [cyclusBundles, setCyclusBundles] = useState<CyclusBundle[]>([]);
  const [individualSlots, setIndividualSlots] = useState<SlotWithDetails[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithDetails | null>(null);
  const [selectedCyclus, setSelectedCyclus] = useState<CyclusBundle | null>(null);
  const [notes, setNotes] = useState('');
  const [loadingData, setLoadingData] = useState(true);
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [requestSent, setRequestSent] = useState(false);

  useEffect(() => {
    if (!loading) {
      if (!user) {
        navigate(`/auth?redirect=/book/${trainerId}`);
      } else if (role !== 'player') {
        navigate('/trainer');
      }
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (trainerId) {
      fetchData();
    }
  }, [trainerId]);

  const fetchData = async () => {
    // Fetch trainer_profiles and profiles separately (no FK between them for PostgREST join)
    const [trainerResult, profileResult] = await Promise.all([
      supabase
        .from('trainer_profiles_safe')
        .select(`
          id,
          user_id,
          hourly_rate,
          experience_years,
          specializations,
          require_booking_approval,
          use_manual_invoicing
        `)
        .eq('user_id', trainerId)
        .maybeSingle(),
      supabase
        .from('profiles_public')
        .select('full_name, avatar_url, location, bio')
        .eq('user_id', trainerId)
        .maybeSingle()
    ]);

    const trainerData = trainerResult.data;
    const profileData = profileResult.data;

    if (!trainerData) {
      setLoadingData(false);
      return;
    }

    // Fetch trainer's email from profiles table for booking confirmation
    const { data: profileWithEmail } = await supabase
      .from('profiles')
      .select('email')
      .eq('user_id', trainerId)
      .maybeSingle();

    // Combine trainer and profile data
    setTrainer({
      ...trainerData,
      profiles: {
        full_name: profileData?.full_name || 'Trainer',
        avatar_url: profileData?.avatar_url,
        location: profileData?.location,
        bio: profileData?.bio,
        email: profileWithEmail?.email || null
      }
    } as unknown as TrainerWithProfile);

    // Fetch available slots using the trainer's actual id (not user_id)
    // Include cyclus_id and cyclus_name for grouping, and location via location_id
    const { data: slotsData } = await supabase
      .from('availability_slots')
      .select(`
        id,
        start_time,
        end_time,
        lesson_id,
        cyclus_id,
        cyclus_name,
        court_type,
        location_id,
        locations:location_id(id, name, city, street_address),
        lessons(id, title, description, price, duration_minutes, min_skill_rating, max_skill_rating)
      `)
      .eq('trainer_id', trainerData.id)
      .eq('is_marked_full', false)
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true });

    if (slotsData) {
      // Fetch bookings with player ratings for each slot
      const slotIds = slotsData.map((s) => s.id);
      const { data: bookingsData } = await supabase
        .from('bookings')
        .select(`
          slot_id,
          status,
          profiles:player_id (skill_rating, rating_system),
          guest_players:guest_player_id (skill_rating, rating_system)
        `)
        .in('slot_id', slotIds)
        .in('status', ['pending', 'confirmed']);

      // Count bookings per slot and calculate average ratings
      const slotBookingInfo: Record<string, { count: number; ratings: { rating: number; system: string }[] }> = {};
      bookingsData?.forEach((b) => {
        if (!slotBookingInfo[b.slot_id]) {
          slotBookingInfo[b.slot_id] = { count: 0, ratings: [] };
        }
        slotBookingInfo[b.slot_id].count++;
        
        const profile = b.profiles as { skill_rating: number | null; rating_system: string } | null;
        const guestPlayer = b.guest_players as { skill_rating: number | null; rating_system: string } | null;
        const rating = profile?.skill_rating ?? guestPlayer?.skill_rating;
        const system = profile?.rating_system || guestPlayer?.rating_system || 'knltb';
        
        if (rating != null) {
          slotBookingInfo[b.slot_id].ratings.push({ rating, system });
        }
      });

      // Build available slots with cyclus info
      const availableSlots = slotsData
        .filter((s) => (slotBookingInfo[s.id]?.count || 0) < 4)
        .map((s) => {
          const info = slotBookingInfo[s.id];
          const bookingCount = info?.count || 0;
          const ratings = info?.ratings || [];
          
          let averageRating: number | null = null;
          let ratingSystem: string | undefined = undefined;
          
          if (ratings.length > 0) {
            const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
            averageRating = sum / ratings.length;
            ratingSystem = ratings[0].system;
          }
          
          return {
            ...s,
            location: s.locations as SlotWithDetails['location'],
            spotsLeft: 4 - bookingCount,
            averageRating,
            ratingSystem,
          } as SlotWithDetails;
        });

      // Group slots by cyclus_id
      const cyclusGroups: Record<string, SlotWithDetails[]> = {};
      const standaloneSlots: SlotWithDetails[] = [];

      // Also count total slots per cyclus (including ones with bookings)
      const totalSlotsPerCyclus: Record<string, number> = {};
      slotsData.forEach((s) => {
        if (s.cyclus_id) {
          totalSlotsPerCyclus[s.cyclus_id] = (totalSlotsPerCyclus[s.cyclus_id] || 0) + 1;
        }
      });

      availableSlots.forEach((slot) => {
        if (slot.cyclus_id) {
          if (!cyclusGroups[slot.cyclus_id]) {
            cyclusGroups[slot.cyclus_id] = [];
          }
          cyclusGroups[slot.cyclus_id].push(slot);
        } else {
          standaloneSlots.push(slot);
        }
      });

      // Create bundles for full cycluses, individual slots for partial ones
      const bundles: CyclusBundle[] = [];
      const partialCyclusSlots: SlotWithDetails[] = [];

      Object.entries(cyclusGroups).forEach(([cyclusId, cyclusSlots]) => {
        const totalInCyclus = totalSlotsPerCyclus[cyclusId] || cyclusSlots.length;
        
        // If ALL slots in cyclus are available (no bookings on any)
        if (cyclusSlots.length === totalInCyclus) {
          const sortedSlots = cyclusSlots.sort((a, b) => 
            new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
          );
          const totalPrice = sortedSlots.reduce((sum, s) => 
            sum + (s.lessons?.price || 0), 0
          );
          
          bundles.push({
            cyclus_id: cyclusId,
            cyclus_name: sortedSlots[0].cyclus_name || 'Training Cycle',
            slots: sortedSlots,
            totalPrice,
            firstDate: sortedSlots[0].start_time,
            lastDate: sortedSlots[sortedSlots.length - 1].start_time,
            lesson: sortedSlots[0].lessons,
            location: sortedSlots[0].location,
          });
        } else {
          // Partial cyclus - show remaining slots individually
          partialCyclusSlots.push(...cyclusSlots);
        }
      });

      setCyclusBundles(bundles);
      setIndividualSlots([...standaloneSlots, ...partialCyclusSlots]);
    }

    setLoadingData(false);
  };

  const handleBook = async () => {
    if ((!selectedSlot && !selectedCyclus) || !profile?.id || !trainer) return;

    // Get the lesson to check skill requirements
    const lesson = selectedCyclus ? selectedCyclus.lesson : selectedSlot?.lessons;
    
    // Check skill rating requirements
    if (lesson) {
      const playerRating = profile.skill_rating;
      if (lesson.min_skill_rating && (!playerRating || playerRating < lesson.min_skill_rating)) {
        toast({
          title: 'Rating Too Low',
          description: `This lesson requires a minimum rating of ${lesson.min_skill_rating}`,
          variant: 'destructive',
        });
        return;
      }
      if (lesson.max_skill_rating && playerRating && playerRating > lesson.max_skill_rating) {
        toast({
          title: 'Rating Too High',
          description: `This lesson is for players with rating up to ${lesson.max_skill_rating}`,
          variant: 'destructive',
        });
        return;
      }
    }

    setBooking(true);

    try {
      // Handle cyclus bundle booking
      if (selectedCyclus) {
        const requiresApproval = trainer.require_booking_approval;
        const useManualInvoicing = trainer.use_manual_invoicing;
        
        // Create bookings for all slots in the cyclus
        const bookings = selectedCyclus.slots.map((slot) => ({
          player_id: profile.id,
          slot_id: slot.id,
          lesson_id: slot.lesson_id,
          notes: notes || null,
          status: requiresApproval ? 'pending_approval' : (useManualInvoicing ? 'confirmed' : 'pending'),
          payment_status: 'pending',
        }));

        const { error } = await supabase.from('bookings').insert(bookings);
        if (error) throw error;

        // Send appropriate email
        const firstSlot = selectedCyclus.slots[0];
        const firstDate = format(parseISO(firstSlot.start_time), 'EEE, MMM d, yyyy');
        const firstTime = format(parseISO(firstSlot.start_time), 'HH:mm');

        if (requiresApproval) {
          await supabase.functions.invoke('send-email', {
            body: {
              type: 'booking_request',
              to: trainer.profiles.email,
              data: {
                trainerName: trainer.profiles.full_name,
                playerName: profile.full_name,
                playerEmail: profile.email,
                lessonTitle: `${selectedCyclus.cyclus_name} (${selectedCyclus.slots.length} sessions)`,
                lessonDate: firstDate,
                lessonTime: firstTime,
                location: selectedCyclus.location ? `${selectedCyclus.location.name}, ${selectedCyclus.location.city}` : null,
                price: selectedCyclus.totalPrice,
              },
            },
          });
          setRequestSent(true);
          toast({
            title: 'Request Sent!',
            description: `Your booking request for ${selectedCyclus.slots.length} sessions has been sent.`,
          });
        } else {
          await supabase.functions.invoke('send-email', {
            body: {
              type: 'manual_booking_confirmation',
              to: profile.email,
              data: {
                playerName: profile.full_name,
                trainerName: trainer.profiles.full_name,
                lessonTitle: `${selectedCyclus.cyclus_name} (${selectedCyclus.slots.length} sessions)`,
                lessonDate: firstDate,
                lessonTime: firstTime,
                location: selectedCyclus.location ? `${selectedCyclus.location.name}, ${selectedCyclus.location.city}` : null,
                price: selectedCyclus.totalPrice,
              },
            },
          });
          setBooked(true);
        }
        return;
      }

      // Handle single slot booking (existing logic)
      if (!selectedSlot) return;
      
      const price = selectedSlot.lessons?.price || trainer.hourly_rate || 50;
      const requiresApproval = trainer.require_booking_approval;
      const useManualInvoicing = trainer.use_manual_invoicing;

      if (requiresApproval) {
        // Create booking with pending_approval status
        const { data: bookingData, error } = await supabase
          .from('bookings')
          .insert({
            player_id: profile.id,
            slot_id: selectedSlot.id,
            lesson_id: selectedSlot.lesson_id,
            notes: notes || null,
            status: 'pending_approval',
            payment_status: 'pending',
          })
          .select()
          .single();

        if (error) throw error;

        // Send email to trainer about the request
        const lessonDate = format(parseISO(selectedSlot.start_time), 'EEE, MMM d, yyyy');
        const lessonTime = format(parseISO(selectedSlot.start_time), 'HH:mm');
        
        await supabase.functions.invoke('send-email', {
          body: {
            type: 'booking_request',
            to: trainer.profiles.email,
            data: {
              trainerName: trainer.profiles.full_name,
              playerName: profile.full_name,
              playerEmail: profile.email,
              lessonTitle: selectedSlot.lessons?.title || 'Training Session',
              lessonDate,
              lessonTime,
              location: selectedSlot.location ? `${selectedSlot.location.name}, ${selectedSlot.location.city}` : null,
              price,
            },
          },
        });

        setRequestSent(true);
        toast({
          title: 'Request Sent!',
          description: 'The trainer will review your booking request.',
        });
      } else if (useManualInvoicing) {
        // Auto-accept with manual invoicing - confirm immediately
        const { data: bookingData, error } = await supabase
          .from('bookings')
          .insert({
            player_id: profile.id,
            slot_id: selectedSlot.id,
            lesson_id: selectedSlot.lesson_id,
            notes: notes || null,
            status: 'confirmed',
            payment_status: 'pending',
          })
          .select()
          .single();

        if (error) throw error;

        // Send confirmation email to player
        const lessonDate = format(parseISO(selectedSlot.start_time), 'EEE, MMM d, yyyy');
        const lessonTime = format(parseISO(selectedSlot.start_time), 'HH:mm');

        await supabase.functions.invoke('send-email', {
          body: {
            type: 'manual_booking_confirmation',
            to: profile.email,
            data: {
              playerName: profile.full_name,
              trainerName: trainer.profiles.full_name,
              lessonTitle: selectedSlot.lessons?.title || 'Training Session',
              lessonDate,
              lessonTime,
              location: selectedSlot.location ? `${selectedSlot.location.name}, ${selectedSlot.location.city}` : null,
              price,
            },
          },
        });

        setBooked(true);
      } else {
        // Auto-accept with Mollie payment (existing flow)
        // First, check if trainer/club has valid payment setup
        const paymentSetup = await hasValidPaymentSetup(
          trainerId!,
          trainer.id,
          trainer.use_manual_invoicing ?? false
        );

        if (!paymentSetup.valid) {
          toast({
            title: 'Payment Not Available',
            description: paymentSetup.message || 'This trainer has not set up payments yet',
            variant: 'destructive',
          });
          setBooking(false);
          return;
        }

        const { data: bookingData, error } = await supabase
          .from('bookings')
          .insert({
            player_id: profile.id,
            slot_id: selectedSlot.id,
            lesson_id: selectedSlot.lesson_id,
            notes: notes || null,
            status: 'pending',
            payment_status: 'pending',
          })
          .select()
          .single();

        if (error) throw error;

        // Create Mollie payment
        const { data: paymentData, error: paymentError } = await supabase.functions.invoke(
          'create-mollie-payment',
          {
            body: {
              slotId: selectedSlot.id,
              amount: price,
              description: selectedSlot.lessons?.title || 'Training Session',
              trainerId: trainer.id,
            },
          }
        );

        if (paymentError) throw paymentError;

        if (paymentData?.checkoutUrl) {
          // Redirect to Mollie Checkout
          window.location.href = paymentData.checkoutUrl;
        } else {
          throw new Error('No checkout URL received');
        }
      }
    } catch (error: any) {
      console.error('Booking error:', error);
      toast({
        title: 'Booking Failed',
        description: error.message || 'Could not complete booking',
        variant: 'destructive',
      });
      setBooking(false);
    }
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!trainer) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="p-8 text-center">
          <h2 className="text-xl font-semibold mb-2">Trainer not found</h2>
          <Button onClick={() => navigate('/player')}>Browse Trainers</Button>
        </Card>
      </div>
    );
  }

  if (requestSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900 flex items-center justify-center mx-auto mb-4">
            <SendHorizontal className="h-8 w-8 text-blue-600" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Request Sent!</h2>
          <p className="text-muted-foreground mb-6">
            Your booking request has been sent to {trainer.profiles.full_name}.
            You'll be notified once they respond.
          </p>
          <div className="space-y-3">
            <Button className="w-full" onClick={() => navigate('/player/bookings')}>
              View My Bookings
            </Button>
            <Button variant="outline" className="w-full" onClick={() => navigate('/player')}>
              Browse Other Trainers
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  if (booked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mx-auto mb-4">
            <Check className="h-8 w-8 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold mb-2">Booking Confirmed!</h2>
          <p className="text-muted-foreground mb-6">
            Your lesson with {trainer.profiles.full_name} has been booked.
            You'll receive a confirmation soon.
          </p>
          {trainer.use_manual_invoicing && (
            <div className="p-3 bg-amber-50 dark:bg-amber-950 rounded-lg mb-4 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
              <FileText className="h-4 w-4" />
              You'll receive an invoice from the trainer for payment.
            </div>
          )}
          <div className="space-y-3">
            <Button className="w-full" onClick={() => navigate('/player/bookings')}>
              View My Bookings
            </Button>
            <Button variant="outline" className="w-full" onClick={() => navigate('/player')}>
              Book Another Lesson
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const initials = trainer.profiles.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'T';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">Book a Lesson</h1>
            <p className="text-sm text-muted-foreground">with {trainer.profiles.full_name}</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-[1fr_400px] gap-8">
          {/* Trainer Info & Slots */}
          <div className="space-y-6">
            {/* Trainer Card */}
            <Card>
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={trainer.profiles.avatar_url || undefined} />
                    <AvatarFallback className="text-xl">{initials}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <h2 className="text-xl font-semibold">{trainer.profiles.full_name}</h2>
                    {trainer.profiles.location && (
                      <p className="text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-4 w-4" />
                        {trainer.profiles.location}
                      </p>
                    )}
                    {trainer.specializations && trainer.specializations.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {trainer.specializations.map((spec, i) => (
                          <span
                            key={i}
                            className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded"
                          >
                            {spec}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Training Cycle Bundles */}
            {cyclusBundles.length > 0 && (
              <div className="mb-6">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <Repeat className="h-5 w-5 text-primary" />
                  Training Cycles
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {cyclusBundles.map((cyclus) => {
                    const lesson = cyclus.lesson;
                    const playerRating = profile?.skill_rating;
                    const isTooLow = lesson?.min_skill_rating && (!playerRating || playerRating < lesson.min_skill_rating);
                    const isTooHigh = lesson?.max_skill_rating && playerRating && playerRating > lesson.max_skill_rating;
                    const isIneligible = isTooLow || isTooHigh;
                    const hasRatingRequirement = lesson?.min_skill_rating || lesson?.max_skill_rating;

                    return (
                      <Card
                        key={cyclus.cyclus_id}
                        className={`transition-all ${
                          isIneligible 
                            ? 'opacity-60 cursor-not-allowed border-muted'
                            : selectedCyclus?.cyclus_id === cyclus.cyclus_id
                              ? 'ring-2 ring-primary border-primary cursor-pointer'
                              : 'hover:border-primary/50 cursor-pointer'
                        }`}
                        onClick={() => {
                          if (!isIneligible) {
                            setSelectedCyclus(cyclus);
                            setSelectedSlot(null);
                          }
                        }}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Repeat className="h-4 w-4 text-primary" />
                              <span className="font-semibold">{cyclus.cyclus_name}</span>
                            </div>
                            {selectedCyclus?.cyclus_id === cyclus.cyclus_id && !isIneligible && (
                              <Check className="h-5 w-5 text-primary" />
                            )}
                          </div>
                          <Badge variant="secondary" className="mb-2">
                            {cyclus.slots.length} sessions
                          </Badge>
                          <p className="text-sm text-muted-foreground mb-2">
                            {format(parseISO(cyclus.firstDate), 'MMM d')} - {format(parseISO(cyclus.lastDate), 'MMM d, yyyy')}
                          </p>
                          {cyclus.lesson && (
                            <>
                              <p className="text-sm font-medium mb-1">{cyclus.lesson.title}</p>
                              {cyclus.location && (
                                <p className="text-xs text-muted-foreground flex items-center gap-1 mb-1">
                                  <MapPin className="h-3 w-3" />
                                  {cyclus.location.name}, {cyclus.location.city}
                                </p>
                              )}
                            </>
                          )}
                          
                          {/* Rating requirement */}
                          {hasRatingRequirement && (
                            <div className={`flex items-center gap-2 text-xs mt-2 ${isIneligible ? 'text-destructive' : 'text-muted-foreground'}`}>
                              <Star className="h-3 w-3" />
                              <span>
                                Level: {lesson?.min_skill_rating || '0'} - {lesson?.max_skill_rating || '∞'}
                              </span>
                              {isIneligible && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger>
                                      <AlertCircle className="h-3 w-3" />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>Your rating ({playerRating || 'none'}) is {isTooLow ? 'below' : 'above'} the required range</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </div>
                          )}
                          
                          <div className="flex items-center gap-2 pt-2 border-t mt-2">
                            <Euro className="h-4 w-4 text-primary" />
                            <span className="font-semibold text-primary">
                              €{cyclus.totalPrice}
                            </span>
                            <span className="text-xs text-muted-foreground">total</span>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Individual Slots */}
            <div>
              <h3 className="text-lg font-semibold mb-4">
                {cyclusBundles.length > 0 ? 'Individual Sessions' : 'Available Time Slots'}
              </h3>
              {individualSlots.length === 0 && cyclusBundles.length === 0 ? (
                <Card className="p-8 text-center">
                  <p className="text-muted-foreground">No available slots at the moment</p>
                </Card>
              ) : individualSlots.length === 0 ? (
                <p className="text-sm text-muted-foreground">No individual sessions available</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {individualSlots.map((slot) => {
                    const lesson = slot.lessons;
                    const playerRating = profile?.skill_rating;
                    const isTooLow = lesson?.min_skill_rating && (!playerRating || playerRating < lesson.min_skill_rating);
                    const isTooHigh = lesson?.max_skill_rating && playerRating && playerRating > lesson.max_skill_rating;
                    const isIneligible = isTooLow || isTooHigh;
                    const hasRatingRequirement = lesson?.min_skill_rating || lesson?.max_skill_rating;

                    return (
                      <Card
                        key={slot.id}
                        className={`transition-all ${
                          isIneligible 
                            ? 'opacity-60 cursor-not-allowed border-muted'
                            : selectedSlot?.id === slot.id
                              ? 'ring-2 ring-primary border-primary cursor-pointer'
                              : 'hover:border-primary/50 cursor-pointer'
                        }`}
                        onClick={() => {
                          if (!isIneligible) {
                            setSelectedSlot(slot);
                            setSelectedCyclus(null);
                          }
                        }}
                      >
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <Calendar className="h-4 w-4 text-muted-foreground" />
                              <span className="font-medium">
                                {format(parseISO(slot.start_time), 'EEE, MMM d')}
                              </span>
                            </div>
                            {selectedSlot?.id === slot.id && !isIneligible && (
                              <Check className="h-5 w-5 text-primary" />
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                            <Clock className="h-4 w-4" />
                            {format(parseISO(slot.start_time), 'HH:mm')} -{' '}
                            {format(parseISO(slot.end_time), 'HH:mm')}
                          </div>
                          {slot.lessons && (
                            <div className="pt-2 border-t">
                              <p className="font-medium text-sm">{slot.lessons.title}</p>
                              {slot.location && (
                                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                                  <MapPin className="h-3 w-3" />
                                  {slot.location.name}, {slot.location.city}
                                </p>
                              )}
                              {slot.court_type && (
                                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                                  {slot.court_type === 'indoor' ? '🏠' : '☀️'}{' '}
                                  {slot.court_type === 'indoor' ? 'Indoor' : 'Outdoor'}
                                </p>
                              )}
                              <div className="flex items-center gap-2 mt-1">
                                <Euro className="h-4 w-4 text-primary" />
                                <span className="font-semibold text-primary">
                                  €{slot.lessons.price}
                                </span>
                              </div>
                            </div>
                          )}
                          
                          {/* Rating requirement */}
                          {hasRatingRequirement && (
                            <div className={`flex items-center gap-2 text-xs mt-2 ${isIneligible ? 'text-destructive' : 'text-muted-foreground'}`}>
                              <Star className="h-3 w-3" />
                              <span>
                                Level: {lesson?.min_skill_rating || '0'} - {lesson?.max_skill_rating || '∞'}
                              </span>
                              {isIneligible && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger>
                                      <AlertCircle className="h-3 w-3" />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>Your rating ({playerRating || 'none'}) is {isTooLow ? 'below' : 'above'} the required range</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                            </div>
                          )}
                          
                          {/* Spots left and Average Level */}
                          <div className="flex items-center justify-between mt-2 pt-2 border-t">
                            <div className="flex items-center gap-1 text-sm text-muted-foreground">
                              <Users className="h-4 w-4" />
                              <span>{slot.spotsLeft || 4}/4 spots left</span>
                            </div>
                            {slot.averageRating !== null && slot.averageRating !== undefined && (
                              <div className="flex items-center gap-1">
                                <Badge variant="secondary" className="text-xs">
                                  Avg: {slot.averageRating.toFixed(1)}
                                </Badge>
                                <span className="text-xs text-muted-foreground uppercase">
                                  {slot.ratingSystem || 'knltb'}
                                </span>
                              </div>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Booking Summary */}
          <div className="lg:sticky lg:top-24 h-fit">
            <Card>
              <CardHeader>
                <CardTitle>Booking Summary</CardTitle>
                <CardDescription>Review your lesson booking</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedCyclus ? (
                  <>
                    <div className="p-4 bg-muted rounded-lg space-y-2">
                      <div className="flex items-center gap-2 mb-2">
                        <Repeat className="h-4 w-4 text-primary" />
                        <p className="font-semibold">{selectedCyclus.cyclus_name}</p>
                      </div>
                      <Badge variant="secondary" className="mb-2">
                        {selectedCyclus.slots.length} sessions
                      </Badge>
                      {selectedCyclus.lesson && (
                        <p className="text-sm">{selectedCyclus.lesson.title}</p>
                      )}
                      <div className="text-sm text-muted-foreground space-y-1 mt-2 max-h-32 overflow-y-auto">
                        {selectedCyclus.slots.map((slot) => (
                          <p key={slot.id} className="flex items-center gap-2">
                            <Calendar className="h-3 w-3" />
                            {format(parseISO(slot.start_time), 'EEE, MMM d')} at {format(parseISO(slot.start_time), 'HH:mm')}
                          </p>
                        ))}
                      </div>
                      {selectedCyclus.location && (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground mt-2">
                          <MapPin className="h-4 w-4" />
                          {selectedCyclus.location.name}, {selectedCyclus.location.city}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="notes">Notes for trainer (optional)</Label>
                      <Textarea
                        id="notes"
                        placeholder="Any special requests or information..."
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                      />
                    </div>

                    <div className="border-t pt-4">
                      <div className="flex justify-between items-center text-lg font-semibold">
                        <span>Total ({selectedCyclus.slots.length} sessions)</span>
                        <span>€{selectedCyclus.totalPrice}</span>
                      </div>
                    </div>

                    <Button
                      className="w-full"
                      size="lg"
                      onClick={handleBook}
                      disabled={booking}
                    >
                      {booking ? 'Booking...' : `Book Entire Cycle (${selectedCyclus.slots.length} sessions)`}
                    </Button>
                  </>
                ) : selectedSlot ? (
                  <>
                    <div className="p-4 bg-muted rounded-lg space-y-2">
                      <p className="font-semibold">
                        {selectedSlot.lessons?.title || 'Training Session'}
                      </p>
                      <div className="text-sm text-muted-foreground space-y-1">
                        <p className="flex items-center gap-2">
                          <Calendar className="h-4 w-4" />
                          {format(parseISO(selectedSlot.start_time), 'EEEE, MMMM d, yyyy')}
                        </p>
                        <p className="flex items-center gap-2">
                          <Clock className="h-4 w-4" />
                          {format(parseISO(selectedSlot.start_time), 'HH:mm')} -{' '}
                          {format(parseISO(selectedSlot.end_time), 'HH:mm')}
                        </p>
                        {selectedSlot.location && (
                          <p className="flex items-center gap-2">
                            <MapPin className="h-4 w-4" />
                            {selectedSlot.location.name}, {selectedSlot.location.city}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="notes">Notes for trainer (optional)</Label>
                      <Textarea
                        id="notes"
                        placeholder="Any special requests or information..."
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                      />
                    </div>

                    <div className="border-t pt-4">
                      <div className="flex justify-between items-center text-lg font-semibold">
                        <span>Total</span>
                        <span>
                          €{selectedSlot.lessons?.price || trainer.hourly_rate || 50}
                        </span>
                      </div>
                    </div>

                    <Button
                      className="w-full"
                      size="lg"
                      onClick={handleBook}
                      disabled={booking}
                    >
                      {booking ? 'Booking...' : 'Confirm Booking'}
                    </Button>
                  </>
                ) : (
                  <p className="text-muted-foreground text-center py-8">
                    Select a time slot or training cycle to continue
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
