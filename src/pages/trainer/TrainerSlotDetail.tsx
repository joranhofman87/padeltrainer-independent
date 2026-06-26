import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format, isPast } from 'date-fns';
import { nl, enUS, es, de, fr } from 'date-fns/locale';
import {
  ArrowLeft, Calendar, Lock, MapPin, Users, Pencil,
  Trash2, UserPlus, DollarSign, Loader2, Check,
  FileText, CheckCircle2,
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';
import { formatCurrency } from '@/lib/format';
import { logger } from '@/lib/logger';
import { syncInvoicesAfterPriceChange, syncSplitCountForCycle } from '@/lib/invoiceSync';
import { applySlotDeleteToCycle } from '@/lib/slotDeleteGuard';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
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
import { applySlotEditToCycle } from '@/lib/cycles';
import { buildCycleEditPatch, slotEditBaselineFromSlot } from '@/lib/cycleEditPatch';
import { useTrainerRatingSystem } from '@/hooks/useTrainerRatingSystem';
import { BookedPlayer } from '@/components/trainer/CalendarSlotCard';
import { SlotAttendanceCard } from '@/components/attendance/SlotAttendanceCard';
import PriorityClaimsSection from '@/components/cycles/PriorityClaimsSection';
import SlotTierControlCard from '@/components/cycles/SlotTierControlCard';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';

const dateFnsLocales: Record<string, typeof enUS> = { nl, en: enUS, es, de, fr };

interface ExtraCost { description: string; amount: number; type: 'one_time' | 'per_session'; }

interface SlotDetail {
  id: string; start_time: string; end_time: string; trainer_id: string;
  location_id: string | null; location_name: string | null;
  cyclus_id: string | null; cyclus_name: string | null;
  max_participants: number; is_public: boolean;
  rating_system: string | null; min_rating: number | null; max_rating: number | null;
  price_per_session: number | null; total_price: number | null;
  split_payment: boolean; prices_include_vat: boolean;
  extra_costs: ExtraCost[] | null;
  booked_players: BookedPlayer[];
}

interface SlotInvoice {
  id: string; invoice_number: string; player_name: string; total: number; status: string; due_date: string; paid_at: string | null;
}

export default function TrainerSlotDetail() {
  const { slotId } = useParams<{ slotId: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const { user } = useAuth();
  const dateLocale = dateFnsLocales[i18n.language] || dateFnsLocales[i18n.language?.split('-')[0]] || enUS;

  const { data: coachingNotes = [] } = usePlayerCoachingNotes(slotId);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<SlotDetail | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);


  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteCyclus, setDeleteCyclus] = useState(false);
  const [showBookPlayer, setShowBookPlayer] = useState(false);
  const [editingBookingId, setEditingBookingId] = useState<string | null>(null);
  const [editingBookingData, setEditingBookingData] = useState<any>(null);
  const [slotInvoices, setSlotInvoices] = useState<SlotInvoice[]>([]);

  const { trainerRatingSystem } = useTrainerRatingSystem(detail?.trainer_id || undefined);

  const fetchSlotDetail = useCallback(async () => {
    if (!slotId) return;
    setLoading(true);
    try {
      const { data: slot, error } = await supabase
        .from('availability_slots')
        .select('id, start_time, end_time, trainer_id, max_participants, cyclus_id, cyclus_name, location_id, is_public, rating_system, min_rating, max_rating, price_per_session, total_price, split_payment, prices_include_vat, extra_costs, locations:location_id(name)')
        .eq('id', slotId).single();
      if (error) throw error;

      const { data: bookings } = await supabase
        .from('bookings')
        .select('id, status, player_id, guest_player_id, payment_status, payment_amount, paid_externally, profiles:player_id(full_name, avatar_url, skill_rating, rating_system, birth_date), guest_players:guest_player_id(full_name, skill_rating, rating_system, birth_date)')
        .eq('slot_id', slotId).in('status', [...CAPACITY_OCCUPYING_STATUSES]);

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
          paymentStatus: b.payment_status as string | undefined,
          paidExternally: Boolean(b.paid_externally),
        };
      });

      setDetail({
        id: slot.id, start_time: slot.start_time, end_time: slot.end_time,
        trainer_id: slot.trainer_id,
        location_id: slot.location_id, location_name: (slot.locations as any)?.name || null,
        cyclus_id: slot.cyclus_id, cyclus_name: slot.cyclus_name,
        max_participants: slot.max_participants || 4, is_public: slot.is_public,
        rating_system: slot.rating_system, min_rating: slot.min_rating, max_rating: slot.max_rating,
        price_per_session: slot.price_per_session, total_price: slot.total_price,
        split_payment: slot.split_payment ?? false, prices_include_vat: slot.prices_include_vat ?? true,
        extra_costs: (slot.extra_costs as unknown as ExtraCost[] | null) || null,
        booked_players: players,
      });
    } catch (error) {
      logger.error('Error fetching slot detail', error as Error, { slotId });
      toast({ title: tCommon('error'), description: 'Failed to load slot details', variant: 'destructive' });
    } finally { setLoading(false); }
  }, [slotId]);

  useEffect(() => { fetchSlotDetail(); }, [fetchSlotDetail]);

  // Fetch invoices
  useEffect(() => {
    if (!detail || detail.booked_players.length === 0) { setSlotInvoices([]); return; }
    const bookingIds = detail.booked_players.map(p => p.bookingId);
    (async () => {
      const { data } = await supabase.from('invoices').select('id, invoice_number, player_name, total, status, due_date, paid_at').overlaps('booking_ids', bookingIds).order('invoice_number');
      setSlotInvoices((data as SlotInvoice[]) || []);
    })();
  }, [detail]);

  // Fetch locations for this trainer
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      const { data: tp } = await supabase.from('trainer_profiles').select('id').eq('user_id', user.id).single();
      if (!tp) return;
      const { data: slots } = await supabase.from('availability_slots').select('location_id').eq('trainer_id', tp.id).not('location_id', 'is', null);
      if (!slots) return;
      const locIds = [...new Set(slots.map(s => s.location_id).filter(Boolean))] as string[];
      if (locIds.length === 0) return;
      const { data: locs } = await supabase.from('locations').select('id, name').in('id', locIds);
      setLocations((locs || []).map(l => ({ id: l.id, name: l.name })));
    })();
  }, [user?.id]);

  // Auto-open edit mode. SlotEditForm initialises its own fields from the slot (key={slot.id}).
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
        start_time: startDateTime.toISOString(), end_time: endDateTime.toISOString(),
        location_id: values.locationId === 'none' ? null : values.locationId,
        max_participants: values.maxParticipants,
        rating_system: values.ratingSystem, min_rating: values.minRating, max_rating: values.maxRating,
        cyclus_name: values.cyclusName || null, is_public: !values.isMarkedFull,
      };

      if (!isCycleSlot) {
        updatePayload.price_per_session = values.pricePerSession ? Number(values.pricePerSession) : null;
        updatePayload.total_price = values.totalPrice ? Number(values.totalPrice) : null;
        updatePayload.split_payment = values.splitPayment;
        updatePayload.prices_include_vat = values.pricesIncludeVat;
        updatePayload.extra_costs = values.extraCosts.length > 0 ? values.extraCosts : null;
      }

      if (applyToCyclus && detail.cyclus_id) {
        // Canonical whole-cycle edit — same atomic RPC + change-diff as CycleDetailView (one path for
        // "edit the whole cycle"). Only changed fields apply to future sessions; the capacity guard
        // blocks any shrink below occupancy. Non-price path → no invoice resync.
        const { data: futureSlots, error: fetchError } = await supabase
          .from('availability_slots').select('id').eq('cyclus_id', detail.cyclus_id)
          .gte('start_time', new Date().toISOString());
        if (fetchError) throw fetchError;
        const futureSlotIds = (futureSlots || []).map((s) => s.id);
        const patch = buildCycleEditPatch(values, slotEditBaselineFromSlot(detail));
        const res =
          Object.keys(patch).length > 0
            ? await applySlotEditToCycle(detail.cyclus_id, futureSlotIds, patch)
            : { updatedCount: 0, blockedCount: 0, blockedSlotIds: [] };
        if (res.blockedCount > 0 && res.updatedCount === 0) {
          toast({ title: tCommon('error'), description: t('calendar.cyclusEditBlocked', '{{count}} sessions left unchanged — more players are booked than the new capacity', { count: res.blockedCount }), variant: 'destructive' });
        } else {
          toast({ title: t('calendar.cyclusUpdated', 'Cyclus bijgewerkt') });
        }
      } else {
        const { error } = await supabase.from('availability_slots').update(updatePayload).eq('id', detail.id);
        if (error) throw error;
        const priceChanged = detail.price_per_session !== (values.pricePerSession ? Number(values.pricePerSession) : null);
        if (priceChanged) { try { await syncInvoicesAfterPriceChange([detail.id]); } catch (e) { logger.error('Failed to sync invoices', e as Error); } }
        toast({ title: t('calendar.slotUpdated', 'Sessie bijgewerkt') });
      }
      setIsEditing(false);
      fetchSlotDetail();
    } catch (error: any) {
      logger.error('Error updating slot', error, { slotId: detail.id });
      toast({ title: tCommon('error'), description: getFriendlyErrorMessage(error, t('calendar.slotUpdateError', 'De wijzigingen konden niet worden opgeslagen. Probeer het opnieuw.')), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!detail) return;
    setDeleting(true);
    try {
      let slotIds: string[];
      if (deleteCyclus && detail.cyclus_id) {
        const { data: cyclusSlots } = await supabase.from('availability_slots').select('id').eq('cyclus_id', detail.cyclus_id).gte('start_time', new Date().toISOString());
        slotIds = (cyclusSlots || []).map(s => s.id);
      } else { slotIds = [detail.id]; }

      // Canonical atomic delete (same RPC CycleDetailView uses): locks bookings FOR UPDATE, deletes
      // only the unbooked slots, stamps invoices.split_count — closes the old check-then-delete TOCTOU
      // vs bookings.slot_id ON DELETE CASCADE. Booked slots are kept.
      const res = await applySlotDeleteToCycle(detail.cyclus_id ?? null, slotIds);
      if (res.deletedCount === 0) {
        toast({
          title: t('calendar.slotHasBooking', 'Kan deze sessie niet verwijderen'),
          description: t('calendar.slotHasBookingDescription', 'Er is nog een actieve boeking. Annuleer eerst de boeking en verwijder daarna.'),
          variant: 'destructive',
        });
        return;
      }
      if (detail.cyclus_id) { try { await syncSplitCountForCycle(detail.cyclus_id); } catch (e) { logger.error('Sync fail', e as Error); } }
      toast({ title: deleteCyclus ? t('calendar.cyclusDeleted', 'Cyclus verwijderd') : t('calendar.slotDeleted', 'Sessie verwijderd') });
      navigate('/app/trainer/calendar');
    } catch (error: any) {
      logger.error('Error deleting slot', error, { slotId: detail.id });
      toast({ title: tCommon('error'), description: getFriendlyErrorMessage(error, t('calendar.slotDeleteError', 'Het verwijderen is niet gelukt. Probeer het opnieuw.')), variant: 'destructive' });
    } finally { setDeleting(false); setDeleteOpen(false); }
  };

  const handleEditBooking = async (bookingId: string) => {
    if (editingBookingId === bookingId) {
      setEditingBookingId(null);
      setEditingBookingData(null);
      return;
    }
    try {
      const { data, error } = await supabase.from('bookings')
        .select('id, status, notes, payment_status, payment_amount, guest_player_id, paid_externally, availability_slots (id, start_time, end_time, price_per_session, cyclus_name), profiles:player_id (id, full_name, email)')
        .eq('id', bookingId).single();
      if (error) throw error;
      setEditingBookingData({ ...data, player: data.profiles });
      setEditingBookingId(bookingId);
    } catch (error) { logger.error('Error fetching booking', error instanceof Error ? error : new Error(String(error))); }
  };

  const calculateAge = (birthDate: string | null): number | null => {
    if (!birthDate) return null;
    return Math.floor((Date.now() - new Date(birthDate).getTime()) / 31557600000);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="border-b bg-background/60"><div className="container mx-auto px-4 py-3 flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate(-1)}><ArrowLeft className="h-5 w-5" /></Button>
          <Skeleton className="h-6 w-48" />
        </div></div>
        <main className="container mx-auto px-4 py-6 space-y-4"><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></main>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="min-h-screen bg-background"><div className="border-b bg-background/60"><div className="container mx-auto px-4 py-3 flex items-center gap-4">
        <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate(-1)}><ArrowLeft className="h-5 w-5" /></Button>
        <h1 className="text-xl font-bold">{t('calendar.slotNotFound', 'Sessie niet gevonden')}</h1>
      </div></div></div>
    );
  }

  const bookedCount = detail.booked_players.length;
  const startDate = new Date(detail.start_time);
  const endDate = new Date(detail.end_time);

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b bg-background/60">
        <div className="container mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate(-1)}><ArrowLeft className="h-5 w-5" /></Button>
            <div>
              <h1 className="text-lg font-bold">{format(startDate, 'EEEE d MMMM yyyy', { locale: dateLocale })}</h1>
              <p className="text-sm text-muted-foreground">
                {format(startDate, 'HH:mm')} – {format(endDate, 'HH:mm')}
                {detail.location_name && ` · ${detail.location_name}`}
              </p>
            </div>
          </div>
        </div>
      </div>

      <main className="container mx-auto px-0 py-6 sm:px-4">
        <div className="flex items-center justify-end gap-2 max-w-4xl mb-4">
          <Button variant="outline" aria-label={t('calendar.deleteSlot', 'Sessie verwijderen')} className="gap-1.5 text-destructive hover:text-destructive" onClick={() => { setDeleteCyclus(false); setDeleteOpen(true); }}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl">
          {/* Details card */}
          <Card className={flushOnMobileCardClass()}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2"><Calendar className="h-4 w-4" />{t('calendar.details', 'Details')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {isEditing ? (
                <SlotEditForm
                  key={detail.id}
                  slot={detail}
                  namespace="trainer"
                  locations={locations}
                  fixedRatingSystem={trainerRatingSystem}
                  isSaving={saving}
                  onSubmit={handleSave}
                  onCancel={() => setIsEditing(false)}
                />
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {detail.location_name && <Badge variant="outline" className="gap-1"><MapPin className="h-3 w-3" />{detail.location_name}</Badge>}
                    {detail.cyclus_name && <Badge variant="secondary">{detail.cyclus_name}</Badge>}
                    {!detail.is_public && <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300"><Lock className="h-3 w-3" />{t('calendar.private', 'Privé')}</Badge>}
                    {detail.price_per_session != null && <Badge variant="outline" className="gap-1"><DollarSign className="h-3 w-3" />{formatCurrency(detail.price_per_session)} / sessie</Badge>}
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2"><Lock className="h-4 w-4 text-muted-foreground" /><span className="text-sm">{t('calendar.markPrivate', 'Privé')}</span></div>
                    <Switch checked={!detail.is_public} onCheckedChange={async () => {
                      const newVal = !detail.is_public;
                      await supabase.from('availability_slots').update({ is_public: newVal }).eq('id', detail.id);
                      setDetail({ ...detail, is_public: newVal });
                    }} />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Players */}
          <Card className={flushOnMobileCardClass()}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" />{t('calendar.players', 'Spelers')} ({bookedCount}/{detail.max_participants})</CardTitle>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowBookPlayer(!showBookPlayer)}><UserPlus className="h-3.5 w-3.5" />{t('calendar.addPlayer', 'Speler toevoegen')}</Button>
              </div>
            </CardHeader>
            <CardContent>
              {detail.booked_players.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('calendar.noPlayersYet', 'Nog geen spelers ingeschreven')}</p>
              ) : (
                <div className="space-y-1">
                  {detail.booked_players.map(player => (
                    <div key={player.bookingId}>
                      <button className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent/50 transition-colors text-left" onClick={() => handleEditBooking(player.bookingId)}>
                        <Avatar className="h-8 w-8"><AvatarImage src={(player as any).avatarUrl || undefined} /><AvatarFallback className="text-[10px]">{player.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{player.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {[player.skillRating != null ? `${player.ratingSystem?.toUpperCase()} ${player.skillRating}` : null, calculateAge(player.birthDate) != null ? `${calculateAge(player.birthDate)} jr` : null].filter(Boolean).join(' · ') || '\u00A0'}
                          </p>
                        </div>
                        {player.isGuest && <Badge variant="outline" className="text-[10px] h-5 px-1.5">Gast</Badge>}
                        {player.status === 'confirmed' ? (
                          <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-300"><Check className="h-2.5 w-2.5 mr-0.5" />{tCommon('confirmed', 'Bevestigd')}</Badge>
                        ) : (<Badge variant="outline" className="text-[10px] h-5 px-1.5 text-amber-600 border-amber-300">{tCommon('pending', 'Wachtend')}</Badge>)}
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      </button>
                      {editingBookingId === player.bookingId && editingBookingData && (
                        <InlineEditBooking
                          booking={editingBookingData}
                          trainerId={detail.trainer_id}
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
                            authorRole="trainer"
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
            <SlotAttendanceCard slotId={detail.id} bookedPlayers={detail.booked_players.map(p => ({ id: p.id, name: p.name, profileId: p.id }))} isPastSlot={true} />
          )}

          {/* Invoices */}
          <Card className={flushOnMobileCardClass()}>
            <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2"><FileText className="h-4 w-4" />{t('calendar.invoices', 'Facturen')}</CardTitle></CardHeader>
            <CardContent>
              {slotInvoices.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">{t('calendar.noInvoices', 'Geen facturen gekoppeld aan deze sessie')}</p>
              ) : (
                <div className="space-y-1">
                  {slotInvoices.map(inv => {
                    const isOverdue = inv.status === 'sent' && new Date(inv.due_date) < new Date();
                    const displayStatus = isOverdue ? 'overdue' : inv.status;
                    return (
                      <button key={inv.id} className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-accent/50 transition-colors text-left" onClick={() => navigate(`/app/trainer/invoices/${inv.id}/edit`)}>
                        <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0"><p className="text-sm font-mono font-medium truncate">{inv.invoice_number}</p><p className="text-xs text-muted-foreground truncate">{inv.player_name}</p></div>
                        <span className="text-sm font-medium shrink-0">{formatCurrency(inv.total)}</span>
                        {displayStatus === 'paid' && <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-300"><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />{t('invoices.paid', 'Betaald')}</Badge>}
                        {displayStatus === 'sent' && <Badge variant="default" className="text-[10px] h-5 px-1.5">{t('invoices.sent', 'Verstuurd')}</Badge>}
                        {displayStatus === 'draft' && <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{t('invoices.draft', 'Concept')}</Badge>}
                        {displayStatus === 'overdue' && <Badge variant="destructive" className="text-[10px] h-5 px-1.5">{t('invoices.overdue', 'Verlopen')}</Badge>}
                        {displayStatus === 'cancelled' && <Badge variant="outline" className="text-[10px] h-5 px-1.5">{t('invoices.cancelled', 'Geannuleerd')}</Badge>}
                      </button>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Delete Dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('calendar.deleteSlot', 'Sessie verwijderen')}</AlertDialogTitle>
            <AlertDialogDescription>{t('calendar.deleteSlotConfirm', 'Weet je zeker dat je deze sessie wilt verwijderen?')}</AlertDialogDescription>
          </AlertDialogHeader>
          {detail.cyclus_id && (
            <div className="flex items-center space-x-2 py-2">
              <Checkbox id="delete-cyclus" checked={deleteCyclus} onCheckedChange={c => setDeleteCyclus(!!c)} />
              <Label htmlFor="delete-cyclus" className="text-sm font-normal cursor-pointer">{t('calendar.deleteEntireCyclus', 'Alle toekomstige sessies verwijderen')}</Label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{tCommon('cancel', 'Annuleren')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{tCommon('delete', 'Verwijderen')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
