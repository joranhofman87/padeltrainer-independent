import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { usePublicAvailability, type AvailabilityOwner } from '@/hooks/usePublicAvailability';
import { groupSlotsByZonedDay } from '@/lib/zonedFormat';
import { PublicSlotRow } from './PublicSlotRow';
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
  const { dayGroups, loading, availabilityUnverified } = usePublicAvailability(owner);
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
  // Same distinction as the calendar: an unverifiable offer must not read as an empty one.
  // This widget is embedded, so it renders a one-line notice rather than a card.
  if (availabilityUnverified) {
    return (
      <p className={`text-sm text-muted-foreground ${className ?? ''}`} data-testid="picker-unverified">
        {t('booking.availabilityUnverified', 'We kunnen het aanbod nu even niet ophalen. Probeer het zo opnieuw.')}
      </p>
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
            <PublicSlotRow key={slot.id} slot={slot} timezone={timezone} onSelect={onSelect} />
          ))}
        </div>

        <p className="text-[11px] text-muted-foreground text-center">
          {totalSlots}&nbsp;{totalSlots === 1 ? t('slot', 'slot') : t('slots', 'slots')}
        </p>
      </CardContent>
    </Card>
  );
}

