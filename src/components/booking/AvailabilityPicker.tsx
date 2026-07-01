import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, ChevronRight, MapPin, Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatPrice } from '@/lib/pricing';
import { usePublicAvailability, type AvailabilityOwner } from '@/hooks/usePublicAvailability';
import { formatZonedTime, groupSlotsByZonedDay } from '@/lib/zonedFormat';
import type { PublicSlot } from '@/lib/publicAvailability';

interface AvailabilityPickerProps {
  /** Whose availability to show (academy / trainer). */
  owner: AvailabilityOwner;
  /** Called when a visitor taps a slot to book it (routing/booking is the caller's concern). */
  onSelect: (slot: PublicSlot) => void;
  /** IANA timezone the slots are displayed in (the owner's). Defaults to Europe/Amsterdam. */
  timezone?: string;
  className?: string;
}

/**
 * Mobile-first, appointment-style availability picker: pick a day (horizontal day pills) → see that
 * day's bookable moments as tappable rows (time, trainer, single-vs-cyclus, price, spots left).
 * Owner-agnostic + owner-timezone-correct. Renders nothing until there is availability, so a page
 * can mount it unconditionally. Booking itself is delegated via `onSelect` (Phase 1 keeps today's
 * flow; guest pay-first arrives in a later phase).
 */
export function AvailabilityPicker({
  owner,
  onSelect,
  timezone = 'Europe/Amsterdam',
  className,
}: AvailabilityPickerProps) {
  const { t, i18n } = useTranslation('common');
  const { dayGroups, loading } = usePublicAvailability(owner);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Re-group by OWNER-timezone day (the hook groups browser-local; the widget must show academy-local
  // days/times). Input is already chronological.
  const days = useMemo(
    () => groupSlotsByZonedDay(dayGroups.flatMap((g) => g.slots), timezone, i18n.language),
    [dayGroups, timezone, i18n.language],
  );
  const selectedDay = days.find((d) => d.key === selectedKey) ?? days[0];

  if (loading) {
    return (
      <Card className={className}>
        <CardContent className="p-4">
          <Skeleton className="h-8 w-40 mb-3" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (days.length === 0) return null;

  const totalSlots = days.reduce((sum, d) => sum + d.slots.length, 0);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-primary" />
          {t('booking.pickTitle', 'Boek een training')}
        </CardTitle>
        <CardDescription>
          {t('booking.pickSubtitle', 'Kies een dag en tijd die jou uitkomt')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Day pills — horizontal scroll on mobile */}
        <div
          className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1"
          role="tablist"
          aria-label={t('booking.pickDay', 'Kies een dag')}
        >
          {days.map((day) => {
            const active = day.key === selectedDay?.key;
            return (
              <button
                key={day.key}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={day.label}
                onClick={() => setSelectedKey(day.key)}
                className={cn(
                  'flex shrink-0 flex-col items-center rounded-lg border px-3 py-2 min-w-[68px] min-h-[52px] justify-center transition-colors',
                  active
                    ? 'border-primary bg-primary/10 font-semibold'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                <span className="text-xs capitalize whitespace-nowrap">{day.label}</span>
                <span className="text-[10px] text-muted-foreground">
                  {day.slots.length}&nbsp;{day.slots.length === 1 ? t('slot', 'slot') : t('slots', 'slots')}
                </span>
              </button>
            );
          })}
        </div>

        {/* Slots for the selected day */}
        <div className="space-y-2" role="list">
          {selectedDay?.slots.map((slot) => (
            <SlotRow key={slot.id} slot={slot} timezone={timezone} onSelect={onSelect} />
          ))}
        </div>

        <p className="text-[11px] text-muted-foreground text-center">
          {totalSlots}&nbsp;{totalSlots === 1 ? t('slot', 'slot') : t('slots', 'slots')}
        </p>
      </CardContent>
    </Card>
  );
}

function SlotRow({
  slot,
  timezone,
  onSelect,
}: {
  slot: PublicSlot;
  timezone: string;
  onSelect: (slot: PublicSlot) => void;
}) {
  const { t } = useTranslation('common');
  const extrasTotal = slot.extra_costs.reduce((sum, ec) => sum + ec.price, 0);
  const perSession =
    slot.price_per_session != null && slot.price_per_session > 0 ? slot.price_per_session + extrasTotal : null;
  const timeLabel = `${formatZonedTime(slot.start_time, timezone)}–${formatZonedTime(slot.end_time, timezone)}`;

  return (
    <button
      type="button"
      role="listitem"
      aria-label={slot.trainer_name ? `${timeLabel}, ${slot.trainer_name}` : timeLabel}
      onClick={() => onSelect(slot)}
      className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted min-h-[56px]"
    >
      <div className="min-w-[52px] text-center">
        <p className="font-semibold text-sm leading-tight">{formatZonedTime(slot.start_time, timezone)}</p>
        <p className="text-xs text-muted-foreground">{formatZonedTime(slot.end_time, timezone)}</p>
      </div>

      <div className="flex-1 min-w-0">
        {slot.trainer_name && <p className="text-sm font-medium truncate">{slot.trainer_name}</p>}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={slot.cyclus_id ? 'default' : 'outline'} className="text-xs">
            {slot.cyclus_name || t('singleSession', 'Single session')}
          </Badge>
          {slot.location_name && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" />
              {slot.location_name}
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Users className="h-3 w-3" />
            {slot.spots_left}&nbsp;{slot.spots_left === 1 ? t('spotLeft', 'spot left') : t('spotsLeft', 'spots left')}
          </span>
        </div>
      </div>

      <div className="text-right shrink-0">
        {perSession != null && (
          <p className="text-sm font-semibold">
            {formatPrice(perSession)}
            <span className="text-xs font-normal text-muted-foreground">/{t('session', 'session')}</span>
          </p>
        )}
        {slot.cyclus_id && slot.total_price != null && slot.total_price > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {t('total', 'Total')}: {formatPrice(slot.total_price)}
          </p>
        )}
        {slot.split_payment && (
          <p className="text-[10px] text-muted-foreground">{t('splitAmongPlayers', 'Verdeeld over spelers')}</p>
        )}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
