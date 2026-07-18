import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import {
  Lock, MapPin, Users, Calendar, Pencil, Trash2, UserPlus,
  DollarSign, Loader2,
} from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { setSlotVisibility } from '@/lib/slots';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';
import { logger } from '@/lib/logger';
import { formatCurrency } from '@/lib/format';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { useBookingLoginFlags } from '@/hooks/useBookingLoginFlags';
import { isGuestForBadge } from '@/lib/bookingLoginFlags';
import { SlotWithBookings, BookedPlayer } from '@/lib/slotTypes';

interface SlotDetail {
  id: string;
  start_time: string;
  end_time: string;
  trainer_id: string;
  trainer_name: string;
  trainer_avatar: string | null;
  location_name: string | null;
  cyclus_id: string | null;
  cyclus_name: string | null;
  max_participants: number;
  is_public: boolean;
  rating_system: string | null;
  min_rating: number | null;
  max_rating: number | null;
  price_per_session: number | null;
  booked_players: BookedPlayer[];
}

interface SlotDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slotId: string | null;
  onEditSlot: (slot: SlotWithBookings) => void;
  onDeleteSlot: (slot: SlotWithBookings) => void;
  onBookForPlayer: (slot: SlotWithBookings) => void;
  onEditBooking: (bookingId: string) => void;
  onRefresh: () => void;
}

export function SlotDetailDialog({
  open, onOpenChange, slotId,
  onEditSlot, onDeleteSlot, onBookForPlayer, onEditBooking, onRefresh,
}: SlotDetailDialogProps) {
  const { t, i18n } = useTranslation('academy');
  const { t: tTrainer } = useTranslation('trainer');
  const { toast } = useToast();
  const dateLocale = i18n.language === 'nl' ? nl : enUS;
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<SlotDetail | null>(null);
  // Phase 3.5c: badge keys on person-level login (falls back to seat pre-deploy)
  const loginFlags = useBookingLoginFlags(detail?.booked_players.map(p => p.bookingId) ?? []);

  useEffect(() => {
    if (open && slotId) {
      fetchSlotDetail(slotId);
    } else {
      setDetail(null);
    }
  }, [open, slotId]);

  const fetchSlotDetail = async (id: string) => {
    setLoading(true);
    try {
      const { data: slot, error } = await supabase
        .from('availability_slots')
        .select(`
          id, start_time, end_time, trainer_id, max_participants, cyclus_id, cyclus_name, location_id, is_public,
          rating_system, min_rating, max_rating, price_per_session,
          locations:location_id(name)
        `)
        .eq('id', id)
        .single();

      if (error) throw error;

      // Get trainer info
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

      // Get bookings
      const { data: bookings } = await supabase
        .from('bookings')
        .select(`
          id, status, player_id, guest_player_id,
          profiles:player_id(full_name, avatar_url, skill_rating, rating_system),
          guest_players:guest_player_id(full_name, skill_rating, rating_system)
        `)
        .eq('slot_id', id)
        .in('status', [...CAPACITY_OCCUPYING_STATUSES]);

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
        location_name: (slot.locations as any)?.name || null,
        cyclus_id: slot.cyclus_id,
        cyclus_name: slot.cyclus_name,
        max_participants: slot.max_participants || 4,
        is_public: (slot as any).is_public ?? true,
        rating_system: slot.rating_system,
        min_rating: slot.min_rating,
        max_rating: slot.max_rating,
        price_per_session: slot.price_per_session,
        booked_players: players,
      });
    } catch (error) {
      logger.error('Error fetching slot detail', error as Error, { slotId: id });
    } finally {
      setLoading(false);
    }
  };

  const togglePrivate = async () => {
    if (!detail) return;
    const newVal = !detail.is_public;
    const { error } = await setSlotVisibility(detail.id, newVal);
    if (error) {
      logger.error('Error toggling private', error, { slotId: detail.id });
      return;
    }
    setDetail({ ...detail, is_public: newVal });
    toast({ description: !newVal ? tTrainer('calendar.slotMarkedFull') : tTrainer('calendar.slotMarkedOpen') });
    onRefresh();
  };

  const toSlotWithBookings = (): SlotWithBookings => ({
    id: detail!.id,
    start_time: detail!.start_time,
    end_time: detail!.end_time,
    max_participants: detail!.max_participants,
    price: detail!.price_per_session,
    active_bookings: detail!.booked_players.filter(p => p.status === 'confirmed').length,
    pending_bookings: detail!.booked_players.filter(p => p.status === 'pending').length,
    is_past: new Date(detail!.start_time) < new Date(),
    cyclus_id: detail!.cyclus_id,
    cyclus_name: detail!.cyclus_name,
    booked_players: detail!.booked_players,
    is_public: detail!.is_public,
    location_name: detail!.location_name,
    trainer_id: detail!.trainer_id,
    trainer_name: detail!.trainer_name,
    trainer_avatar: detail!.trainer_avatar,
    rating_system: detail!.rating_system,
    min_rating: detail!.min_rating,
    max_rating: detail!.max_rating,
  });

  const bookedCount = detail?.booked_players.length || 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            {t('calendar.slotDetail', 'Session Details')}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !detail ? (
          <p className="text-center text-muted-foreground py-8">{t('calendar.slotNotFound', 'Slot not found')}</p>
        ) : (
          <div className="space-y-4">
            {/* Date & Time */}
            <div>
              <p className="text-lg font-semibold">
                {format(new Date(detail.start_time), 'EEEE d MMMM', { locale: dateLocale })}
              </p>
              <p className="text-sm text-muted-foreground">
                {format(new Date(detail.start_time), 'HH:mm')} – {format(new Date(detail.end_time), 'HH:mm')}
              </p>
            </div>

            {/* Trainer */}
            <div className="flex items-center gap-3">
              <Avatar className="h-8 w-8">
                <AvatarImage src={detail.trainer_avatar || undefined} />
                <AvatarFallback className="text-xs">{detail.trainer_name.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">{detail.trainer_name}</span>
            </div>

            {/* Meta badges */}
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
                  {formatCurrency(detail.price_per_session)}
                </Badge>
              )}
            </div>

            {/* Occupancy */}
            <div className="flex items-center gap-2 text-sm">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span>{bookedCount}/{detail.max_participants} {t('calendar.booked', 'booked')}</span>
            </div>

            {/* Players list */}
            {detail.booked_players.length > 0 && (
              <div className="space-y-1">
                {detail.booked_players.map(player => (
                  <button
                    key={player.bookingId}
                    className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-accent/50 transition-colors text-left"
                    onClick={() => {
                      onOpenChange(false);
                      onEditBooking(player.bookingId);
                    }}
                  >
                    <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium shrink-0">
                      {player.name.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="text-sm truncate flex-1">{player.name}</span>
                    {isGuestForBadge(loginFlags, player.bookingId, player.isGuest) && (
                      <Badge variant="outline" className="text-[10px] h-4 px-1">{t('calendar.guest', 'Guest')}</Badge>
                    )}
                    {player.status === 'pending' && (
                      <Badge variant="outline" className="text-[10px] h-4 px-1 text-amber-600">{t('calendar.pending', 'Pending')}</Badge>
                    )}
                    <Pencil className="h-3 w-3 text-muted-foreground shrink-0" />
                  </button>
                ))}
              </div>
            )}

            <Separator />

            {/* Mark as Private toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{t('calendar.markPrivate', 'Mark as private')}</span>
              </div>
              <Switch checked={!detail.is_public} onCheckedChange={togglePrivate} />
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  onOpenChange(false);
                  onBookForPlayer(toSlotWithBookings());
                }}
              >
                <UserPlus className="h-3.5 w-3.5" />
                {t('calendar.addPlayer', 'Add Player')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => {
                  onOpenChange(false);
                  onEditSlot(toSlotWithBookings());
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                {t('calendar.editSlot', 'Edit')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-destructive hover:text-destructive"
                onClick={() => {
                  onOpenChange(false);
                  onDeleteSlot(toSlotWithBookings());
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('calendar.deleteSlot', 'Delete')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
