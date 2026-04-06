import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS, es, de, fr } from 'date-fns/locale';
import {
  ArrowLeft, Calendar, Clock, Lock, MapPin, Users, Pencil,
  Trash2, UserPlus, DollarSign, Loader2, Save, X, Check, Plus, Minus,
  AlertTriangle, Settings,
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { syncInvoicesAfterPriceChange, syncInvoicesAfterBookingRemoval, syncSplitCountForCycle } from '@/lib/invoiceSync';
import { useToast } from '@/hooks/use-toast';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { BookForPlayerDialog } from '@/components/trainer/BookForPlayerDialog';
import { EditBookingDialog } from '@/components/trainer/EditBookingDialog';
import { SlotRatingPicker } from '@/components/trainer/SlotRatingPicker';
import { useTrainerRatingSystem } from '@/hooks/useTrainerRatingSystem';
import { BookedPlayer } from '@/components/trainer/CalendarSlotCard';

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

export default function AcademySlotDetail() {
  const { slotId } = useParams<{ slotId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const dateLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split('-')[0]] || enUS;
  const { activeAcademy } = useAcademyContext();

  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<SlotDetail | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit form state
  const [editDate, setEditDate] = useState('');
  const [editStartTime, setEditStartTime] = useState('');
  const [editDuration, setEditDuration] = useState(60);
  const [editTrainerId, setEditTrainerId] = useState('');
  const [editLocationId, setEditLocationId] = useState('none');
  const [editMaxParticipants, setEditMaxParticipants] = useState(4);
  const [editRatingSystem, setEditRatingSystem] = useState<string | null>(null);
  const [editMinRating, setEditMinRating] = useState<number | null>(null);
  const [editMaxRating, setEditMaxRating] = useState<number | null>(null);
  const [editCyclusName, setEditCyclusName] = useState('');
  const [editPricePerSession, setEditPricePerSession] = useState<string>('');
  const [editTotalPrice, setEditTotalPrice] = useState<string>('');
  const [editSplitPayment, setEditSplitPayment] = useState(false);
  const [editPricesIncludeVat, setEditPricesIncludeVat] = useState(true);
  const [editExtraCosts, setEditExtraCosts] = useState<ExtraCost[]>([]);
  const [editIsMarkedFull, setEditIsMarkedFull] = useState(false);
  const [applyToCyclus, setApplyToCyclus] = useState(false);

  // Lookup data
  const [trainers, setTrainers] = useState<TrainerOption[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);

  // Dialog state
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteCyclus, setDeleteCyclus] = useState(false);
  const [bookForPlayerOpen, setBookForPlayerOpen] = useState(false);
  const [editBookingOpen, setEditBookingOpen] = useState(false);
  const [bookingToEdit, setBookingToEdit] = useState<any>(null);

  // Warning state
  const [warningThresholds, setWarningThresholds] = useState<{ maxRatingSpread: number | null; maxAgeDiff: number | null }>({ maxRatingSpread: null, maxAgeDiff: null });
  const [dismissedWarnings, setDismissedWarnings] = useState<string[]>([]);
  const [dismissingWarning, setDismissingWarning] = useState<string | null>(null);

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

      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('id, user_id')
        .eq('id', slot.trainer_id)
        .single();

      let trainerName = 'Unknown';
      let trainerAvatar: string | null = null;
      if (trainerProfile) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, avatar_url')
          .eq('user_id', trainerProfile.user_id)
          .single();
        if (profile) {
          trainerName = profile.full_name || 'Unknown';
          trainerAvatar = profile.avatar_url;
        }
      }

      const { data: bookings } = await supabase
        .from('bookings')
        .select(`
          id, status, player_id, guest_player_id, payment_status, payment_amount, paid_externally,
          profiles:player_id(full_name, avatar_url, skill_rating, rating_system, birth_date),
          guest_players:guest_player_id(full_name, skill_rating, rating_system, birth_date)
        `)
        .eq('slot_id', slotId)
        .in('status', ['confirmed', 'pending']);

      const players: BookedPlayer[] = (bookings || []).map(b => {
        const prof = b.profiles as any;
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
          birthDate: prof?.birth_date || guest?.birth_date || null,
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
        max_participants: slot.max_participants || 4,
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
      toast({ title: tCommon('error'), description: 'Failed to load slot details', variant: 'destructive' });
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

  useEffect(() => {
    if (!activeAcademy) return;
    (async () => {
      try {
        const academyTrainers = await getAcademyTrainersWithProfiles(activeAcademy.id);
        setTrainers(
          academyTrainers
            .filter((t: any) => t.status === 'active' && t.trainer_profile)
            .map((t: any) => ({ id: t.trainer_profile.id, name: t.profile?.full_name || 'Unknown' }))
        );
        const academyLocations = await getAcademyLocations(activeAcademy.id);
        setLocations(academyLocations.map((al: any) => ({ id: al.location.id, name: al.location.name })));
      } catch (e) {
        logger.error('Error loading academy data for slot detail', e as Error);
      }
    })();
  }, [activeAcademy]);

  // Auto-open edit mode on first load
  const autoEditTriggered = useRef(false);
  useEffect(() => {
    if (detail && !autoEditTriggered.current) {
      autoEditTriggered.current = true;
      startEditing();
    }
  }, [detail]);

  const startEditing = () => {
    if (!detail) return;
    const start = new Date(detail.start_time);
    const end = new Date(detail.end_time);
    setEditDate(format(start, 'yyyy-MM-dd'));
    setEditStartTime(format(start, 'HH:mm'));
    setEditDuration(Math.round((end.getTime() - start.getTime()) / 60000));
    setEditTrainerId(detail.trainer_id);
    setEditLocationId(detail.location_id || 'none');
    setEditMaxParticipants(detail.max_participants);
    setEditRatingSystem(detail.rating_system);
    setEditMinRating(detail.min_rating);
    setEditMaxRating(detail.max_rating);
    setEditCyclusName(detail.cyclus_name || '');
    setEditPricePerSession(detail.price_per_session != null ? String(detail.price_per_session) : '');
    setEditTotalPrice(detail.total_price != null ? String(detail.total_price) : '');
    setEditSplitPayment(detail.split_payment);
    setEditPricesIncludeVat(detail.prices_include_vat);
    setEditExtraCosts(detail.extra_costs ? [...detail.extra_costs] : []);
    setEditIsMarkedFull(!detail.is_public);
    setApplyToCyclus(false);
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const [hours, minutes] = editStartTime.split(':').map(Number);
      const startDateTime = new Date(editDate);
      startDateTime.setHours(hours, minutes, 0, 0);
      const endDateTime = new Date(startDateTime);
      endDateTime.setMinutes(endDateTime.getMinutes() + editDuration);

      const isCycleSlot = !!detail.cyclus_id;

      const updatePayload: any = {
        start_time: startDateTime.toISOString(),
        end_time: endDateTime.toISOString(),
        trainer_id: editTrainerId,
        location_id: editLocationId === 'none' ? null : editLocationId,
        max_participants: editMaxParticipants,
        rating_system: editRatingSystem,
        min_rating: editMinRating,
        max_rating: editMaxRating,
        cyclus_name: editCyclusName || null,
        is_public: !editIsMarkedFull,
      };

      // Only include pricing fields if slot does NOT belong to a cycle
      if (!isCycleSlot) {
        updatePayload.price_per_session = editPricePerSession ? Number(editPricePerSession) : null;
        updatePayload.total_price = editTotalPrice ? Number(editTotalPrice) : null;
        updatePayload.split_payment = editSplitPayment;
        updatePayload.prices_include_vat = editPricesIncludeVat;
        updatePayload.extra_costs = editExtraCosts.length > 0 ? editExtraCosts : null;
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
          csEnd.setMinutes(csEnd.getMinutes() + editDuration);

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
        const priceChanged = detail.price_per_session !== (editPricePerSession ? Number(editPricePerSession) : null);
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
        const priceChanged = detail.price_per_session !== (editPricePerSession ? Number(editPricePerSession) : null);
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
      toast({ title: tCommon('error'), description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
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

      // Get bookings for these slots to sync invoices
      const { data: slotBookings } = await supabase
        .from('bookings')
        .select('id')
        .in('slot_id', slotIdsToDelete)
        .in('status', ['confirmed', 'pending']);
      const bookingIdsToRemove = (slotBookings || []).map(b => b.id);

      if (deleteCyclus && detail.cyclus_id) {
        const { error } = await supabase
          .from('availability_slots')
          .delete()
          .eq('cyclus_id', detail.cyclus_id)
          .gte('start_time', new Date().toISOString());
        if (error) throw error;
        toast({ title: tTrainer('calendar.cyclusDeleted', 'Cyclus deleted') });
      } else {
        const { error } = await supabase
          .from('availability_slots')
          .delete()
          .eq('id', detail.id);
        if (error) throw error;
        toast({ title: tTrainer('calendar.slotDeleted', 'Slot deleted') });
      }

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
      toast({ title: tCommon('error'), description: error.message, variant: 'destructive' });
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  const handleEditBooking = async (bookingId: string) => {
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
      setBookingToEdit({ ...data, player: data.profiles });
      setEditBookingOpen(true);
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
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
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
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
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
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
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
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('calendar.date', 'Date')}</Label>
                      <Input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t('calendar.time', 'Time')}</Label>
                      <Input type="time" value={editStartTime} onChange={e => setEditStartTime(e.target.value)} />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">{tTrainer('calendar.duration', 'Duration')}</Label>
                    <Select value={String(editDuration)} onValueChange={v => setEditDuration(Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="30">30 min</SelectItem>
                        <SelectItem value="45">45 min</SelectItem>
                        <SelectItem value="60">60 min</SelectItem>
                        <SelectItem value="90">90 min</SelectItem>
                        <SelectItem value="120">120 min</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {trainers.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{tTrainer('calendar.trainer', 'Trainer')}</Label>
                      <Select value={editTrainerId} onValueChange={setEditTrainerId}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {trainers.map(tr => (
                            <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {locations.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">{tTrainer('calendar.location', 'Location')}</Label>
                      <Select value={editLocationId} onValueChange={setEditLocationId}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{tTrainer('calendar.noLocation', 'No location')}</SelectItem>
                          {locations.map(loc => (
                            <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {(() => {
                    const isCycleSlot = !!detail.cyclus_id;
                    return (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs">{tTrainer('calendar.maxParticipants', 'Max participants')}</Label>
                            <Input
                              type="number" min={1} max={20}
                              value={editMaxParticipants}
                              onChange={e => setEditMaxParticipants(Number(e.target.value))}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">{tTrainer('calendar.price', 'Price')}</Label>
                            <Input
                              type="number" step="0.01" min={0}
                              value={editPricePerSession}
                              onChange={e => setEditPricePerSession(e.target.value)}
                              placeholder="€"
                              disabled={isCycleSlot}
                              className={isCycleSlot ? 'opacity-60' : ''}
                            />
                          </div>
                        </div>

                        {/* Total price */}
                        <div className="space-y-1.5">
                          <Label className="text-xs">{t('calendar.totalPrice', 'Total price (full cyclus)')}</Label>
                          <Input
                            type="number" step="0.01" min={0}
                            value={editTotalPrice}
                            onChange={e => setEditTotalPrice(e.target.value)}
                            placeholder="€"
                            disabled={isCycleSlot}
                            className={isCycleSlot ? 'opacity-60' : ''}
                          />
                        </div>

                        {isCycleSlot && (
                          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                            <DollarSign className="h-3.5 w-3.5 shrink-0" />
                            <span>{t('calendar.pricingManagedByCycle', 'Pricing is managed at the cycle level.')}</span>
                            <Button
                              type="button"
                              variant="link"
                              size="sm"
                              className="h-auto p-0 text-xs ml-auto"
                              onClick={() => navigate(`/app/academy/cycles/${detail.cyclus_id}`)}
                            >
                              {t('calendar.editCyclePricing', 'Edit cycle pricing →')}
                            </Button>
                          </div>
                        )}

                        <Separator />

                        {/* VAT mode */}
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">{t('calendar.pricesIncludeVat', 'Prices include VAT')}</Label>
                          <Switch checked={editPricesIncludeVat} onCheckedChange={setEditPricesIncludeVat} disabled={isCycleSlot} />
                        </div>

                        {/* Split payment */}
                        <div className="flex items-center justify-between">
                          <div>
                            <Label className="text-xs">{t('calendar.splitPayment', 'Split payment')}</Label>
                            <p className="text-[10px] text-muted-foreground">{t('calendar.splitPaymentDesc', 'Each player pays individually')}</p>
                          </div>
                          <Switch checked={editSplitPayment} onCheckedChange={setEditSplitPayment} disabled={isCycleSlot} />
                        </div>

                        {/* Mark as private */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Lock className="h-4 w-4 text-muted-foreground" />
                            <Label className="text-xs">{t('calendar.markPrivate', 'Mark as private')}</Label>
                          </div>
                          <Switch checked={editIsMarkedFull} onCheckedChange={setEditIsMarkedFull} />
                        </div>

                        <Separator />

                        {/* Extra costs */}
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">{t('calendar.extraCosts', 'Extra costs')}</Label>
                            {!isCycleSlot && (
                              <Button
                                type="button" size="sm" variant="ghost" className="h-6 px-2 gap-1 text-xs"
                                onClick={() => setEditExtraCosts([...editExtraCosts, { description: '', amount: 0, type: 'one_time' }])}
                              >
                                <Plus className="h-3 w-3" /> {tCommon('add', 'Add')}
                              </Button>
                            )}
                          </div>
                          {editExtraCosts.map((ec, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <Input
                                className={`flex-1 h-8 text-xs ${isCycleSlot ? 'opacity-60' : ''}`}
                                placeholder={t('calendar.description', 'Description')}
                                value={ec.description}
                                disabled={isCycleSlot}
                                onChange={e => {
                                  const updated = [...editExtraCosts];
                                  updated[idx] = { ...updated[idx], description: e.target.value };
                                  setEditExtraCosts(updated);
                                }}
                              />
                              <Input
                                className={`w-20 h-8 text-xs ${isCycleSlot ? 'opacity-60' : ''}`}
                                type="number" step="0.01" min={0}
                                placeholder="€"
                                value={ec.amount || ''}
                                disabled={isCycleSlot}
                                onChange={e => {
                                  const updated = [...editExtraCosts];
                                  updated[idx] = { ...updated[idx], amount: Number(e.target.value) };
                                  setEditExtraCosts(updated);
                                }}
                              />
                              <Select
                                value={ec.type}
                                disabled={isCycleSlot}
                                onValueChange={v => {
                                  const updated = [...editExtraCosts];
                                  updated[idx] = { ...updated[idx], type: v as 'one_time' | 'per_session' };
                                  setEditExtraCosts(updated);
                                }}
                              >
                                <SelectTrigger className={`w-28 h-8 text-xs ${isCycleSlot ? 'opacity-60' : ''}`}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="one_time">{t('calendar.oneTime', 'One-time')}</SelectItem>
                                  <SelectItem value="per_session">{t('calendar.perSession', 'Per session')}</SelectItem>
                                </SelectContent>
                              </Select>
                              {!isCycleSlot && (
                                <Button
                                  type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0"
                                  onClick={() => setEditExtraCosts(editExtraCosts.filter((_, i) => i !== idx))}
                                >
                                  <Minus className="h-3 w-3" />
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    );
                  })()}

                  <Separator />

                  <SlotRatingPicker
                    ratingSystem={editRatingSystem}
                    minRating={editMinRating}
                    maxRating={editMaxRating}
                    onChange={vals => {
                      setEditRatingSystem(vals.ratingSystem);
                      setEditMinRating(vals.minRating);
                      setEditMaxRating(vals.maxRating);
                    }}
                    fixedRatingSystem={trainerRatingSystem}
                  />

                  {detail.cyclus_id && (
                    <>
                      <div className="space-y-1.5">
                        <Label className="text-xs">{tTrainer('calendar.cyclusName', 'Cyclus name')}</Label>
                        <Input value={editCyclusName} onChange={e => setEditCyclusName(e.target.value)} />
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="apply-cyclus"
                          checked={applyToCyclus}
                          onCheckedChange={c => setApplyToCyclus(!!c)}
                        />
                        <Label htmlFor="apply-cyclus" className="text-xs font-normal cursor-pointer">
                          {tTrainer('calendar.applyToCyclus', 'Apply to all future slots in this cyclus')}
                        </Label>
                      </div>
                    </>
                  )}

                  <div className="flex gap-2 pt-2">
                    <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      {tCommon('save', 'Save')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setIsEditing(false)} disabled={saving} className="gap-1.5">
                      <X className="h-3.5 w-3.5" />
                      {tCommon('cancel', 'Cancel')}
                    </Button>
                  </div>
                </div>
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
                        €{detail.price_per_session.toFixed(2)} / {t('calendar.session', 'session')}
                      </Badge>
                    )}
                    {detail.total_price != null && (
                      <Badge variant="outline" className="gap-1">
                        <DollarSign className="h-3 w-3" />
                        €{detail.total_price.toFixed(2)} {t('calendar.total', 'total')}
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
                          {ec.description}: €{ec.amount.toFixed(2)} ({ec.type === 'one_time' ? t('calendar.oneTime', 'One-time') : t('calendar.perSession', 'Per session')})
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
                  onClick={() => setBookForPlayerOpen(true)}
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
                    <button
                      key={player.bookingId}
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
                  ))}
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

      {/* Book For Player Dialog */}
      <BookForPlayerDialog
        open={bookForPlayerOpen}
        onOpenChange={setBookForPlayerOpen}
        trainerId={detail.trainer_id}
        slot={{
          id: detail.id,
          start_time: detail.start_time,
          end_time: detail.end_time,
          cyclus_id: detail.cyclus_id,
          cyclus_name: detail.cyclus_name,
          booked_players: detail.booked_players,
        }}
        onBookingCreated={fetchSlotDetail}
      />

      {/* Edit Booking Dialog */}
      <EditBookingDialog
        open={editBookingOpen}
        onOpenChange={open => {
          setEditBookingOpen(open);
          if (!open) setBookingToEdit(null);
        }}
        booking={bookingToEdit}
        trainerId={detail.trainer_id}
        onBookingUpdated={fetchSlotDetail}
      />
    </div>
  );
}
