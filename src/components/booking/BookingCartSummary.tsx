import { useTranslation } from 'react-i18next';
import { CalendarClock, MapPin, X } from 'lucide-react';
import { formatPrice } from '@/lib/pricing';
import { formatZonedDayLabel, formatZonedTime } from '@/lib/zonedFormat';
import { cn } from '@/lib/utils';
import { cartItemIndicativePrice, cartIndicativeTotal } from '@/contexts/cartStore';
import type { PublicSlot } from '@/lib/publicAvailability';

/**
 * The cart's line-item list: per selected session — date, time, trainer, location,
 * indicative price and a remove control. Items flagged stale (refused by checkout as
 * no-longer-available) render struck-through with a badge so the guest sees exactly
 * what to prune. Pure display; state lives in CartContext / the drawer.
 */
export function BookingCartSummary({
  items,
  timezone,
  onRemove,
  staleIds,
}: {
  items: PublicSlot[];
  timezone: string;
  onRemove: (slotId: string) => void;
  staleIds?: Set<string>;
}) {
  const { t, i18n } = useTranslation('common');
  const total = cartIndicativeTotal(items);

  if (items.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t('booking.cart.empty', 'Je selectie is leeg.')}</p>;
  }

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {items.map((item) => {
          const stale = staleIds?.has(item.id) ?? false;
          const price = cartItemIndicativePrice(item);
          return (
            <li
              key={item.id}
              className={cn('flex items-start gap-2 rounded-lg border p-2.5', stale && 'border-destructive/50 bg-destructive/5')}
            >
              <div className={cn('min-w-0 flex-1 space-y-0.5 text-sm', stale && 'line-through opacity-70')}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-medium">
                    <CalendarClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="capitalize">{formatZonedDayLabel(item.start_time, timezone, i18n.language)}</span>
                  </span>
                  {price != null && <span className="shrink-0 font-semibold">{formatPrice(price)}</span>}
                </div>
                <p className="pl-5 text-xs text-muted-foreground tabular-nums">
                  {formatZonedTime(item.start_time, timezone)}–{formatZonedTime(item.end_time, timezone)}
                </p>
                {(item.trainer_name || item.location_name) && (
                  <p className="flex flex-wrap items-center gap-x-2 pl-5 text-xs text-muted-foreground">
                    {item.trainer_name && <span className="truncate">{item.trainer_name}</span>}
                    {item.location_name && (
                      <span className="flex min-w-0 items-center gap-1">
                        <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="truncate">{item.location_name}</span>
                      </span>
                    )}
                  </p>
                )}
                {stale && (
                  <p className="pl-5 text-xs font-medium text-destructive no-underline">
                    {t('booking.cart.itemUnavailable', 'Niet meer beschikbaar')}
                  </p>
                )}
              </div>
              <button
                type="button"
                aria-label={t('booking.cart.removeFromCart', 'Verwijder uit selectie')}
                onClick={() => onRemove(item.id)}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      <div className="flex items-baseline justify-between border-t pt-2 text-sm">
        <span className="font-medium">{t('booking.cart.total', 'Totaal')}</span>
        <span className="font-semibold">{formatPrice(total)}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('booking.cart.indicativeNote', 'Definitieve prijs wordt bevestigd bij het afrekenen.')}
      </p>
    </div>
  );
}
