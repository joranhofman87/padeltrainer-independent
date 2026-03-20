import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { logger } from '@/lib/logger';
import { trackEvent } from '@/lib/tracking';
import FeatureErrorBoundary from '@/components/FeatureErrorBoundary';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import { hasValidPaymentSetup } from '@/lib/academyTrainerPayments';
import { getApplicableTerms } from '@/lib/terms';
import { formatPrice } from '@/lib/pricing';
import { useTranslation } from 'react-i18next';
import { BookingConfirmation } from '@/components/booking/BookingConfirmation';
import { BookingTrainerCard } from '@/components/booking/BookingTrainerCard';
import { CycleBundleList } from '@/components/booking/CycleBundleList';
import { SlotList } from '@/components/booking/SlotList';
import { BookingSummary } from '@/components/booking/BookingSummary';

interface BookedPlayerInfo {
  skillRating: number | null;
  ratingSystem: string;
}

interface SlotWithDetails {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id?: string | null;
  cyclus_name?: string | null;
  court_type?: 'indoor' | 'outdoor' | null;
  price_per_session?: number | null;
  max_participants?: number | null;
  allow_single_booking?: boolean | null;
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
  rating_system?: string | null;
  min_rating?: number | null;
  max_rating?: number | null;
}

interface CyclusBundle {
  cyclus_id: string;
  cyclus_name: string;
  slots: SlotWithDetails[];
  totalPrice: number;
  firstDate: string;
  lastDate: string;
  location?: SlotWithDetails['location'];
  min_group_size?: number;
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
  const { t } = useTranslation('player');

  const [trainer, setTrainer] = useState<TrainerWithProfile | null>(null);
  const [cyclusBundles, setCyclusBundles] = useState<CyclusBundle[]>([]);
  const [individualSlots, setIndividualSlots] = useState<SlotWithDetails[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithDetails | null>(null);
  const [selectedCyclus, setSelectedCyclus] = useState<CyclusBundle | null>(null);
  const [notes, setNotes] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [loadingData, setLoadingData] = useState(true);
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [applicableTerms, setApplicableTerms] = useState<string | null>(null);
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [cycleSettingsMap, setCycleSettingsMap] = useState<Record<string, { min_group_size?: number; payment_timing?: string; invoice_delay_weeks?: number; mark_as_paid?: boolean }>>({});

  useEffect(() => {
    if (!loading && user && role !== 'player') {
      navigate('/app/trainer');
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    if (trainerId) {
      trackEvent('booking_page_viewed', { trainer_id: trainerId });
      fetchData();
    }
  }, [trainerId]);

  const fetchData = async () => {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trainerId!);

    const trainerResult = await supabase
      .from('trainer_profiles_safe')
      .select(`id, user_id, hourly_rate, experience_years, specializations, require_booking_approval, use_manual_invoicing`)
      .eq(isUUID ? 'user_id' : 'slug', trainerId!)
      .maybeSingle();

    const trainerData = trainerResult.data;
    if (!trainerData) { setLoadingData(false); return; }

    const resolvedUserId = trainerData.user_id;
    const [profileResult, profileWithEmailResult] = await Promise.all([
      supabase.from('profiles_public').select('full_name, avatar_url, location, bio').eq('user_id', resolvedUserId).maybeSingle(),
      supabase.from('profiles').select('email').eq('user_id', resolvedUserId).maybeSingle()
    ]);

    const profileData = profileResult.data;
    const profileWithEmail = profileWithEmailResult.data;

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

    const { data: slotsData } = await supabase
      .from('availability_slots')
      .select(`id, start_time, end_time, cyclus_id, cyclus_name, court_type, price_per_session, max_participants, allow_single_booking, location_id, rating_system, min_rating, max_rating, locations:location_id(id, name, city, street_address)`)
      .eq('trainer_id', trainerData.id)
      .eq('is_marked_full', false)
      .eq('is_public', true)
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true });

    if (slotsData) {
      const slotIds = slotsData.map((s) => s.id);
      const { data: bookingsData } = await supabase
        .from('bookings')
        .select(`slot_id, status, profiles:player_id (skill_rating, rating_system), guest_players:guest_player_id (skill_rating, rating_system)`)
        .in('slot_id', slotIds)
        .in('status', ['pending', 'confirmed']);

      const slotBookingInfo: Record<string, { count: number; ratings: { rating: number; system: string }[] }> = {};
      bookingsData?.forEach((b) => {
        if (!slotBookingInfo[b.slot_id]) slotBookingInfo[b.slot_id] = { count: 0, ratings: [] };
        slotBookingInfo[b.slot_id].count++;
        const prof = b.profiles as { skill_rating: number | null; rating_system: string } | null;
        const guestPlayer = b.guest_players as { skill_rating: number | null; rating_system: string } | null;
        const rating = prof?.skill_rating ?? guestPlayer?.skill_rating;
        const system = prof?.rating_system || guestPlayer?.rating_system || 'knltb';
        if (rating != null) slotBookingInfo[b.slot_id].ratings.push({ rating, system });
      });

      const availableSlots = slotsData
        .filter((s) => {
          const maxP = (s as any).max_participants || 4;
          return (slotBookingInfo[s.id]?.count || 0) < maxP;
        })
        .map((s) => {
          const info = slotBookingInfo[s.id];
          const bookingCount = info?.count || 0;
          const ratings = info?.ratings || [];
          const maxP = (s as any).max_participants || 4;
          let averageRating: number | null = null;
          let ratingSystem: string | undefined = undefined;
          if (ratings.length > 0) {
            averageRating = ratings.reduce((acc, r) => acc + r.rating, 0) / ratings.length;
            ratingSystem = ratings[0].system;
          }
          return { ...s, location: s.locations as SlotWithDetails['location'], spotsLeft: maxP - bookingCount, averageRating, ratingSystem } as SlotWithDetails;
        });

      const cyclusGroups: Record<string, SlotWithDetails[]> = {};
      const standaloneSlots: SlotWithDetails[] = [];
      const totalSlotsPerCyclus: Record<string, number> = {};
      const cyclusIds: string[] = [];
      slotsData.forEach((s) => {
        if (s.cyclus_id) {
          totalSlotsPerCyclus[s.cyclus_id] = (totalSlotsPerCyclus[s.cyclus_id] || 0) + 1;
          if (!cyclusIds.includes(s.cyclus_id)) cyclusIds.push(s.cyclus_id);
        }
      });

      let newCycleSettingsMap: Record<string, { min_group_size?: number; payment_timing?: string; invoice_delay_weeks?: number; mark_as_paid?: boolean }> = {};
      if (cyclusIds.length > 0) {
        const { data: cyclesData } = await supabase.from('cycles').select('id, settings').in('id', cyclusIds);
        if (cyclesData) {
          for (const c of cyclesData) {
            const settings = c.settings as Record<string, unknown> | null;
            newCycleSettingsMap[c.id] = {
              min_group_size: (settings?.min_group_size as number) || undefined,
              payment_timing: (settings?.payment_timing as string) || undefined,
              invoice_delay_weeks: (settings?.invoice_delay_weeks as number) || undefined,
              mark_as_paid: (settings?.mark_as_paid as boolean) || undefined,
            };
          }
        }
      }
      setCycleSettingsMap(newCycleSettingsMap);

      availableSlots.forEach((slot) => {
        if (slot.cyclus_id) {
          if (!cyclusGroups[slot.cyclus_id]) cyclusGroups[slot.cyclus_id] = [];
          cyclusGroups[slot.cyclus_id].push(slot);
        } else {
          standaloneSlots.push(slot);
        }
      });

      const bundles: CyclusBundle[] = [];
      const partialCyclusSlots: SlotWithDetails[] = [];
      Object.entries(cyclusGroups).forEach(([cyclusId, cyclusSlots]) => {
        const totalInCyclus = totalSlotsPerCyclus[cyclusId] || cyclusSlots.length;
        if (cyclusSlots.length === totalInCyclus) {
          const sortedSlots = cyclusSlots.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
          const totalPrice = sortedSlots.reduce((sum, s) => sum + (s.price_per_session || 0), 0);
          bundles.push({
            cyclus_id: cyclusId, cyclus_name: sortedSlots[0].cyclus_name || 'Training Cycle',
            slots: sortedSlots, totalPrice,
            firstDate: sortedSlots[0].start_time, lastDate: sortedSlots[sortedSlots.length - 1].start_time,
            location: sortedSlots[0].location, min_group_size: newCycleSettingsMap[cyclusId]?.min_group_size,
          });
        } else {
          partialCyclusSlots.push(...cyclusSlots);
        }
      });

      setCyclusBundles(bundles);
      setIndividualSlots([...standaloneSlots, ...partialCyclusSlots]);
    }

    if (trainerData?.id) {
      setTermsLoading(true);
      try {
        const { terms } = await getApplicableTerms(trainerData.id);
        setApplicableTerms(terms);
      } catch (e) {
        logger.error('Error fetching terms', e as Error, { component: 'BookLesson' });
      } finally {
        setTermsLoading(false);
      }
    }
    setLoadingData(false);
  };

  const getSlotPrice = (slot: SlotWithDetails) => slot.price_per_session || trainer?.hourly_rate || 0;

  const handleBook = async () => {
    if ((!selectedSlot && !selectedCyclus) || !profile?.id || !trainer) return;

    if (applicableTerms && !termsAccepted) {
      toast({ title: t('bookLesson.termsRequired'), description: t('bookLesson.termsRequiredDescription'), variant: 'destructive' });
      return;
    }

    setBooking(true);
    trackEvent('booking_payment_initiated', {
      trainer_id: trainer.id, type: selectedCyclus ? 'cycle' : 'single',
      slot_id: selectedSlot?.id ?? selectedCyclus?.cyclus_id ?? undefined,
    });

    try {
      if (selectedCyclus) {
        const requiresApproval = trainer.require_booking_approval;
        const useManualInvoicing = trainer.use_manual_invoicing;
        const cycleSettings = cycleSettingsMap[selectedCyclus.cyclus_id];
        const paymentTiming = cycleSettings?.payment_timing || (cycleSettings?.mark_as_paid ? 'manual' : (useManualInvoicing ? 'manual' : 'upfront'));

        const bookings = selectedCyclus.slots.map((slot) => ({
          player_id: profile.id, slot_id: slot.id, notes: notes || null,
          status: requiresApproval ? 'pending_approval' : (paymentTiming !== 'upfront' ? 'confirmed' : 'pending'),
          payment_status: paymentTiming === 'manual' ? 'pending' : 'pending',
          paid_externally: paymentTiming === 'manual' ? true : undefined,
        }));

        const { data: insertedBookings, error } = await supabase.from('bookings').insert(bookings).select('id');
        if (error) throw error;

        try {
          await supabase.functions.invoke('slack-notify', {
            body: { event: 'booking_created', data: { player: profile.full_name, trainer: trainer.profiles.full_name, type: 'Cycle', sessions: selectedCyclus.slots.length, price: `€${selectedCyclus.totalPrice}` } },
          });
        } catch { logger.warn('Slack notification failed (non-fatal)', { component: 'BookLesson' }); }

        if (paymentTiming === 'manual' && insertedBookings?.length) {
          try { await supabase.functions.invoke('auto-create-invoice', { body: { bookingIds: insertedBookings.map(b => b.id) } }); }
          catch (invoiceErr) { logger.error('Auto-create invoice failed (non-fatal)', invoiceErr as Error, { component: 'BookLesson', action: 'auto-invoice-cyclus' }); }
        }

        const firstSlot = selectedCyclus.slots[0];
        const firstDate = format(parseISO(firstSlot.start_time), 'EEE, MMM d, yyyy');
        const firstTime = format(parseISO(firstSlot.start_time), 'HH:mm');

        if (requiresApproval) {
          await supabase.functions.invoke('send-email', {
            body: { type: 'booking_request', to: trainer.profiles.email, data: {
              trainerName: trainer.profiles.full_name, playerName: profile.full_name, playerEmail: profile.email,
              lessonTitle: `${selectedCyclus.cyclus_name} (${selectedCyclus.slots.length} sessions)`,
              lessonDate: firstDate, lessonTime: firstTime,
              location: selectedCyclus.location ? `${selectedCyclus.location.name}, ${selectedCyclus.location.city}` : null,
              price: selectedCyclus.totalPrice,
            }},
          });
          setRequestSent(true);
          toast({ title: t('bookLesson.requestSent'), description: t('bookLesson.requestSentDescription') });
        } else if (paymentTiming === 'manual' || paymentTiming === 'invoice_after_weeks') {
          await supabase.functions.invoke('send-email', {
            body: { type: 'manual_booking_confirmation', to: profile.email, data: {
              playerName: profile.full_name, trainerName: trainer.profiles.full_name,
              lessonTitle: `${selectedCyclus.cyclus_name} (${selectedCyclus.slots.length} sessions)`,
              lessonDate: firstDate, lessonTime: firstTime,
              location: selectedCyclus.location ? `${selectedCyclus.location.name}, ${selectedCyclus.location.city}` : null,
              price: selectedCyclus.totalPrice,
            }},
          });
          setBooked(true);
        } else {
          const paymentSetup = await hasValidPaymentSetup(trainerId!, trainer.id, false);
          if (!paymentSetup.valid) {
            toast({ title: t('bookLesson.paymentNotAvailable'), description: paymentSetup.message || t('bookLesson.paymentNotAvailable'), variant: 'destructive' });
            setBooking(false);
            return;
          }
          const { data: createdBookings } = await supabase.from('bookings').select('id')
            .eq('player_id', profile.id).in('slot_id', selectedCyclus.slots.map(s => s.id))
            .eq('status', 'pending').order('created_at', { ascending: false });
          const bookingIds = createdBookings?.map(b => b.id) || [];
          const { data: paymentData, error: paymentError } = await supabase.functions.invoke('create-mollie-payment', {
            body: { slotId: selectedCyclus.slots[0].id, amount: selectedCyclus.totalPrice, description: `${selectedCyclus.cyclus_name} (${selectedCyclus.slots.length} sessions)`, trainerId: trainer.id, bookingIds },
          });
          if (paymentError) throw paymentError;
          if (paymentData?.checkoutUrl) { window.location.href = paymentData.checkoutUrl; } else { throw new Error('No checkout URL received'); }
        }
        return;
      }

      // Single slot booking
      if (!selectedSlot) return;
      const maxP = selectedSlot.max_participants || 1;
      const slotPrice = getSlotPrice(selectedSlot);
      const allowSingle = selectedSlot.allow_single_booking;
      const perSpotPrice = maxP > 1 && allowSingle ? slotPrice / maxP : slotPrice;
      const bookingQuantity = !allowSingle ? 1 : quantity;
      const price = allowSingle && maxP > 1 ? perSpotPrice * bookingQuantity : slotPrice;
      const requiresApproval = trainer.require_booking_approval;
      const useManualInvoicing = trainer.use_manual_invoicing;

      if (requiresApproval) {
        const { error } = await supabase.from('bookings').insert({
          player_id: profile.id, slot_id: selectedSlot.id, notes: notes || null, status: 'pending_approval', payment_status: 'pending',
        }).select().single();
        if (error) throw error;
        const lessonDate = format(parseISO(selectedSlot.start_time), 'EEE, MMM d, yyyy');
        const lessonTime = format(parseISO(selectedSlot.start_time), 'HH:mm');
        await supabase.functions.invoke('send-email', {
          body: { type: 'booking_request', to: trainer.profiles.email, data: {
            trainerName: trainer.profiles.full_name, playerName: profile.full_name, playerEmail: profile.email,
            lessonTitle: selectedSlot.cyclus_name || 'Training Session', lessonDate, lessonTime,
            location: selectedSlot.location ? `${selectedSlot.location.name}, ${selectedSlot.location.city}` : null, price,
          }},
        });
        setRequestSent(true);
        toast({ title: t('bookLesson.requestSent'), description: t('bookLesson.requestSentDescription') });
      } else if (useManualInvoicing) {
        const { data: bookingData, error } = await supabase.from('bookings').insert({
          player_id: profile.id, slot_id: selectedSlot.id, notes: notes || null, status: 'confirmed', payment_status: 'pending',
        }).select().single();
        if (error) throw error;
        if (bookingData?.id) {
          try { await supabase.functions.invoke('auto-create-invoice', { body: { bookingIds: [bookingData.id] } }); }
          catch (invoiceErr) { logger.error('Auto-create invoice failed (non-fatal)', invoiceErr as Error, { component: 'BookLesson', action: 'auto-invoice-single' }); }
        }
        const lessonDate = format(parseISO(selectedSlot.start_time), 'EEE, MMM d, yyyy');
        const lessonTime = format(parseISO(selectedSlot.start_time), 'HH:mm');
        await supabase.functions.invoke('send-email', {
          body: { type: 'manual_booking_confirmation', to: profile.email, data: {
            playerName: profile.full_name, trainerName: trainer.profiles.full_name,
            lessonTitle: selectedSlot.cyclus_name || 'Training Session', lessonDate, lessonTime,
            location: selectedSlot.location ? `${selectedSlot.location.name}, ${selectedSlot.location.city}` : null, price,
          }},
        });
        setBooked(true);
      } else {
        const paymentSetup = await hasValidPaymentSetup(trainerId!, trainer.id, trainer.use_manual_invoicing ?? false);
        if (!paymentSetup.valid) {
          toast({ title: t('bookLesson.paymentNotAvailable'), description: paymentSetup.message || t('bookLesson.paymentNotAvailable'), variant: 'destructive' });
          setBooking(false);
          return;
        }
        const { error } = await supabase.from('bookings').insert({
          player_id: profile.id, slot_id: selectedSlot.id, notes: notes || null, status: 'pending', payment_status: 'pending',
        }).select().single();
        if (error) throw error;
        const { data: paymentData, error: paymentError } = await supabase.functions.invoke('create-mollie-payment', {
          body: { slotId: selectedSlot.id, amount: price, description: selectedSlot.cyclus_name || 'Training Session', trainerId: trainer.id },
        });
        if (paymentError) throw paymentError;
        if (paymentData?.checkoutUrl) { window.location.href = paymentData.checkoutUrl; } else { throw new Error('No checkout URL received'); }
      }
    } catch (error: any) {
      logger.error('Booking failed', error instanceof Error ? error : new Error(error?.message || 'Unknown booking error'), { component: 'BookLesson', action: 'handleBooking' });
      toast({ title: t('bookLesson.bookingFailed'), description: error.message || t('bookLesson.bookingFailed'), variant: 'destructive' });
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
          <h2 className="text-xl font-semibold mb-2">{t('bookLesson.trainerNotFound')}</h2>
          <Button onClick={() => navigate('/app/player')}>{t('bookLesson.browseTrainers')}</Button>
        </Card>
      </div>
    );
  }

  if (requestSent) {
    return <BookingConfirmation type="request_sent" trainerName={trainer.profiles.full_name} />;
  }

  if (booked) {
    return <BookingConfirmation type="booked" trainerName={trainer.profiles.full_name} useManualInvoicing={trainer.use_manual_invoicing ?? false} />;
  }

  return (
    <FeatureErrorBoundary featureName="BookLesson" onRetry={() => window.location.reload()}>
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-background to-blue-100/30 dark:from-blue-950/20 dark:via-background dark:to-blue-900/10">
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
          <div className="space-y-6">
            <BookingTrainerCard
              fullName={trainer.profiles.full_name}
              avatarUrl={trainer.profiles.avatar_url}
              location={trainer.profiles.location}
              specializations={trainer.specializations}
            />

            <CycleBundleList
              bundles={cyclusBundles}
              selectedCyclusId={selectedCyclus?.cyclus_id || null}
              onSelect={(bundle) => { setSelectedCyclus(bundle); setSelectedSlot(null); }}
            />

            <SlotList
              slots={individualSlots}
              selectedSlotId={selectedSlot?.id || null}
              hasCycles={cyclusBundles.length > 0}
              getSlotPrice={getSlotPrice}
              onSelect={(slot) => {
                setSelectedSlot(slot);
                setSelectedCyclus(null);
                const maxP = slot.max_participants || 1;
                const minGroup = slot.cyclus_id ? (cycleSettingsMap[slot.cyclus_id]?.min_group_size || 1) : 1;
                if (!slot.allow_single_booking) { setQuantity(maxP); } else { setQuantity(Math.max(minGroup, 1)); }
              }}
            />
          </div>

          <BookingSummary
            selectedSlot={selectedSlot}
            selectedCyclus={selectedCyclus}
            notes={notes}
            onNotesChange={setNotes}
            quantity={quantity}
            onQuantityChange={setQuantity}
            applicableTerms={applicableTerms}
            termsLoading={termsLoading}
            termsAccepted={termsAccepted}
            onTermsAcceptChange={setTermsAccepted}
            booking={booking}
            onBook={handleBook}
            user={user}
            trainerId={trainerId!}
            getSlotPrice={getSlotPrice}
            cycleSettingsMap={cycleSettingsMap}
          />
        </div>
      </main>
    </div>
    </FeatureErrorBoundary>
  );
}
