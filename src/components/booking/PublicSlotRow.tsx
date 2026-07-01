import { useTranslation } from 'react-i18next';
import { ChevronRight, MapPin, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatPrice } from '@/lib/pricing';
import { formatZonedTime } from '@/lib/zonedFormat';
import type { PublicSlot } from '@/lib/publicAvailability';

/**
 * A single bookable moment as a tappable row (time, trainer, single-vs-cyclus, price, spots left).
 * Shared by the {@link AvailabilityPicker} day list and the availability calendar's day sheet so both
 * render availability identically. Times render in the owner's timezone.
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
