import { useTranslation } from 'react-i18next';
import { ChevronRight, MapPin } from 'lucide-react';
import { formatPrice } from '@/lib/pricing';
import { formatZonedTime } from '@/lib/zonedFormat';
import type { PublicSlot } from '@/lib/publicAvailability';

/**
 * A single bookable moment as a compact, tappable row. Deliberately minimal — only
 * TIME, PRICE PER SESSION, TRAINER and LOCATION — so a long day list stays scannable
 * and the box doesn't balloon. Tapping opens the booking dialog, which shows the rest
 * (session type, whole-cyclus total, split, spots). Times render in the owner's timezone.
 * Shared by the {@link AvailabilityPicker} day list and the availability calendar's day panel.
 */
export function PublicSlotRow({
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
      className="flex w-full items-center gap-2 rounded-lg border p-2.5 text-left transition-colors hover:bg-muted"
    >
      <div className="min-w-0 flex-1 space-y-1">
        {/* Time range + per-session price */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold leading-tight tabular-nums">{timeLabel}</span>
          {perSession != null && (
            <span className="shrink-0 whitespace-nowrap text-sm font-semibold">
              {formatPrice(perSession)}
              <span className="text-xs font-normal text-muted-foreground">/{t('session', 'session')}</span>
            </span>
          )}
        </div>

        {/* Trainer + location — every item truncates instead of overflowing */}
        {(slot.trainer_name || slot.location_name) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {slot.trainer_name && <span className="max-w-full truncate">{slot.trainer_name}</span>}
            {slot.location_name && (
              <span className="flex min-w-0 items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{slot.location_name}</span>
              </span>
            )}
          </div>
        )}
      </div>

      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
