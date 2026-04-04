import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS, es, de, fr } from 'date-fns/locale';
import {
  ArrowLeft, Calendar, Clock, Lock, MapPin, Users, Pencil,
  Trash2, UserPlus, DollarSign, Loader2, Save, X, Check,
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { syncInvoicesAfterPriceChange, syncInvoicesAfterBookingRemoval } from '@/lib/invoiceSync';
import { useToast } from '@/hooks/use-toast';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { getAcademyTrainersWithProfiles, getAcademyLocations } from '@/lib/academy';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  is_marked_full: boolean;
  rating_system: string | null;
  min_rating: number | null;
  max_rating: number | null;
  price_per_session: number | null;
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

  const { trainerRatingSystem } = useTrainerRatingSystem(detail?.trainer_id || undefined);

  const fetchSlotDetail = useCallback(async () => {
    if (!slotId) return;
    setLoading(true);
    try {
      const { data: slot, error } = await supabase
        .from('availability_slots')
        .select(`
          id, start_time, end_time, trainer_id, max_participants,
          is_marked_full, cyclus_id, cyclus_name, location_id,
          rating_system, min_rating, max_rating, price_per_session,
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
          profiles:player_id(full_name, avatar_url, skill_rating, rating_system),
          guest_players:guest_player_id(full_name, skill_rating, rating_system)
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
        is_marked_full: slot.is_marked_full,
        rating_system: slot.rating_system,
        min_rating: slot.min_rating,
        max_rating: slot.max_rating,
        price_per_session: slot.price_per_session,
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
        price_per_session: editPricePerSession ? Number(editPricePerSession) : null,
      };

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
    const newVal = !detail.is_marked_full;
    const { error } = await supabase
      .from('availability_slots')
      .update({ is_marked_full: newVal })
      .eq('id', detail.id);
    if (error) {
      logger.error('Error toggling private', error, { slotId: detail.id });
      return;
    }
    setDetail({ ...detail, is_marked_full: newVal });
    toast({ description: newVal ? tTrainer('calendar.slotMarkedFull') : tTrainer('calendar.slotMarkedOpen') });
  };

  const handleDelete = async () => {
    if (!detail) return;
    setDeleting(true);
    try {
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

          {!isEditing && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={startEditing}>
                <Pencil className="h-3.5 w-3.5" />
                {tTrainer('calendar.editSlot', 'Edit')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-destructive hover:text-destructive"
                onClick={() => { setDeleteCyclus(false); setDeleteOpen(true); }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>

      <main className="container mx-auto px-4 py-6">
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
                      />
                    </div>
                  </div>

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
                    {detail.is_marked_full && (
                      <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
                        <Lock className="h-3 w-3" />
                        {t('calendar.private', 'Private')}
                      </Badge>
                    )}
                    {detail.price_per_session != null && (
                      <Badge variant="outline" className="gap-1">
                        <DollarSign className="h-3 w-3" />
                        €{detail.price_per_session.toFixed(2)}
                      </Badge>
                    )}
                    {(detail.min_rating != null || detail.max_rating != null) && (
                      <Badge variant="outline" className="gap-1">
                        Level {detail.min_rating ?? '?'} – {detail.max_rating ?? '?'}
                      </Badge>
                    )}
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Lock className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{t('calendar.markPrivate', 'Mark as private')}</span>
                    </div>
                    <Switch checked={detail.is_marked_full} onCheckedChange={togglePrivate} />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

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
                          {player.skillRating != null && `${player.ratingSystem?.toUpperCase()} ${player.skillRating}`}
                        </p>
                      </div>
                      {player.isGuest && (
                        <Badge variant="outline" className="text-[10px] h-5 px-1.5">Guest</Badge>
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
