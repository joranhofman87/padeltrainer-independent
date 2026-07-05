import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useCartOptional } from '@/contexts/CartContext';
import { BookingCartSummary } from '@/components/booking/BookingCartSummary';
import { CartCheckoutDialog } from '@/components/booking/CartCheckoutDialog';
import { CartUnavailableSlotsWarning } from '@/components/booking/CartUnavailableSlotsWarning';

/**
 * The guest cart surface: a floating cart button (only when the cart has items) opening
 * a bottom/side sheet with the selected sessions, and the one-payment checkout dialog.
 * Mounted by PublicAvailabilitySection so it appears on every public booking surface.
 *
 * Stale-item flow: when checkout is refused with { error, slotIds }, those ids are marked
 * here; CartUnavailableSlotsWarning explains + prunes them (nothing was charged — the
 * server hold is all-or-nothing).
 */
export function BookingCartDrawer({ timezone }: { timezone: string }) {
  const { t } = useTranslation('common');
  const cart = useCartOptional();
  const [open, setOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [staleIds, setStaleIds] = useState<Set<string>>(new Set());

  if (!cart || cart.count === 0) return null;
  const staleItems = cart.items.filter((i) => staleIds.has(i.id));

  const handleStaleSlots = (slotIds: string[]) => {
    // Empty ids (older error shape) → mark nothing but keep the drawer open for retry.
    setStaleIds(new Set(slotIds));
    setOpen(true);
  };

  const handlePrune = () => {
    cart.removeItems([...staleIds]);
    setStaleIds(new Set());
  };

  return (
    <>
      <Button
        type="button"
        aria-label={t('booking.cart.openCart', 'Open je selectie ({{count}})', { count: cart.count })}
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 h-12 rounded-full shadow-lg"
      >
        <ShoppingCart className="mr-2 h-5 w-5" aria-hidden />
        <span className="font-semibold">{cart.count}</span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="flex w-full flex-col sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t('booking.cart.title', 'Jouw selectie')}</SheetTitle>
            <SheetDescription>
              {t('booking.cart.subtitle', 'Losse sessies, één betaling. Je plekken zijn pas geboekt na betaling.')}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 space-y-3 overflow-y-auto py-2">
            {staleItems.length > 0 && (
              <CartUnavailableSlotsWarning staleItems={staleItems} timezone={timezone} onPrune={handlePrune} />
            )}
            <BookingCartSummary items={cart.items} timezone={timezone} onRemove={cart.removeItem} staleIds={staleIds} />
          </div>

          <div className="space-y-2 border-t pt-3">
            <Button
              className="w-full"
              disabled={cart.count === 0 || staleItems.length > 0}
              onClick={() => setCheckoutOpen(true)}
            >
              {t('booking.cart.checkout', 'Afrekenen')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-muted-foreground"
              onClick={() => {
                cart.clearCart();
                setStaleIds(new Set());
                setOpen(false);
              }}
            >
              {t('booking.cart.clear', 'Selectie leegmaken')}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <CartCheckoutDialog open={checkoutOpen} onOpenChange={setCheckoutOpen} items={cart.items} onStaleSlots={handleStaleSlots} />
    </>
  );
}
