import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS, es, de, fr } from 'date-fns/locale';
import {
  ArrowLeft, Calendar, Lock, MapPin, Users, Pencil,
  Trash2, UserPlus, DollarSign, Loader2, X, Check,
  AlertTriangle, Settings, FileText, CheckCircle2,
} from 'lucide-react';
import { isPast } from 'date-fns';
import { supabase } from '@/lib/supabaseClient';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';
import { CAPACITY_OCCUPYING_STATUSES, getSlotCapacity } from '@/lib/lessons';
import { logger } from '@/lib/logger';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { syncInvoicesAfterPriceChange, syncInvoicesAfterBookingRemoval, syncSplitCountForCycle } from '@/lib/invoiceSync';
import { filterDeletableSlotIds } from '@/lib/slotDeleteGuard';
import { useToast } from '@/hooks/use-toast';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { InlineBookPlayer } from '@/components/trainer/InlineBookPlayer';
import { InlineEditBooking } from '@/components/trainer/InlineEditBooking';
import { PlayerCoachingNoteEditor } from '@/components/coaching/PlayerCoachingNoteEditor';
import { usePlayerCoachingNotes } from '@/lib/coachingNotes';
import { SlotEditForm, type SlotEditFormValues } from '@/components/slots/SlotEditForm';
import { useTrainerRatingSystem } from '@/hooks/useTrainerRatingSystem';
import { BookedPlayer } from '@/lib/slotTypes';
import { SlotAttendanceCard } from '@/components/attendance/SlotAttendanceCard';
import PriorityClaimsSection from '@/components/cycles/PriorityClaimsSection';
import SlotTierControlCard from '@/components/cycles/SlotTierControlCard';
import { resolveAcademyCyclusPricingRoute } from '@/lib/cyclusPricingRoute';
import { formatCurrency } from '@/lib/format';

const dateFnsLocales: Record<string, typeof enUS> = { nl, en: enUS, es, de, fr };

interface ExtraCost {
  description: string;
  amount: number;
  type: 'one_time' | 'per_session';
}

interface SlotDetail {
  id: string;
  start_time: string;
  end_time: string;
  trainer_id: string;
  trainer_name: string;
  trainer_avatar: string | null;
  location_id: string | null;
  location_name: string | null;
  cyclus_id: string | null;
  cyclus_name: string | null;
  max_participants: number;
  is_public: boolean;
  rating_system: string | null;
  min_rating: number | null;
  max_rating: number | null;
  price_per_session: number | null;
  total_price: number | null;
  split_payment: boolean;
  prices_include_vat: boolean;
  extra_costs: ExtraCost[] | null;
  booked_players: BookedPlayer[];
}

interface TrainerOption { id: string; name: string; }
interface LocationOption { id: string; name: string; }

interface SlotInvoice {
  id: string;
  invoice_number: string;
  player_name: string;
  total: number;
  status: string;
  due_date: string;
  paid_at: string | null;
}

export default function AcademySlotDetail() {
  const { slotId } = useParams<{ slotId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const dateLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split('-')[0]] || enUS;
  const { activeAcademy } = useAcademyContext();

  const { data: coachingNotes = [] } = usePlayerCoachingNotes(slotId);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<SlotDetail | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit form state

  // Lookup data
  const [trainers, setTrainers] = useState<TrainerOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);

  // Dialog state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteCyclus, setDeleteCyclus] = useState(false);
  const [showBookPlayer, setShowBookPlayer] = useState(false);
  const [pricingLinkLoading, setPricingLinkLoading] = useState(false);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [editingBookingData, setEditingBookingData] = useState<any>(null);

  // Warning state
  const [warningThresholds, setWarningThresholds] = useState<{ maxRatingSpread: number | null; maxAgeDiff: number | null }>({ maxRatingSpread: null, maxAgeDiff: null });
  const [dismissedWarnings, setDismissedWarnings] = useState<string[]>([]);
  const [dismissingWarning, setDismissingWarning] = useState<string | null>(null);

  // Invoice state
  const [slotInvoices, setSlotInvoices] = useState<SlotInvoice[]>([]);

  const { trainerRatingSystem } = useTrainerRatingSystem(detail?.trainer_id || undefined);

  const fetchSlotDetail = useCallback(async () => {
    if (!slotId) return;
    setLoading(true);
    try {
      const { data: slot, error } = await supabase
        .from('availability_slots')
        .select(`
          id, start_time, end_time, trainer_id, max_participants, cyclus_id, cyclus_name, location_id, is_public,
          rating_system, min_rating, max_rating, price_per_session,
          total_price, split_payment, prices_include_vat, extra_costs,
          locations:location_id(name)
        `)
        .eq('id', slotId)
        .single();

      if (error) throw error;

      // Trainer display name via the shared resolver (business_name →
      // profiles_public → profiles → 'Trainer'), so the academy slot detail
      // labels a trainer the same as every other surface. (The old direct
      // profiles query could even RLS-fail to null → 'Unknown'.)
      const trainerNameMap = await fetchTrainerDisplayNamesByProfileIds(
        [slot.trainer_id],
        supabase,
        'AcademySlotDetail',
      );
      const trainerName = trainerNameMap.get(slot.trainer_id) || 'Trainer';

      // Avatar is not part of the name resolver; fetch it separately.
      let trainerAvatar: string | null = null;
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('user_id')
        .eq('id', slot.trainer_id)
        .single();
      if (trainerProfile?.user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('avatar_url')
          .eq('user_id', trainerProfile.user_id)
          .single();
        trainerAvatar = profile?.avatar_url || null;
      }

      const { data: bookings } = await supabase
        .from('bookings')
        .select(`
          id, status, player_id, guest_player_id, payment_status, payment_amount, paid_externally,
          guest_players:guest_player_id(full_name, skill_rating, rating_system, birth_date)
        `)
        .eq('slot_id', slotId)
        .in('status', [...CAPACITY_OCCUPYING_STATUSES]);

      // Registered players resolve via profiles_public: the academy has no RLS
      // access to other users' profiles rows, so an embedded profiles join
      // silently returns null and every registered player rendered "Unknown".
      const registeredIds = (bookings || []).map(b => b.player_id).filter(Boolean) as string[];
      const profilesById = new Map<string, { full_name: string | null; avatar_url: string | null; skill_rating: number | null; rating_system: string | null }>();
      if (registeredIds.length > 0) {
        const { data: publicProfiles } = await supabase
          .from('profiles_public')
          .select('id, full_name, avatar_url, skill_rating, rating_system')
          .in('id', registeredIds);
        (publicProfiles || []).forEach(p => { if (p.id) profilesById.set(p.id, p); });
      }

      const players: BookedPlayer[] = (bookings || []).map(b => {
        const prof = b.player_id ? profilesById.get(b.player_id) : null;
        const guest = b.guest_players as any;
        return {
          id: b.player_id || b.guest_player_id || b.id,
          bookingId: b.id,
          name: prof?.full_name || guest?.full_name || 'Unknown',
          status: b.status as 'confirmed' | 'pending',
          isGuest: !!b.guest_player_id,
          skillRating: prof?.skill_rating ?? guest?.skill_rating ?? null,
          ratingSystem: prof?.rating_system || guest?.rating_system || 'knltb',
          avatarUrl: prof?.avatar_url || null,
          // profiles_public exposes no birth_date (PII); it was null for
          // registered players under the old RLS-blocked join too.
          birthDate: guest?.birth_date || null,
          paymentStatus: b.payment_status as string | undefined,
          paidExternally: Boolean(b.paid_externally),
        };
      });

      setDetail({
        id: slot.id,
        start_time: slot.start_time,
        end_time: slot.end_time,
        trainer_id: slot.trainer_id,
        trainer_name: trainerName,
        trainer_avatar: trainerAvatar,
        location_id: slot.location_id,
        location_name: (slot.locations as any)?.name || null,
        cyclus_id: slot.cyclus_id,
        cyclus_name: slot.cyclus_name,
        max_participants: getSlotCapacity(slot),
        is_public: slot.is_public,
        rating_system: slot.rating_system,
        min_rating: slot.min_rating,
        max_rating: slot.max_rating,
        price_per_session: slot.price_per_session,
        total_price: slot.total_price,
        split_payment: slot.split_payment ?? false,
        prices_include_vat: slot.prices_include_vat ?? true,
        extra_costs: (slot.extra_costs as unknown as ExtraCost[] | null) || null,
        booked_players: players,
      });
    } catch (error) {
      logger.error('Error fetching slot detail', error as Error, { slotId });
      toast({ title: tCommon('error'), description: t('calendar.loadSlotError', 'Failed to load slot details'), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [slotId]);

  useEffect(() => { fetchSlotDetail(); }, [fetchSlotDetail]);

  // Fetch warning thresholds + dismissed warnings
  useEffect(() => {
    if (!activeAcademy?.id || !slotId) return;
    (async () => {
      const [thresholdsRes, dismissedRes] = await Promise.all([
        supabase
          .from('academy_profiles')
          .select('warning_max_rating_spread, warning_max_age_diff_years')
          .eq('id', activeAcademy.id)
          .single(),
        supabase
          .from('dismissed_slot_warnings')
          .select('warning_type')
          .eq('slot_id', slotId),
      ]);
      if (thresholdsRes.data) {
        setWarningThresholds({
          maxRatingSpread: thresholdsRes.data.warning_max_rating_spread,
          maxAgeDiff: thresholdsRes.data.warning_max_age_diff_years,
        });
      }
      setDismissedWarnings((dismissedRes.data || []).map(d => d.warning_type));
    })();
  }, [activeAcademy?.id, slotId]);

  // Fetch invoices linked to this slot's bookings
  useEffect(() => {
    if (!detail || detail.booked_players.length === 0) {
      setSlotInvoices([]);
      return;
    }
    const bookingIds = detail.booked_players.map(p => p.bookingId);
    (async () => {
      const { data } = await supabase
        .from('invoices')
        .select('id, invoice_number, player_name, total, status, due_date, paid_at')
        .overlaps('booking_ids', bookingIds)
        .order('invoice_number');
      setSlotInvoices((data as SlotInvoice[]) || []);
    })();
  }, [detail]);

  useEffect(() => {
    if (!activeAcademy) return;
    (async () => {
      // Load trainers and locations INDEPENDENTLY — a failure in one must not hide
      // the other's editor (a trainers hiccup used to silently kill the location
      // picker because both shared one try block).
      try {
        const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
        setTrainers(
          academyTrainers
            .filter((t: any) => t.status === 'active' && t.trainer_profile)
            .map((t: any) => ({ id: t.trainer_profile.id, name: t.profile?.full_name || 'Unknown' }))
        );
      } catch (e) {
        logger.error('Error loading academy trainers for slot detail', e as Error);
      }
      try {
        const academyLocations = await getAcademyLocations(activeAcademy.id);
        setLocations(
          academyLocations
            // skip orphaned rows (location deleted/hidden) so a bad row can't break the picker
            .map((al: any) => (al.location?.id ? { id: al.location.id, name: al.location.name } : null))
            .filter((x: LocationOption | null): x is LocationOption => x !== null)
        );
      } catch (e) {
        logger.error('Error loading academy locations for slot detail', e as Error);
      }
    })();
  }, [activeAcademy]);

  // Auto-open edit mode on first load. SlotEditForm initialises its own fields from the slot.
  const autoEditTriggered = useRef(false);
  useEffect(() => {
    if (detail && !autoEditTriggered.current) {
      autoEditTriggered.current = true;
      setIsEditing(true);
    }
  }, [detail]);

  const handleSave = async (values: SlotEditFormValues, applyToCyclus: boolean) => {
    if (!detail) return;
    setSaving(true);
    try {
      const [hours, minutes] = values.startTime.split(':').map(Number);
      const startDateTime = new Date(values.date);
      startDateTime.setHours(hours, minutes, 0, 0);
      const endDateTime = new Date(startDateTime);
      endDateTime.setMinutes(endDateTime.getMinutes() + values.duration);

      const isCycleSlot = !!detail.cyclus_id;

      const updatePayload: any = {
        start_time: startDateTime.toISOString(),
        end_time: endDateTime.toISOString(),
        trainer_id: values.trainerId,
        location_id: values.locationId === 'none' ? null : values.locationId,
        max_participants: values.maxParticipants,
        rating_system: values.ratingSystem,
        min_rating: values.minRating,
        max_rating: values.maxRating,
        cyclus_name: values.cyclusName || null,
        is_public: !values.isMarkedFull,
      };

      // Only include pricing fields if slot does NOT belong to a cycle
      if (!isCycleSlot) {
        updatePayload.price_per_session = values.pricePerSession ? Number(values.pricePerSession) : null;
        updatePayload.total_price = values.totalPrice ? Number(values.totalPrice) : null;
        updatePayload.split_payment = values.splitPayment;
        updatePayload.prices_include_vat = values.pricesIncludeVat;
        updatePayload.extra_costs = values.extraCosts.length > 0 ? values.extraCosts : null;
      }

      if (applyToCyclus && detail.cyclus_id) {
        const { data: cyclusSlots, error: fetchError } = await supabase
          .from('availability_slots')
          .select('id, start_time')
          .eq('cyclus_id', detail.cyclus_id)
          .gte('start_time', new Date().toISOString())
          .order('start_time');
        if (fetchError) throw fetchError;

        const originalStart = new Date(detail.start_time);
        const timeOfDayDiff = (hours * 60 + minutes) - (originalStart.getHours() * 60 + originalStart.getMinutes());

        for (const cs of (cyclusSlots || [])) {
          const csStart = new Date(cs.start_time);
          csStart.setMinutes(csStart.getMinutes() + timeOfDayDiff);
          const csEnd = new Date(csStart);
          csEnd.setMinutes(csEnd.getMinutes() + values.duration);

          await supabase
            .from('availability_slots')
            .update({
              ...updatePayload,
              start_time: csStart.toISOString(),
              end_time: csEnd.toISOString(),
            })
            .eq('id', cs.id);
        }
        toast({ title: tTrainer('calendar.cyclusUpdated', 'Cyclus updated') });

        // Sync invoices if price changed
        const priceChanged = detail.price_per_session !== (values.pricePerSession ? Number(values.pricePerSession) : null);
        if (priceChanged && cyclusSlots) {
          try {
            await syncInvoicesAfterPriceChange(cyclusSlots.map(s => s.id));
          } catch (e) {
            logger.error('Failed to sync invoices after cyclus price change', e as Error);
          }
        }
      } else {
        const { error } = await supabase
          .from('availability_slots')
          .update(updatePayload)
          .eq('id', detail.id);
        if (error) throw error;

        // Sync invoices if price changed
        const priceChanged = detail.price_per_session !== (values.pricePerSession ? Number(values.pricePerSession) : null);
        if (priceChanged) {
          try {
            await syncInvoicesAfterPriceChange([detail.id]);
          } catch (e) {
            logger.error('Failed to sync invoices after price change', e as Error);
          }
        }
        toast({ title: tTrainer('calendar.slotUpdated', 'Slot updated') });
      }

      setIsEditing(false);
      fetchSlotDetail();
    } catch (error: any) {
      logger.error('Error updating slot', error, { slotId: detail.id });
      toast({ title: tCommon('error'), description: getFriendlyErrorMessage(error, tTrainer('calendar.slotUpdateError', 'Could not update the slot. Please try again.')), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleEditCyclePricing = async () => {
    if (!detail?.cyclus_id) return;
    setPricingLinkLoading(true);
    try {
      const path = await resolveAcademyCyclusPricingRoute(detail.cyclus_id);
      navigate(path);
    } catch (error) {
      logger.error(
        "Failed to resolve cycle pricing route",
        error instanceof Error ? error : new Error(String(error)),
        { slotId: detail.id, cyclusId: detail.cyclus_id },
      );
      toast({
        title: tCommon('error', 'Error'),
        description: tTrainer('calendar.editCyclePricingError', 'Could not open cycle pricing. Try the Calendar → Cycles tab.'),
        variant: 'destructive',
      });
    } finally {
      setPricingLinkLoading(false);
    }
  };

  const togglePrivate = async () => {
    if (!detail) return;
    const newVal = !detail.is_public;
    const { error } = await supabase
      .from('availability_slots')
      .update({ is_public: newVal })
      .eq('id', detail.id);
    if (error) {
      logger.error('Error toggling private', error, { slotId: detail.id });
      return;
    }
    setDetail({ ...detail, is_public: newVal });
    toast({ description: newVal ? tTrainer('calendar.slotMarkedFull') : tTrainer('calendar.slotMarkedOpen') });
  };

  const handleDelete = async () => {
    if (!detail) return;
    setDeleting(true);
    try {
      // Collect booking IDs before deleting slots
      let slotIdsToDelete: string[] = [];
      if (deleteCyclus && detail.cyclus_id) {
        const { data: cyclusSlots } = await supabase
          .from('availability_slots')
          .select('id')
          .eq('cyclus_id', detail.cyclus_id)
          .gte('start_time', new Date().toISOString());
        slotIdsToDelete = (cyclusSlots || []).map(s => s.id);
      } else {
        slotIdsToDelete = [detail.id];
      }

      // SAFETY: bookings.slot_id is ON DELETE CASCADE — deleting a slot deletes its bookings. This
      // path previously deleted the slot directly, silently cascade-removing any active booking.
      // Restrict the delete to slots with NO active (occupying) booking; the rest are kept.
      const deletableSlotIds = await filterDeletableSlotIds(slotIdsToDelete);
      if (deletableSlotIds.length === 0) {
        toast({
          title: tTrainer('calendar.slotHasBooking', "Can't delete this slot"),
          description: tTrainer('calendar.slotHasBookingDescription', 'It still has an active booking. Cancel the booking first, then delete.'),
          variant: 'destructive',
        });
        return;
      }

      // Occupying bookings on the deletable slots (none, by construction) → sync invoices after.
      const { data: slotBookings } = await supabase
        .from('bookings')
        .select('id')
        .in('slot_id', deletableSlotIds)
        .in('status', [...CAPACITY_OCCUPYING_STATUSES]);
      const bookingIdsToRemove = (slotBookings || []).map(b => b.id);

      const { error } = await supabase
        .from('availability_slots')
        .delete()
        .in('id', deletableSlotIds);
      if (error) throw error;
      toast({ title: deleteCyclus ? tTrainer('calendar.cyclusDeleted', 'Cyclus deleted') : tTrainer('calendar.slotDeleted', 'Slot deleted') });

      // Sync invoices after deletion
      if (bookingIdsToRemove.length > 0) {
        try {
          await syncInvoicesAfterBookingRemoval(bookingIdsToRemove);
        } catch (e) {
          logger.error('Failed to sync invoices after slot deletion', e as Error);
        }
      }

      // Recalculate split count for remaining players in the cycle
      if (detail.cyclus_id) {
        try {
          await syncSplitCountForCycle(detail.cyclus_id);
        } catch (e) {
          logger.error('Failed to sync split count after slot deletion', e as Error);
        }
      }

      navigate('/app/academy/calendar');
    } catch (error: any) {
      logger.error('Error deleting slot', error, { slotId: detail.id });
      toast({ title: tCommon('error'), description: getFriendlyErrorMessage(error, tTrainer('calendar.slotDeleteError', 'Could not delete the slot. Please try again.')), variant: 'destructive' });
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const handleEditBooking = async (bookingId: string) => {
    if (editingBookingId === bookingId) {
      setEditingBookingId(null);
      setEditingBookingData(null);
      return;
    }
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select(`
          id, status, notes, payment_status, payment_amount, guest_player_id, paid_externally,
          availability_slots (id, start_time, end_time, price_per_session, cyclus_name),
          profiles:player_id (id, full_name, email)
        `)
        .eq('id', bookingId)
        .single();
      if (error) throw error;
      setEditingBookingData({ ...data, player: data.profiles });
      setEditingBookingId(bookingId);
    } catch (error) {
      logger.error('Error fetching booking', error instanceof Error ? error : new Error(String(error)));
    }
  };

  // Warning helpers
  const calculateAge = (birthDate: string | null): number | null => {
    if (!birthDate) return null;
    const diff = Date.now() - new Date(birthDate).getTime();
    return Math.floor(diff / 31557600000);
  };

  const computeWarnings = (): { type: string; message: string }[] => {
    if (!detail || detail.booked_players.length < 2) return [];
    const warnings: { type: string; message: string }[] = [];
    
    if (warningThresholds.maxRatingSpread != null) {
      const ratings = detail.booked_players.map(p => p.skillRating).filter((r): r is number => r != null);
      if (ratings.length >= 2) {
        const spread = Math.max(...ratings) - Math.min(...ratings);
        if (spread > warningThresholds.maxRatingSpread) {
          warnings.push({ type: 'rating_spread', message: t('calendar.warningRatingSpread', 'Rating spread: {{spread}} points (max {{max}})', { spread: spread.toFixed(1), max: warningThresholds.maxRatingSpread }) });
        }
      }
    }

    if (warningThresholds.maxAgeDiff != null) {
      const ages = detail.booked_players.map(p => calculateAge(p.birthDate)).filter((a): a is number => a != null);
      if (ages.length >= 2) {
        const diff = Math.max(...ages) - Math.min(...ages);
        if (diff > warningThresholds.maxAgeDiff) {
          warnings.push({ type: 'age_diff', message: t('calendar.warningAgeDiff', 'Age difference: {{diff}} years (max {{max}})', { diff, max: warningThresholds.maxAgeDiff }) });
        }
      }
    }

    return warnings.filter(w => !dismissedWarnings.includes(w.type));
  };

  const handleDismissWarning = async (warningType: string) => {
    if (!slotId) return;
    setDismissingWarning(warningType);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from('dismissed_slot_warnings')
        .insert({ slot_id: slotId, warning_type: warningType, dismissed_by: user?.id || null });
      if (error) throw error;
      setDismissedWarnings(prev => [...prev, warningType]);
    } catch (e) {
      logger.error('Error dismissing warning', e as Error);
    } finally {
      setDismissingWarning(null);
    }
  };

  const activeWarnings = detail ? computeWarnings() : [];

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="border-b bg-background/60">
          <div className="container mx-auto px-4 py-3 flex items-center gap-4">
            <Button variant="ghost" size="icon" aria-label={t('calendar.goBack', 'Go back')} onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <Skeleton className="h-6 w-48" />
          </div>
        </div>
        <main className="container mx-auto px-4 py-6 space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
        </main>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="min-h-screen bg-background">
        <div className="border-b bg-background/60">
          <div className="container mx-auto px-4 py-3 flex items-center gap-4">
            <Button variant="ghost" size="icon" aria-label={t('calendar.goBack', 'Go back')} onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <h1 className="text-xl font-bold">{t('calendar.slotNotFound', 'Slot not found')}</h1>
          </div>
        </div>
      </div>
    );
  }

  const bookedCount = detail.booked_players.length;
  const startDate = new Date(detail.start_time);
  const endDate = new Date(detail.end_time);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" aria-label={t('calendar.goBack', 'Go back')} onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-lg font-bold">
                {format(startDate, 'EEEE d MMMM yyyy', { locale: dateLocale })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {format(startDate, 'HH:mm')} – {format(endDate, 'HH:mm')}
                {detail.trainer_name && ` · ${detail.trainer_name}`}
                {detail.location_name && ` · ${detail.location_name}`}
              </p>
            </div>
          </div>

        </div>
      </div>

      <main className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-end gap-2 max-w-4xl mb-4">
          <Button
            variant="outline"
            aria-label={tTrainer('calendar.deleteSlot', 'Delete slot')}
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={() => { setDeleteCyclus(false); setDeleteOpen(true); }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
          {/* Left: Details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                {t('calendar.details', 'Details')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isEditing ? (
                /* Edit form */
                <SlotEditForm
                  key={detail.id}
                  slot={detail}
                  namespace="academy"
                  trainers={trainers}
                  locations={locations}
                  fixedRatingSystem={trainerRatingSystem}
                  onEditCyclePricing={() => void handleEditCyclePricing()}
                  cyclePricingLoading={pricingLinkLoading}
                  isSaving={saving}
                  onSubmit={handleSave}
                  onCancel={() => setIsEditing(false)}
                />
              ) : (
                /* View mode */
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-9 w-9">
                      <AvatarImage src={detail.trainer_avatar || undefined} />
                      <AvatarFallback className="text-xs">{detail.trainer_name.slice(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="text-sm font-medium">{detail.trainer_name}</p>
                      <p className="text-xs text-muted-foreground">{tTrainer('calendar.trainer', 'Trainer')}</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {detail.location_name && (
                      <Badge variant="outline" className="gap-1">
                        <MapPin className="h-3 w-3" />
                        {detail.location_name}
                      </Badge>
                    )}
                    {detail.cyclus_name && (
                      <Badge variant="secondary">{detail.cyclus_name}</Badge>
                    )}
                    {!detail.is_public && (
                      <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
                        <Lock className="h-3 w-3" />
                        {t('calendar.private', 'Private')}
                      </Badge>
                    )}
                    {detail.price_per_session != null && (
                      <Badge variant="outline" className="gap-1">
                        <DollarSign className="h-3 w-3" />
                        {formatCurrency(detail.price_per_session)} / {t('calendar.session', 'session')}
                      </Badge>
                    )}
                    {detail.total_price != null && (
                      <Badge variant="outline" className="gap-1">
                        <DollarSign className="h-3 w-3" />
                        {formatCurrency(detail.total_price)} {t('calendar.total', 'total')}
                      </Badge>
                    )}
                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                      {detail.prices_include_vat ? t('calendar.inclVat', 'Incl. VAT') : t('calendar.exclVat', 'Excl. VAT')}
                    </Badge>
                    {detail.split_payment && (
                      <Badge variant="outline" className="gap-1 text-muted-foreground">
                        {t('calendar.splitPayment', 'Split payment')}
                      </Badge>
                    )}
                    {(detail.min_rating != null || detail.max_rating != null) && (
                      <Badge variant="outline" className="gap-1">
                        {t('slotDetail.level', 'Level')} {detail.min_rating ?? '?'} – {detail.max_rating ?? '?'}
                      </Badge>
                    )}
                  </div>

                  {/* Extra costs summary */}
                  {detail.extra_costs && detail.extra_costs.length > 0 && (
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p className="font-medium">{t('calendar.extraCosts', 'Extra costs')}:</p>
                      {detail.extra_costs.map((ec, i) => (
                        <p key={i}>
                          {ec.description}: {formatCurrency(ec.amount)} ({ec.type === 'one_time' ? t('calendar.oneTime', 'One-time') : t('calendar.perSession', 'Per session')})
                        </p>
                      ))}
                    </div>
                  )}

                  <Separator />

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Lock className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{t('calendar.markPrivate', 'Mark as private')}</span>
                    </div>
                    <Switch checked={!detail.is_public} onCheckedChange={togglePrivate} />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Warnings */}
          {activeWarnings.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50/50 dark:bg-amber-950/20 p-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t('calendar.warnings', 'Warnings')}
                </span>
                <button
                  className="text-[11px] text-muted-foreground hover:underline flex items-center gap-1"
                  onClick={() => navigate('/app/academy/settings')}
                >
                  <Settings className="h-3 w-3" />
                  {t('calendar.configureWarnings', 'Configure thresholds →')}
                </button>
              </div>
              <div className="space-y-1">
                {activeWarnings.map(warning => (
                  <div key={warning.type} className="flex items-center justify-between gap-2 text-xs text-amber-800 dark:text-amber-300">
                    <span>{warning.message}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] shrink-0"
                      disabled={dismissingWarning === warning.type}
                      onClick={() => handleDismissWarning(warning.type)}
                    >
                      {dismissingWarning === warning.type ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <X className="h-3 w-3 mr-0.5" />
                      )}
                      {t('calendar.dismiss', 'Dismiss')}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Right: Players */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  {t('calendar.players', 'Players')} ({bookedCount}/{detail.max_participants})
                </CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setShowBookPlayer(!showBookPlayer)}
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('calendar.addPlayer', 'Add Player')}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {detail.booked_players.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  {t('calendar.noPlayersYet', 'No players booked yet')}
                </p>
              ) : (
                <div className="space-y-1">
                  {detail.booked_players.map(player => (
                    <div key={player.bookingId}>
                      <button
                        className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent/50 transition-colors text-left"
                        onClick={() => handleEditBooking(player.bookingId)}
                      >
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={(player as any).avatarUrl || undefined} />
                          <AvatarFallback className="text-[10px]">
                            {player.name.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{player.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {[
                              player.skillRating != null ? `${player.ratingSystem?.toUpperCase()} ${player.skillRating}` : null,
                              calculateAge(player.birthDate) != null ? `${calculateAge(player.birthDate)} ${t('slotDetail.years', 'yr')}` : null,
                            ].filter(Boolean).join(' · ') || '\u00A0'}
                          </p>
                        </div>
                        {player.isGuest && (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5">{t('slotDetail.guest', 'Guest')}</Badge>
                        )}
                        {player.status === 'confirmed' ? (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-300">
                            <Check className="h-2.5 w-2.5 mr-0.5" />
                            {tCommon('confirmed', 'Confirmed')}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-amber-600 border-amber-300">
                            {tCommon('pending', 'Pending')}
                          </Badge>
                        )}
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      </button>
                      {editingBookingId === player.bookingId && editingBookingData && (
                        <InlineEditBooking
                          booking={editingBookingData}
                          trainerId={detail.trainer_id}
                          academyProfileId={activeAcademy?.id}
                          onBookingUpdated={() => { setEditingBookingId(null); setEditingBookingData(null); fetchSlotDetail(); }}
                          onClose={() => { setEditingBookingId(null); setEditingBookingData(null); }}
                        />
                      )}
                      {editingBookingId === player.bookingId && user?.id && (
                        <div className="mt-2 space-y-1.5">
                          <p className="px-1 text-xs font-medium text-muted-foreground">{tCommon('coachingNotes.heading', 'Coaching notes')}</p>
                          <PlayerCoachingNoteEditor
                            slotId={detail.id}
                            authorId={user.id}
                            authorRole="academy"
                            subjectProfileId={player.isGuest ? null : player.id}
                            subjectGuestPlayerId={player.isGuest ? player.id : null}
                            subjectName={player.name}
                            isGuest={player.isGuest}
                            notes={coachingNotes}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {showBookPlayer && (
                <InlineBookPlayer
                  trainerId={detail.trainer_id}
                  academyProfileId={activeAcademy?.id}
                  slot={{
                    id: detail.id,
                    start_time: detail.start_time,
                    end_time: detail.end_time,
                    cyclus_id: detail.cyclus_id,
                    cyclus_name: detail.cyclus_name,
                    price_per_session: detail.price_per_session,
                    split_payment: detail.split_payment,
                    booked_players: detail.booked_players,
                  }}
                  onBookingCreated={() => { setShowBookPlayer(false); fetchSlotDetail(); }}
                  onClose={() => setShowBookPlayer(false)}
                />
              )}
            </CardContent>
          </Card>
          {/* Priority rebooking claims */}
          {detail && <PriorityClaimsSection slotId={detail.id} />}
          {detail && <SlotTierControlCard slotId={detail.id} />}

          {/* Attendance */}
          {detail && isPast(new Date(detail.end_time)) && (
            <SlotAttendanceCard
              slotId={detail.id}
              bookedPlayers={detail.booked_players.map(p => ({
                id: p.id,
                name: p.name,
                profileId: p.id,
              }))}
              isPastSlot={true}
            />
          )}

          {/* Invoices */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" />
                {t('calendar.invoices', 'Invoices')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {slotInvoices.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {t('calendar.noInvoices', 'No invoices linked to this slot')}
                </p>
              ) : (
                <div className="space-y-1">
                  {slotInvoices.map(inv => {
                    const isOverdue = inv.status === 'sent' && new Date(inv.due_date) < new Date();
                    const displayStatus = isOverdue ? 'overdue' : inv.status;
                    return (
                      <button
                        key={inv.id}
                        className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent/50 transition-colors text-left"
                        onClick={() => navigate(`/app/academy/invoices/${inv.id}/edit`)}
                      >
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-mono font-medium truncate">{inv.invoice_number}</p>
                          <p className="text-xs text-muted-foreground truncate">{inv.player_name}</p>
                        </div>
                        <span className="text-sm font-medium shrink-0">{formatCurrency(inv.total)}</span>
                        {displayStatus === 'paid' && (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-300">
                            <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                            {t('invoices.paid', 'Paid')}
                          </Badge>
                        )}
                        {displayStatus === 'sent' && (
                          <Badge variant="default" className="text-[10px] h-5 px-1.5">
                            {t('invoices.sent', 'Sent')}
                          </Badge>
                        )}
                        {displayStatus === 'draft' && (
                          <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                            {t('invoices.draft', 'Draft')}
                          </Badge>
                        )}
                        {displayStatus === 'overdue' && (
                          <Badge variant="destructive" className="text-[10px] h-5 px-1.5">
                            {t('invoices.overdue', 'Overdue')}
                          </Badge>
                        )}
                        {displayStatus === 'cancelled' && (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5">
                            {t('invoices.cancelled', 'Cancelled')}
                          </Badge>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tTrainer('calendar.deleteSlot', 'Delete slot')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tTrainer('calendar.deleteSlotConfirm', 'Are you sure you want to delete this slot? This cannot be undone.')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {detail.cyclus_id && (
            <div className="flex items-center space-x-2 py-2">
              <Checkbox
                id="delete-cyclus"
                checked={deleteCyclus}
                onCheckedChange={c => setDeleteCyclus(!!c)}
              />
              <Label htmlFor="delete-cyclus" className="text-sm font-normal cursor-pointer">
                {tTrainer('calendar.deleteEntireCyclus', 'Delete all future slots in this cyclus')}
              </Label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tCommon('cancel', 'Cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tCommon('delete', 'Delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
