import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/lib/supabaseClient';
import { formatPrice } from '@/lib/pricing';
import { extractCartFnError } from '@/components/booking/cartErrors';
import { cartIndicativeTotal } from '@/components/booking/BookingCartSummary';
import type { PublicSlot } from '@/lib/publicAvailability';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Guest CART checkout: one contact form, one payment for every selected session
 * (create-guest-cart-payment). Mirrors GuestBookingDialog's fields/validation so the
 * cart feels identical to the single-session flow. All-or-nothing server-side: a refusal
 * charges nothing; a { error, slotIds } refusal hands the stale ids to `onStaleSlots`
 * so the drawer can mark + prune them.
 */
export function CartCheckoutDialog({
  open,
  onOpenChange,
  items,
  onStaleSlots,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PublicSlot[];
  /** Called with the offending slot ids when checkout refuses stale/full items. */
  onStaleSlots: (slotIds: string[]) => void;
}) {
  const { t } = useTranslation('common');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhone('');
      setNotes('');
      setSubmitting(false);
    }
  }, [open]);

  const total = cartIndicativeTotal(items);

  const canSubmit =
    items.length > 0 &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    EMAIL_RE.test(email.trim()) &&
    phone.trim().length > 0 &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-guest-cart-payment', {
        body: {
          slotIds: items.map((i) => i.id),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          notes: notes.trim() || undefined,
        },
      });

      const result = data as { checkoutUrl?: string; token?: string } | null;
      if (result?.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }

      const body = error ? await extractCartFnError(error) : null;
      const code = body?.error ?? null;
      if (code === 'slot_unavailable' || code === 'slot_full') {
        toast.error(t('booking.cart.unavailableTitle', 'Niet alle sessies zijn nog beschikbaar'));
        onStaleSlots(body?.slotIds ?? []);
        onOpenChange(false); // back to the drawer, where the warning marks the items
      } else if (code === 'split_not_supported' || code === 'single_booking_not_allowed' || code === 'slot_not_bookable') {
        toast.error(t('booking.cart.notCartable', 'Deze sessie kan niet los geboekt worden.'));
        onStaleSlots(body?.slotIds ?? []);
        onOpenChange(false);
      } else if (code === 'mixed_recipient') {
        toast.error(t('booking.cart.differentOrg', 'Je kunt per bestelling maar bij één aanbieder boeken. Reken eerst je huidige selectie af.'));
      } else if (code === 'cart_too_large') {
        toast.error(t('booking.cart.cartFull', 'Je selectie is vol (max. 20 sessies). Reken eerst af.'));
      } else if (code === 'already_booked' && body?.token) {
        window.location.href = `/booking/${body.token}`;
        return;
      } else if (code === 'already_booked' || code === 'already_paid') {
        toast.error(t('booking.guest.alreadyBooked', 'Je hebt deze training al geboekt.'));
      } else if (code === 'no_mollie_account' || code === 'missing_mollie_profile' || code === 'mollie_not_ready') {
        toast.error(t('booking.guest.paymentUnavailable', 'Online betalen is niet beschikbaar voor deze training.'));
      } else if (code === 'mollie_error') {
        toast.error(t('booking.guest.paymentTemporarilyUnavailable', 'Online betalen is tijdelijk niet beschikbaar. Probeer het later opnieuw.'));
      } else {
        toast.error(t('booking.guest.failed', 'Er ging iets mis. Probeer het opnieuw.'));
      }
      setSubmitting(false);
    } catch {
      toast.error(t('booking.guest.failed', 'Er ging iets mis. Probeer het opnieuw.'));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('booking.cart.checkoutTitle', 'Boek {{count}} sessies', { count: items.length })}
          </DialogTitle>
          <DialogDescription>
            {t('booking.guest.subtitle', 'Vul je gegevens in en reken direct af. Je plek is pas geboekt na betaling.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="cart-first">{t('booking.guest.firstName', 'Voornaam')}</Label>
              <Input id="cart-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cart-last">{t('booking.guest.lastName', 'Achternaam')}</Label>
              <Input id="cart-last" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cart-email">{t('booking.guest.email', 'E-mailadres')}</Label>
            <Input
              id="cart-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              inputMode="email"
              placeholder="naam@voorbeeld.nl"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cart-phone">{t('booking.guest.phone', 'Telefoon')}</Label>
            <Input id="cart-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" inputMode="tel" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cart-notes">
              {t('booking.guest.notes', 'Opmerking')} <span className="text-muted-foreground">({t('booking.guest.optional', 'optioneel')})</span>
            </Label>
            <Textarea id="cart-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>

        {/* Returning users self-identify — no email lookup, so no account-enumeration surface. */}
        <p className="text-xs text-muted-foreground text-center">
          {t('booking.guest.haveAccount', 'Al een account?')}{' '}
          <a href="/app/auth" className="underline hover:text-foreground">
            {t('booking.guest.login', 'Log in')}
          </a>
        </p>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel', 'Annuleren')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
            {total > 0
              ? t('booking.guest.payAmount', 'Afrekenen · {{amount}}', { amount: formatPrice(total) })
              : t('booking.guest.pay', 'Afrekenen')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
