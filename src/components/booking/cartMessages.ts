import type { TFunction } from 'i18next';
import type { CartAddRefusal } from '@/contexts/cartStore';

/**
 * One place for the guest-facing copy of a cart-add refusal — shared by the slot-row
 * toggle and the booking dialog's "add another session" action so both surfaces explain
 * the same rule the same way.
 */
export function cartRefusalMessage(t: TFunction, reason: CartAddRefusal): string {
  switch (reason) {
    case 'different_org':
      return t('booking.cart.differentOrg', 'Je kunt per bestelling maar bij één aanbieder boeken. Reken eerst je huidige selectie af.');
    case 'cart_full':
      return t('booking.cart.cartFull', 'Je selectie is vol (max. 20 sessies). Reken eerst af.');
    case 'already_in_cart':
      return t('booking.cart.alreadyInCart', 'Deze sessie zit al in je selectie.');
    default:
      return t('booking.cart.notCartable', 'Deze sessie kan niet los geboekt worden.');
  }
}
