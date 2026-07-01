import { useTranslation } from 'react-i18next';
import { ChevronRight, MapPin, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatPrice } from '@/lib/pricing';
import { formatZonedTime } from '@/lib/zonedFormat';
import type { PublicSlot } from '@/lib/publicAvailability';

/**
 * A single bookable moment as a tappable row (time, price, single-vs-cyclus, trainer, spots left).
 * Shared by the {@link AvailabilityPicker} day list and the availability calendar's day panel so both
 * render availability identically. Times render in the owner's timezone.
 *
 * Laid out as stacked lines — time + price on top, then the type badge / trainer / location / spots —
 * so it stays clean inside a NARROW desktop side panel and on mobile. Every text node truncates
 * (and the cyclus badge is width-capped) instead of overflowing or ballooning the pill.
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
  const isCyclus = !!slot.cyclus_id;
  const showTotal = isCyclus && slot.total_price != null && slot.total_price > 0;

  return (
    <button
      type="button"
      role="listitem"
      aria-label={slot.trainer_name ? `${timeLabel}, ${slot.trainer_name}` : timeLabel}
      onClick={() => onSelect(slot)}
      className="flex w-full items-center gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-muted"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        {/* Line 1: time range + per-session price */}
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold leading-tight tabular-nums">{timeLabel}</span>
          {perSession != null && (
            <span className="shrink-0 whitespace-nowrap text-sm font-semibold">
              {formatPrice(perSession)}
              <span className="text-xs font-normal text-muted-foreground">/{t('session', 'session')}</span>
            </span>
          )}
        </div>

        {/* Line 2: type badge + trainer + location + spots — wraps, every item truncate/nowrap-safe */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={isCyclus ? 'default' : 'outline'} className="min-w-0 max-w-full text-xs">
            <span className="truncate">{slot.cyclus_name || t('singleSession', 'Single session')}</span>
          </Badge>
          {slot.trainer_name && (
            <span className="max-w-full truncate text-xs text-muted-foreground">{slot.trainer_name}</span>
          )}
          {slot.location_name && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3 shrink-0" />
              <span className="truncate">{slot.location_name}</span>
            </span>
          )}
          <span className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
            <Users className="h-3 w-3 shrink-0" />
            {slot.spots_left}&nbsp;{slot.spots_left === 1 ? t('spotLeft', 'spot left') : t('spotsLeft', 'spots left')}
          </span>
        </div>

        {/* Line 3 (cyclus only): whole-cyclus total + optional split note */}
        {showTotal && (
          <p className="text-[11px] text-muted-foreground">
            {t('total', 'Total')}: {formatPrice(slot.total_price!)}
            {slot.split_payment && <> · {t('splitAmongPlayers', 'Verdeeld over spelers')}</>}
          </p>
        )}
      </div>

      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
