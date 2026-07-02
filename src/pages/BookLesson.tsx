import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { trackEvent } from '@/lib/tracking';
import FeatureErrorBoundary from '@/components/FeatureErrorBoundary';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft } from 'lucide-react';
import { formatDate } from '@/lib/format';
import { supabase } from '@/lib/supabaseClient';
import { insertBookings, insertBookingSingle } from '@/lib/bookings';
import { filterVisibleSlotIds } from '@/lib/slotVisibility';
import { syncSplitCountForCycle } from '@/lib/invoiceSync';
import { resolveSplitDivisor } from '@/lib/splitDivisor';
import { initiateCyclePayment } from '@/lib/cyclePayment';
import { hasValidPaymentSetup } from '@/lib/academyTrainerPayments';
import { getApplicableTerms } from '@/lib/terms';
import { useTranslation } from 'react-i18next';
import { BookingConfirmation } from '@/components/booking/BookingConfirmation';
import { BookingTrainerCard } from '@/components/booking/BookingTrainerCard';
import { CycleBundleList } from '@/components/booking/CycleBundleList';
import { SlotList } from '@/components/booking/SlotList';
import { BookingSummary } from '@/components/booking/BookingSummary';
import { QueryErrorState } from '@/components/ui/QueryErrorState';

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
  /**
   * P-04: marks a copy of a cycle slot that is offered as an individual session
   * ("Losse sessies"). Cycle prices are per player, so the player pays the full
   * price_per_session — the per-spot division for trainer-created standalone
   * slots (allow_single_booking && max_participants > 1) must never apply.
   */
  fromCycle?: boolean;
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(false);
  const [requestSent, setRequestSent] = useState(false);
  const [applicableTerms, setApplicableTerms] = useState<string | null>(null);
  const [termsLoading, setTermsLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [cycleSettingsMap, setCycleSettingsMap] = useState<Record<string, { min_group_size?: number; payment_timing?: string; invoice_delay_weeks?: number; mark_as_paid?: boolean; split_payment?: boolean }>>({});

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
    setLoadingData(true);
    setLoadFailed(false);
    try {
      await loadBookingData();
    } catch {
      // Failed request (network/5xx) — retryable, distinct from "trainer not found".
      setLoadFailed(true);
    } finally {
      setLoadingData(false);
    }
  };

  const loadBookingData = async () => {
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trainerId!);

    const trainerResult = await supabase
      .from('trainer_profiles_safe' as any)
      .select(`id, user_id, hourly_rate, experience_years, specializations, require_booking_approval, use_manual_invoicing`)
      .eq(isUUID ? 'user_id' : 'slug', trainerId!)
      .maybeSingle();

    // A failed query is retryable — only a successful empty result means the
    // trainer really doesn't exist.
    if (trainerResult.error) throw trainerResult.error;
    const trainerData = trainerResult.data as any;
    if (!trainerData) return;

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

    const { data: slotsData, error: slotsError } = await supabase
      .from('availability_slots')
      .select(`id, start_time, end_time, cyclus_id, cyclus_name, court_type, price_per_session, max_participants, allow_single_booking, location_id, rating_system, min_rating, max_rating, priority_window_ends_at, member_window_ends_at, public_release_status, source_cycle_id, locations:location_id(id, name, city, street_address)`)
      .eq('trainer_id', trainerData.id)

      .eq('is_public', true)
      .gte('start_time', new Date().toISOString())
      .order('start_time', { ascending: true });
    // Don't render "no availability" (or free spots that may not exist) off a
    // failed query — surface the retryable error instead.
    if (slotsError) throw slotsError;

    if (slotsData) {
      const slotIds = slotsData.map((s) => s.id);
      const { data: bookingsData, error: bookingsError } = await supabase
        .from('bookings')
        .select(`slot_id, status, profiles:player_id (skill_rating, rating_system), guest_players:guest_player_id (skill_rating, rating_system)`)
        .in('slot_id', slotIds)
        .in('status', ['pending', 'confirmed']);
      if (bookingsError) throw bookingsError;

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

      // Tier-aware visibility filtering
      const visibleIds = await filterVisibleSlotIds(slotsData.map((s: any) => ({
        id: s.id,
        priority_window_ends_at: s.priority_window_ends_at,
        member_window_ends_at: s.member_window_ends_at,
        public_release_status: s.public_release_status,
        source_cycle_id: s.source_cycle_id,
      })));

      const availableSlots = slotsData
        .filter((s) => {
          const maxP = (s as any).max_participants || 4;
          if ((slotBookingInfo[s.id]?.count || 0) >= maxP) return false;
          if (!visibleIds.has(s.id)) return false;
          return true;
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

      const newCycleSettingsMap: Record<string, { min_group_size?: number; payment_timing?: string; invoice_delay_weeks?: number; mark_as_paid?: boolean; split_payment?: boolean }> = {};
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
              split_payment: (settings?.split_payment as boolean) || undefined,
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
      // P-04: cycle slots with allow_single_booking are ALSO offered as individual
      // sessions ("Losse sessies"), unless the cycle uses split payment (its
      // per-player amount depends on the cycle headcount, so a fixed
      // single-session price would distort the split).
      const cycleSingleSessionSlots: SlotWithDetails[] = [];
      Object.entries(cyclusGroups).forEach(([cyclusId, cyclusSlots]) => {
        const totalInCyclus = totalSlotsPerCyclus[cyclusId] || cyclusSlots.length;
        if (cyclusSlots.length === totalInCyclus) {
          const sortedSlots = cyclusSlots.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
          const totalPrice = sortedSlots.reduce((sum, s) => sum + (s.price_per_session || 0), 0);
          bundles.push({
            cyclus_id: cyclusId, cyclus_name: sortedSlots[0].cyclus_name || t('booking.trainingCycleFallback', 'Training cycle'),
            slots: sortedSlots, totalPrice,
            firstDate: sortedSlots[0].start_time, lastDate: sortedSlots[sortedSlots.length - 1].start_time,
            location: sortedSlots[0].location, min_group_size: newCycleSettingsMap[cyclusId]?.min_group_size,
          });
          if (!newCycleSettingsMap[cyclusId]?.split_payment) {
            sortedSlots.forEach((slot) => {
              if (slot.allow_single_booking === true) {
                // Cycle prices are per player: a single session costs the full
                // price_per_session. The render path (SlotList/BookingSummary)
                // divides by max_participants when allow_single_booking is set,
                // so disable it on this copy and tag it fromCycle so handleBook
                // also charges the full per-player price.
                cycleSingleSessionSlots.push({ ...slot, allow_single_booking: false, fromCycle: true });
              }
            });
          }
        } else if (newCycleSettingsMap[cyclusId]?.split_payment) {
          // Split-payment cycles keep their original slots: the per-player
          // amount depends on the cycle headcount, so a fixed single-session
          // price would distort the split.
          partialCyclusSlots.push(...cyclusSlots);
        } else {
          // P-04: like the cycleSingleSessionSlots copies above — cycle prices
          // are per player, so a partially-available cycle slot offered as an
          // individual session must charge the full price_per_session, never
          // the per-spot divided price.
          cyclusSlots.forEach((slot) => {
            partialCyclusSlots.push({ ...slot, allow_single_booking: false, fromCycle: true });
          });
        }
      });

      setCyclusBundles(bundles);
      setIndividualSlots([...standaloneSlots, ...partialCyclusSlots, ...cycleSingleSessionSlots]);
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

        // P-03: the upfront flow redirects to Mollie, so validate the trainer's
        // payment setup BEFORE inserting bookings — failing the check after the
        // insert would strand orphaned 'pending' bookings that occupy capacity
        // and distort split-payment counts. The condition mirrors the payment
        // branch below: anything that is not approval/manual/invoice_after_weeks
        // needs online payment.
        if (!requiresApproval && paymentTiming !== 'manual' && paymentTiming !== 'invoice_after_weeks') {
          const paymentSetup = await hasValidPaymentSetup(trainerId!, trainer.id, false);
          if (!paymentSetup.valid) {
            toast({ title: t('bookLesson.paymentNotAvailable'), description: t('bookLesson.paymentNotAvailablePlayer', 'Deze trainer kan nog geen online betalingen ontvangen. Neem contact op met de trainer.'), variant: 'destructive' });
            setBooking(false);
            return;
          }
        }

        const bookings = selectedCyclus.slots.map((slot) => ({
          player_id: profile.id, slot_id: slot.id, notes: notes || null,
          status: requiresApproval ? 'pending_approval' : (paymentTiming !== 'upfront' ? 'confirmed' : 'pending'),
          payment_status: paymentTiming === 'manual' ? 'pending' : 'pending',
          paid_externally: paymentTiming === 'manual' ? true : undefined,
        }));

        const { data: insertedCycleBookings, error } = await insertBookings(bookings, supabase, 'id');
        if (error) throw error;

        try {
          await supabase.functions.invoke('slack-notify', {
            body: { event: 'booking_created', data: { player: profile.full_name, trainer: trainer.profiles.full_name, type: 'Cycle', sessions: selectedCyclus.slots.length, price: `€${selectedCyclus.totalPrice}` } },
          });
        } catch { logger.warn('Slack notification failed (non-fatal)', { component: 'BookLesson' }); }


        const firstSlot = selectedCyclus.slots[0];
        const firstDate = formatDate(firstSlot.start_time, 'EEE d MMM yyyy');
        const firstTime = formatDate(firstSlot.start_time, 'HH:mm');
        const cyclusLessonTitle = `${selectedCyclus.cyclus_name} (${t('booking.sessionsCount', { count: selectedCyclus.slots.length })})`;

        if (requiresApproval) {
          await supabase.functions.invoke('send-email', {
            body: { type: 'booking_request', to: trainer.profiles.email, data: {
              trainerName: trainer.profiles.full_name, playerName: profile.full_name, playerEmail: profile.email,
              lessonTitle: cyclusLessonTitle,
              lessonDate: firstDate, lessonTime: firstTime,
              location: selectedCyclus.location ? `${selectedCyclus.location.name}, ${selectedCyclus.location.city}` : null,
              price: selectedCyclus.totalPrice,
            }},
          });
          setRequestSent(true);
          toast({ title: t('bookLesson.requestSent'), description: t('bookLesson.requestSentDescription') });
        } else if (paymentTiming === 'manual' || paymentTiming === 'invoice_after_weeks') {
          // Recalculate split invoices for existing players
          if (cycleSettings?.split_payment && selectedCyclus.cyclus_id) {
            try { await syncSplitCountForCycle(selectedCyclus.cyclus_id); }
            catch (err) { logger.warn('Split count sync failed after booking', { error: (err as Error)?.message }); }
          }
          await supabase.functions.invoke('send-email', {
            body: { type: 'manual_booking_confirmation', to: profile.email, data: {
              playerName: profile.full_name, trainerName: trainer.profiles.full_name,
              lessonTitle: cyclusLessonTitle,
              lessonDate: firstDate, lessonTime: firstTime,
              location: selectedCyclus.location ? `${selectedCyclus.location.name}, ${selectedCyclus.location.city}` : null,
              price: selectedCyclus.totalPrice,
            }},
          });
          setBooked(true);
        } else {
          // Payment setup was already validated above (P-03), before the
          // bookings were inserted — no re-check needed here.
          // A2: charge EXACTLY the bookings we just inserted. The previous
          // re-query by (player_id, slot_id, status='pending') could fold a
          // stale abandoned-checkout pending row into this payment and
          // mis-spread the split amount across more rows than intended.
          const bookingIds = ((insertedCycleBookings as { id: string }[] | null) ?? []).map(b => b.id);
          // Payment amount (INDICATIVE — create-mollie-payment recomputes server-side).
          // G5: split by the cycle's frozen court CAPACITY, matching the server divisor
          // so the pre-checkout amount agrees (no "client amount ignored" mismatch log).
          let paymentAmount = selectedCyclus.totalPrice;
          if (cycleSettings?.split_payment) {
            const divisor = resolveSplitDivisor(selectedCyclus.slots);
            paymentAmount = Math.round((selectedCyclus.totalPrice / divisor) * 100) / 100;
          }
          // A3: create the Mollie payment and, on failure, soft-cancel the
          // just-inserted bookings so a failed checkout never strands
          // capacity-occupying orphans (see src/lib/cyclePayment.ts).
          const { checkoutUrl } = await initiateCyclePayment({
            bookingIds,
            slotId: selectedCyclus.slots[0].id,
            amount: paymentAmount,
            description: cyclusLessonTitle,
            trainerId: trainer.id,
          });
          window.location.href = checkoutUrl;
        }
        return;
      }

      // Single slot booking
      if (!selectedSlot) return;
      const maxP = selectedSlot.max_participants || 1;
      const slotPrice = getSlotPrice(selectedSlot);
      // P-04: cycle-derived single sessions (fromCycle) are priced per player —
      // the player pays the full price_per_session, never a per-spot share.
      // Trainer-created standalone slots keep the divided-price behavior.
      const fromCycle = selectedSlot.fromCycle === true;
      const allowSingle = selectedSlot.allow_single_booking && !fromCycle;
      const perSpotPrice = maxP > 1 && allowSingle ? slotPrice / maxP : slotPrice;
      const bookingQuantity = !allowSingle ? 1 : quantity;
      const price = allowSingle && maxP > 1 ? perSpotPrice * bookingQuantity : slotPrice;
      const requiresApproval = trainer.require_booking_approval;
      const useManualInvoicing = trainer.use_manual_invoicing;

      if (requiresApproval) {
        const { error } = await insertBookingSingle({
          player_id: profile.id, slot_id: selectedSlot.id, notes: notes || null, status: 'pending_approval', payment_status: 'pending',
        });
        if (error) throw error;
        const lessonDate = formatDate(selectedSlot.start_time, 'EEE d MMM yyyy');
        const lessonTime = formatDate(selectedSlot.start_time, 'HH:mm');
        await supabase.functions.invoke('send-email', {
          body: { type: 'booking_request', to: trainer.profiles.email, data: {
            trainerName: trainer.profiles.full_name, playerName: profile.full_name, playerEmail: profile.email,
            lessonTitle: selectedSlot.cyclus_name || t('booking.trainingSession', 'Training Session'), lessonDate, lessonTime,
            location: selectedSlot.location ? `${selectedSlot.location.name}, ${selectedSlot.location.city}` : null, price,
          }},
        });
        setRequestSent(true);
        toast({ title: t('bookLesson.requestSent'), description: t('bookLesson.requestSentDescription') });
      } else if (useManualInvoicing) {
        const { data, error } = await insertBookingSingle({
          player_id: profile.id, slot_id: selectedSlot.id, notes: notes || null, status: 'confirmed', payment_status: 'pending',
        });
        if (error) throw error;
        const bookingData = data as { id: string } | null;
        if (bookingData?.id) {
          try { await supabase.functions.invoke('auto-create-invoice', { body: { bookingIds: [bookingData.id] } }); }
          catch (invoiceErr) { logger.error('Auto-create invoice failed (non-fatal)', invoiceErr as Error, { component: 'BookLesson', action: 'auto-invoice-single' }); }
        }
        const lessonDate = formatDate(selectedSlot.start_time, 'EEE d MMM yyyy');
        const lessonTime = formatDate(selectedSlot.start_time, 'HH:mm');
        await supabase.functions.invoke('send-email', {
          body: { type: 'manual_booking_confirmation', to: profile.email, data: {
            playerName: profile.full_name, trainerName: trainer.profiles.full_name,
            lessonTitle: selectedSlot.cyclus_name || t('booking.trainingSession', 'Training Session'), lessonDate, lessonTime,
            location: selectedSlot.location ? `${selectedSlot.location.name}, ${selectedSlot.location.city}` : null, price,
          }},
        });
        setBooked(true);
      } else {
        const paymentSetup = await hasValidPaymentSetup(trainerId!, trainer.id, trainer.use_manual_invoicing ?? false);
        if (!paymentSetup.valid) {
          toast({ title: t('bookLesson.paymentNotAvailable'), description: t('bookLesson.paymentNotAvailablePlayer', 'Deze trainer kan nog geen online betalingen ontvangen. Neem contact op met de trainer.'), variant: 'destructive' });
          setBooking(false);
          return;
        }
        // Mutation boundary (Option A): do NOT insert the booking here. The
        // capacity-locked create-mollie-payment edge function owns online
        // single-slot booking creation via book_slot_for_payment — passing no
        // bookingIds tells it to create exactly one booking under the per-slot
        // advisory lock. Inserting here too would double-insert (the previous
        // P0). `notes` is forwarded so the edge function/RPC can persist it.
        const { data: paymentData, error: paymentError } = await supabase.functions.invoke('create-mollie-payment', {
          body: { slotId: selectedSlot.id, amount: price, description: selectedSlot.cyclus_name || t('booking.trainingSession', 'Training Session'), trainerId: trainer.id, notes: notes || null },
        });
        if (paymentError) throw paymentError;
        if (paymentData?.checkoutUrl) { window.location.href = paymentData.checkoutUrl; } else { throw new Error('No checkout URL received'); }
      }
    } catch (error: any) {
      logger.error('Booking failed', error instanceof Error ? error : new Error(error?.message || 'Unknown booking error'), { component: 'BookLesson', action: 'handleBooking' });
      toast({ title: t('bookLesson.bookingFailed'), description: getFriendlyErrorMessage(error, t('bookLesson.bookingFailed')), variant: 'destructive' });
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

  if (loadFailed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <QueryErrorState
          onRetry={fetchData}
          className="max-w-md w-full"
          title={t('bookLesson.loadFailedTitle', 'Aanbod kon niet geladen worden')}
          description={t('bookLesson.loadFailedDescription', 'Er ging iets mis bij het laden van het lesaanbod. Controleer je internetverbinding en probeer het opnieuw.')}
        />
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
    <div className="min-h-screen bg-background">
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">{t('bookLesson.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('bookLesson.with', { name: trainer.profiles.full_name })}</p>
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
                // P-04: a cycle-derived single session is one spot for one player.
                if (slot.fromCycle) { setQuantity(1); return; }
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
