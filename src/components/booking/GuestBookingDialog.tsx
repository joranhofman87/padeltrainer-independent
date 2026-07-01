import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Loader2, MapPin } from 'lucide-react';
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
import { formatZonedDayLabel, formatZonedTime } from '@/lib/zonedFormat';
import type { PublicSlot } from '@/lib/publicAvailability';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read the `{ error }` code from a supabase functions.invoke failure body (non-2xx). */
async function extractFnErrorCode(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: Response })?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = await ctx.json();
      return (body as { error?: string })?.error ?? null;
    } catch {
      /* fall through */
    }
  }
  return null;
}

interface GuestBookingDialogProps {
  slot: PublicSlot | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owner IANA timezone so the slot time renders owner-local. */
  timezone: string;
}

/**
 * Guest single-slot PAY-FIRST checkout: a non-tech visitor enters name/email/phone and is sent
 * straight to Mollie. The seat is only held + the booking only created server-side by
 * create-guest-slot-payment (server-authoritative price/recipient); this dialog just collects the
 * details and redirects to the returned checkout URL. Cyclus booking is a later phase.
 */
export function GuestBookingDialog({ slot, open, onOpenChange, timezone }: GuestBookingDialogProps) {
  const { t, i18n } = useTranslation('common');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset the form whenever a new slot is opened.
  useEffect(() => {
    if (open) {
      setFullName('');
      setEmail('');
      setPhone('');
      setNotes('');
      setSubmitting(false);
    }
  }, [open, slot?.id]);

  if (!slot) return null;

  // A cyclus tap books the WHOLE series (create-guest-cyclus-payment); a single tap
  // books just that session. Amount shown is the cyclus total vs the per-session price;
  // the server recomputes authoritatively either way.
  const isCyclus = !!slot.cyclus_id;
  const extrasTotal = slot.extra_costs.reduce((sum, ec) => sum + ec.price, 0);
  const price = isCyclus
    ? (slot.total_price != null && slot.total_price > 0 ? slot.total_price : null)
    : slot.price_per_session != null && slot.price_per_session > 0
      ? slot.price_per_session + extrasTotal
      : null;
  const dayLabel = formatZonedDayLabel(slot.start_time, timezone, i18n.language);
  const timeLabel = `${formatZonedTime(slot.start_time, timezone)}–${formatZonedTime(slot.end_time, timezone)}`;

  const canSubmit = fullName.trim().length > 0 && EMAIL_RE.test(email.trim()) && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke(
        isCyclus ? 'create-guest-cyclus-payment' : 'create-guest-slot-payment',
        {
          body: {
            ...(isCyclus ? { cyclusId: slot.cyclus_id } : { slotId: slot.id }),
            fullName: fullName.trim(),
            email: email.trim(),
            phone: phone.trim() || undefined,
            notes: notes.trim() || undefined,
          },
        },
      );

      const result = data as { checkoutUrl?: string; token?: string } | null;
      if (result?.checkoutUrl) {
        window.location.href = result.checkoutUrl;
        return;
      }

      const code = error ? await extractFnErrorCode(error) : null;
      if (code === 'slot_full') {
        toast.error(t('booking.guest.slotFull', 'Deze plek is net volgeboekt. Kies een ander moment.'));
      } else if (code === 'already_booked' && result?.token) {
        window.location.href = `/booking/${result.token}`;
        return;
      } else if (code === 'already_booked') {
        toast.error(t('booking.guest.alreadyBooked', 'Je hebt deze training al geboekt.'));
      } else if (code === 'no_mollie_account' || code === 'missing_mollie_profile') {
        toast.error(t('booking.guest.paymentUnavailable', 'Online betalen is niet beschikbaar voor deze training.'));
      } else if (code === 'slot_not_bookable' || code === 'slot_in_past' || code === 'cyclus_not_bookable') {
        toast.error(t('booking.guest.notBookable', 'Deze training kan niet meer geboekt worden.'));
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
            {isCyclus ? t('booking.guest.titleCyclus', 'Boek deze cyclus') : t('booking.guest.title', 'Boek deze training')}
          </DialogTitle>
          <DialogDescription>
            {t('booking.guest.subtitle', 'Vul je gegevens in en reken direct af. Je plek is pas geboekt na betaling.')}
          </DialogDescription>
        </DialogHeader>

        {/* Slot / cyclus summary */}
        <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1">
          {slot.cyclus_name && <p className="font-medium">{slot.cyclus_name}</p>}
          {slot.trainer_name && <p className={slot.cyclus_name ? 'text-muted-foreground' : 'font-medium'}>{slot.trainer_name}</p>}
          <p className="flex items-center gap-2 text-muted-foreground">
            <CalendarClock className="h-4 w-4" aria-hidden />
            {isCyclus ? (
              <span>{t('booking.guest.wholeCyclusFrom', 'Hele cyclus, vanaf {{day}}', { day: dayLabel })}</span>
            ) : (
              <span>
                <span className="capitalize">{dayLabel}</span> · {timeLabel}
              </span>
            )}
          </p>
          {slot.location_name && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <MapPin className="h-4 w-4" aria-hidden /> {slot.location_name}
            </p>
          )}
          {price != null && (
            <p className="font-semibold pt-1">
              {isCyclus ? t('booking.guest.total', 'Totaal') : t('booking.guest.price', 'Prijs')}: {formatPrice(price)}
              {isCyclus && slot.split_payment && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({t('booking.guest.splitNote', 'verdeeld over spelers')})
                </span>
              )}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="guest-name">{t('booking.guest.name', 'Naam')}</Label>
            <Input
              id="guest-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              autoComplete="name"
              placeholder={t('booking.guest.namePlaceholder', 'Voor- en achternaam')}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="guest-email">{t('booking.guest.email', 'E-mailadres')}</Label>
            <Input
              id="guest-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              inputMode="email"
              placeholder="naam@voorbeeld.nl"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="guest-phone">
              {t('booking.guest.phone', 'Telefoon')} <span className="text-muted-foreground">({t('booking.guest.optional', 'optioneel')})</span>
            </Label>
            <Input
              id="guest-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              inputMode="tel"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="guest-notes">
              {t('booking.guest.notes', 'Opmerking')} <span className="text-muted-foreground">({t('booking.guest.optional', 'optioneel')})</span>
            </Label>
            <Textarea id="guest-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
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
            {price != null
              ? t('booking.guest.payAmount', 'Afrekenen · {{amount}}', { amount: formatPrice(price) })
              : t('booking.guest.pay', 'Afrekenen')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
