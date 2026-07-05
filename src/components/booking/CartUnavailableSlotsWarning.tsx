import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatZonedDayLabel, formatZonedTime } from '@/lib/zonedFormat';
import type { PublicSlot } from '@/lib/publicAvailability';

/**
 * Shown after a checkout was refused because one or more selected sessions went stale
 * (just filled, hidden, or removed) — the { error, slotIds } contract from
 * create-guest-cart-payment. Nothing was charged (the hold is all-or-nothing); the guest
 * prunes the named items with one tap and can retry the rest.
 */
export function CartUnavailableSlotsWarning({
  staleItems,
  timezone,
  onPrune,
}: {
  staleItems: PublicSlot[];
  timezone: string;
  onPrune: () => void;
}) {
  const { t, i18n } = useTranslation('common');
  if (staleItems.length === 0) return null;

  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/5 p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
        {t('booking.cart.unavailableTitle', 'Niet alle sessies zijn nog beschikbaar')}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          'booking.cart.unavailableBody',
          'Er is nog niets betaald. Verwijder de onderstaande sessies en probeer het opnieuw.',
        )}
      </p>
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        {staleItems.map((item) => (
          <li key={item.id} className="capitalize">
            {formatZonedDayLabel(item.start_time, timezone, i18n.language)} ·{' '}
            {formatZonedTime(item.start_time, timezone)}–{formatZonedTime(item.end_time, timezone)}
          </li>
        ))}
      </ul>
      <Button size="sm" variant="outline" onClick={onPrune} className="w-full">
        {t('booking.cart.unavailableRemove', 'Verwijder en ga verder')}
      </Button>
    </div>
  );
}
