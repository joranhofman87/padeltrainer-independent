import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Calendar, Check, Clock, Euro, Lock, MapPin, Users } from 'lucide-react';
import { formatDate } from '@/lib/format';
import { formatPrice } from '@/lib/pricing';

interface SlotWithDetails {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id?: string | null;
  court_type?: 'indoor' | 'outdoor' | null;
  price_per_session?: number | null;
  max_participants?: number | null;
  allow_single_booking?: boolean | null;
  averageRating?: number | null;
  ratingSystem?: string;
  spotsLeft?: number;
  location?: { id: string; name: string; city: string; street_address: string | null } | null;
  rating_system?: string | null;
  min_rating?: number | null;
  max_rating?: number | null;
}

interface SlotListProps {
  slots: SlotWithDetails[];
  selectedSlotId: string | null;
  hasCycles: boolean;
  getSlotPrice: (slot: SlotWithDetails) => number;
  onSelect: (slot: SlotWithDetails) => void;
  /**
   * Returns the reason a slot can no longer be booked, or null when it can.
   *
   * A REASON rather than a boolean on purpose. This is the first disabled state this list has
   * ever had, and "greyed out" alone would read as "full" — which is a different situation with
   * a different remedy (wait for a cancellation vs. call the trainer). The copy has to say which.
   *
   * Advisory: the server refuses independently. This exists so a player is not invited to fill
   * in a booking form that will be rejected.
   */
  getBookingClosedLabel?: (slot: SlotWithDetails) => string | null;
}

export function SlotList({ slots, selectedSlotId, hasCycles, getSlotPrice, onSelect, getBookingClosedLabel }: SlotListProps) {
  const { t } = useTranslation('player');
  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">
        {hasCycles ? t('booking.individualSessions') : t('booking.availableTimeSlots')}
      </h3>
      {slots.length === 0 && !hasCycles ? (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">{t('booking.noSlotsAvailable')}</p>
        </Card>
      ) : slots.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('booking.noIndividualSessions')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {slots.map((slot) => {
            const slotPrice = getSlotPrice(slot);
            const closedLabel = getBookingClosedLabel?.(slot) ?? null;

            return (
              <Card
                key={slot.id}
                data-testid={`slot-card-${slot.id}`}
                data-booking-closed={closedLabel ? 'true' : undefined}
                aria-disabled={closedLabel ? true : undefined}
                className={`transition-all ${
                  closedLabel
                    ? 'opacity-60 cursor-not-allowed bg-muted/30'
                    : selectedSlotId === slot.id
                    ? 'ring-2 ring-primary border-primary cursor-pointer'
                    : 'hover:border-primary/50 cursor-pointer'
                }`}
                onClick={() => { if (!closedLabel) onSelect(slot); }}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">
                        {formatDate(slot.start_time, 'EEE d MMM')}
                      </span>
                    </div>
                    {selectedSlotId === slot.id && (
                      <Check className="h-5 w-5 text-primary" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
                    <Clock className="h-4 w-4" />
                    {formatDate(slot.start_time, 'HH:mm')} -{' '}
                    {formatDate(slot.end_time, 'HH:mm')}
                  </div>
                  {/* Named reason, above the fold of the card: a player must not have to infer
                      from a grey card whether it is full or closed. */}
                  {closedLabel && (
                    <Badge
                      variant="outline"
                      className="mb-2 gap-1 border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      data-testid={`slot-closed-${slot.id}`}
                    >
                      <Lock className="h-3 w-3" />
                      {closedLabel}
                    </Badge>
                  )}
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
                  {slotPrice > 0 && (
                    <div className="flex items-center gap-2 mt-2 pt-2 border-t">
                      <Euro className="h-4 w-4 text-primary" />
                      <span className="font-semibold text-primary">
                        {slot.allow_single_booking && (slot.max_participants || 1) > 1
                          ? t('booking.perSpotShort', { price: formatPrice(slotPrice / (slot.max_participants || 1)), defaultValue: '{{price}}/spot' })
                          : formatPrice(slotPrice)}
                      </span>
                    </div>
                  )}

                  {/* Spots left and Average Level */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t">
                    <div className="flex items-center gap-1 text-sm text-muted-foreground">
                      <Users className="h-4 w-4" />
                      <span>
                        {t('booking.spotsLeft', {
                          // ?? not ||: a FULL slot has spotsLeft === 0, which is falsy, so `||`
                          // fell through and advertised it as completely empty. Found by looking
                          // at the rendered page, not by a test.
                          available: slot.spotsLeft ?? (slot.max_participants ?? 4),
                          total: slot.max_participants || 4,
                          defaultValue: '{{available}}/{{total}} spots left',
                        })}
                      </span>
                    </div>
                    {slot.averageRating !== null && slot.averageRating !== undefined && (
                      <div className="flex items-center gap-1">
                        <Badge variant="secondary" className="text-xs">
                          {t('booking.avgRating', { rating: slot.averageRating.toFixed(1), defaultValue: 'Avg: {{rating}}' })}
                        </Badge>
                        <span className="text-xs text-muted-foreground uppercase">
                          {slot.ratingSystem || 'knltb'}
                        </span>
                      </div>
                    )}
                    {slot.rating_system && (
                      <Badge variant="outline" className="text-xs gap-1">
                        {slot.rating_system.toUpperCase()}
                        {slot.min_rating != null && slot.max_rating != null
                          ? ` ${slot.min_rating}–${slot.max_rating}`
                          : slot.min_rating != null
                          ? ` ≥${slot.min_rating}`
                          : slot.max_rating != null
                          ? ` ≤${slot.max_rating}`
                          : ''}
                      </Badge>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
