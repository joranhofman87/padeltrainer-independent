import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, MapPin, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import { formatPrice } from '@/lib/pricing';
import { formatZonedTime } from '@/lib/zonedFormat';
import { GUEST_PAYFIRST_ENABLED } from '@/lib/bookingFlags';
import { isCartableSlot, useCartOptional } from '@/contexts/cartStore';
import { cartRefusalMessage } from '@/components/booking/cartMessages';
import type { PublicSlot } from '@/lib/publicAvailability';

/**
 * A single bookable moment as a compact, tappable row. Deliberately minimal — only
 * TIME, PRICE PER SESSION, TRAINER and LOCATION — so a long day list stays scannable
 * and the box doesn't balloon. Tapping opens the booking dialog, which shows the rest
 * (session type, whole-cyclus total, split, spots). Times render in the owner's timezone.
 * Shared by the {@link AvailabilityPicker} day list and the availability calendar's day panel.
 *
 * Cart affordance: cartable slots (guest pay-first on, not split, not a locked cyclus
 * session) get an add-to-cart toggle beside the row so a guest can collect several
 * separate sessions and pay once. Non-cartable slots keep the plain tap-to-book row —
 * a locked cyclus session's path stays "book the whole cyclus" via the dialog.
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
  const cart = useCartOptional();
  const extrasTotal = slot.extra_costs.reduce((sum, ec) => sum + ec.price, 0);
  const perSession =
    slot.price_per_session != null && slot.price_per_session > 0 ? slot.price_per_session + extrasTotal : null;
  const timeLabel = `${formatZonedTime(slot.start_time, timezone)}–${formatZonedTime(slot.end_time, timezone)}`;

  const cartable = GUEST_PAYFIRST_ENABLED && cart != null && isCartableSlot(slot);
  const inCart = cartable && cart.isInCart(slot.id);

  const handleCartToggle = () => {
    if (!cart || !cartable) return;
    if (inCart) {
      cart.removeItem(slot.id);
      return;
    }
    const result = cart.addItem(slot);
    // 'in' narrowing — the tsconfig runs strict:false, where !result.ok doesn't narrow the union.
    if ('reason' in result) {
      toast.error(cartRefusalMessage(t, result.reason));
      return;
    }
    toast.success(t('booking.cart.added', 'Toegevoegd aan je selectie.'));
  };

  return (
    <div className="flex w-full items-center gap-2 rounded-lg border p-2.5 transition-colors hover:bg-muted">
      {/* role=listitem stays on the tappable row (as before the cart affordance) so day
          lists keep their semantics and existing listitem-driven interactions work. */}
      <button
        type="button"
        role="listitem"
        aria-label={slot.trainer_name ? `${timeLabel}, ${slot.trainer_name}` : timeLabel}
        onClick={() => onSelect(slot)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
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

      {cartable && (
        <button
          type="button"
          aria-label={
            inCart
              ? t('booking.cart.removeFromCart', 'Verwijder uit selectie')
              : t('booking.cart.addToCart', 'Voeg toe aan selectie')
          }
          aria-pressed={inCart}
          onClick={handleCartToggle}
          className={
            inCart
              ? 'shrink-0 rounded-md border border-primary bg-primary/10 p-2 text-primary transition-colors'
              : 'shrink-0 rounded-md border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
          }
        >
          {inCart ? <Check className="h-4 w-4" aria-hidden /> : <ShoppingCart className="h-4 w-4" aria-hidden />}
        </button>
      )}
    </div>
  );
}
