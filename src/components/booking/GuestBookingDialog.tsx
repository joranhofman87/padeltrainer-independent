import { useEffect, useRef, useState } from 'react';
import {
  clearCreationAttempt,
  creationRequestIdFor,
  type CreationAttempt,
} from '@/lib/creationRequestId';
import { logger } from '@/lib/logger';
import { useTranslation } from 'react-i18next';
import { CalendarClock, Loader2, MapPin, ShoppingCart } from 'lucide-react';
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
import { PhoneInput } from '@/components/ui/phone-input';
import { WhatsAppOptInField } from '@/components/booking/WhatsAppOptInField';
import { validatePhone } from '@/lib/validation';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabaseClient';
import { formatPrice, perSeatSessionPrice } from '@/lib/pricing';
import { formatZonedDayLabel, formatZonedTime } from '@/lib/zonedFormat';
import { isCartableSlot, useCartOptional } from '@/contexts/cartStore';
import { cartRefusalMessage } from '@/components/booking/cartMessages';
import type { PublicSlot } from '@/lib/publicAvailability';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type CyclusSession = { id: string; start_time: string; end_time: string; price_per_session: number | null };

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
  /** Owner IANA timezone so times render owner-local. */
  timezone: string;
}

/**
 * Guest PAY-FIRST checkout. If the tapped slot belongs to a cyclus, the visitor CHOOSES between
 * booking just this session or the whole series — the cyclus option lists every session (day + time)
 * and shows the summed total. Details go straight to Mollie; the seat(s) are only held + priced
 * server-side (create-guest-slot-payment / create-guest-cyclus-payment).
 */
export function GuestBookingDialog({ slot, open, onOpenChange, timezone }: GuestBookingDialogProps) {
  const { t, i18n } = useTranslation('common');
  const cart = useCartOptional();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // unchecked by default — consent must be an action the guest took
  const [whatsappOptIn, setWhatsappOptIn] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // U2 identity continuity: the server matched this address to existing Player(s) and is asking the
  // booker to prove they control it before anything is booked. We show a GENERIC message — never a
  // name, a count, or even confirmation that an account exists — and stop here; the link arrives by
  // email and continues the flow on its own landing page.
  const [verificationSent, setVerificationSent] = useState(false);
  /**
   * The id of THIS checkout attempt. Every retry of it carries the same one, so a double tap or a
   * replayed request books against the SAME Player — where before the address and the name were
   * used to recognise a repeat. Editing who is booking mints a new one: that is a different attempt.
   */
  const attemptRef = useRef<CreationAttempt>(null);
  // Default to the WHOLE cyclus (only relevant when the slot is part of one) — nudges the fuller
  // booking; the visitor can toggle down to a single session.
  const [mode, setMode] = useState<'single' | 'cyclus'>('cyclus');
  const [sessions, setSessions] = useState<CyclusSession[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  // Owner switch (settings.allow_cyclus_booking via cycles_public): false ⇒ this cyclus
  // sells INDIVIDUAL sessions only — hide the whole-series option. Absent/true ⇒ unchanged.
  const [cyclusBookable, setCyclusBookable] = useState(true);

  const cyclusId = slot?.cyclus_id ?? null;

  // Reset the form (and default back to whole-cyclus) whenever a new slot is opened.
  useEffect(() => {
    if (open) {
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhone('');
      setNotes('');
      setSubmitting(false);
      setVerificationSent(false);
      setMode('cyclus');
    }
  }, [open, slot?.id]);

  // Load the cyclus's future public sessions so the "whole cyclus" option can list them + total,
  // and the cycle's public settings for the whole-cyclus-bookable switch.
  useEffect(() => {
    if (!open || !cyclusId) {
      setSessions([]);
      setCyclusBookable(true);
      return;
    }
    let cancelled = false;
    setLoadingSessions(true);
    // Fail-closed while loading: never flash (or preselect) a series option we may
    // have to withdraw once the cycle's real state arrives.
    setCyclusBookable(false);
    void (async () => {
      const [{ data }, { data: cyc }] = await Promise.all([
        supabase
          .from('availability_slots')
          .select('id, start_time, end_time, price_per_session')
          .eq('cyclus_id', cyclusId)
          .eq('is_public', true)
          .gte('start_time', new Date().toISOString())
          .order('start_time', { ascending: true }),
        // Sanitized anon view (status='open' only). A cycle we cannot see there is
        // NOT sellable as a series — draft/closed cycles and slots-only cycli must not
        // offer whole-series checkout the server (create-guest-cyclus-payment,
        // cyclus_not_bookable) will refuse anyway. This used to fail OPEN, which
        // showed — and preselected — a series option that died at payment.
        supabase
          .from('cycles_public' as never)
          .select('settings')
          .eq('id', cyclusId)
          .maybeSingle(),
      ]);
      if (!cancelled) {
        setSessions((data ?? []) as CyclusSession[]);
        const row = cyc as { settings?: Record<string, unknown> } | null;
        setCyclusBookable(row != null && row.settings?.allow_cyclus_booking !== false);
        setLoadingSessions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, cyclusId]);

  if (!slot) return null;

  const isCyclusSlot = !!cyclusId;
  // Respect the owner's allow_single_booking flag: only offer "just this session" when individual-
  // session booking is enabled. When it's false the cyclus can only be booked as the WHOLE series —
  // which also keeps a split_payment session (per-seat, priced total÷N via the cyclus path) from
  // being booked one-off at the full whole-slot price. Standalone (non-cyclus) slots are single by
  // nature and unaffected.
  const canBookSingle =
    slot.allow_single_booking === true ||
    // whole-slot selling: one booking claims the ENTIRE session at full price (capacity 1).
    // Never for split sessions — those are per-seat total÷N via the cyclus path (#352).
    (slot.whole_slot_booking === true && slot.split_payment !== true);
  // Owner switch inverse: allow_cyclus_booking=false sells individual sessions ONLY. When the
  // owner disabled BOTH (misconfiguration), fall back to the whole-cyclus path and let the
  // server guard answer — never silently offer a mode the server would refuse cheaper.
  const cyclusOffered = !cyclusBookable && canBookSingle ? false : true;
  const effectiveMode: 'single' | 'cyclus' = isCyclusSlot
    ? (!cyclusOffered ? 'single' : canBookSingle ? mode : 'cyclus')
    : 'single';
  const singlePrice = perSeatSessionPrice(slot);
  const cyclusTotal = sessions.reduce((sum, s) => sum + (s.price_per_session ?? 0), 0);
  const price = effectiveMode === 'cyclus' ? (cyclusTotal > 0 ? cyclusTotal : null) : singlePrice;

  const dayLabel = formatZonedDayLabel(slot.start_time, timezone, i18n.language);
  const timeLabel = `${formatZonedTime(slot.start_time, timezone)}–${formatZonedTime(slot.end_time, timezone)}`;
  const fmtSession = (s: CyclusSession) =>
    `${formatZonedDayLabel(s.start_time, timezone, i18n.language)} · ${formatZonedTime(s.start_time, timezone)}–${formatZonedTime(s.end_time, timezone)}`;

  const canSubmit =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    EMAIL_RE.test(email.trim()) &&
    validatePhone(phone, true) === null &&
    !submitting &&
    !(effectiveMode === 'cyclus' && loadingSessions);

  // "Add another session": nudge multi-slot booking. Only for cartable slots in
  // single-session mode — adds THIS slot to the selection and hands over to the cart
  // flow (floating button → drawer → one payment). already_in_cart counts as success:
  // the guest's intent (this session + more) is already satisfied.
  const cartable = cart != null && isCartableSlot(slot);
  const handleAddAnotherSession = () => {
    if (!cart) return;
    const result = cart.addItem(slot);
    const refusal = 'reason' in result ? result.reason : null;
    if (refusal && refusal !== 'already_in_cart') {
      toast.error(cartRefusalMessage(t, refusal));
      return;
    }
    toast.success(t('booking.cart.addedKeepBrowsing', 'Toegevoegd! Kies nog een sessie — afrekenen doe je via je selectie.'));
    onOpenChange(false);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const bookCyclus = effectiveMode === 'cyclus';
      const { data, error } = await supabase.functions.invoke(
        bookCyclus ? 'create-guest-cyclus-payment' : 'create-guest-slot-payment',
        {
          body: {
            ...(bookCyclus ? { cyclusId } : { slotId: slot.id }),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim(),
            phone: phone.trim(),
            notes: notes.trim() || undefined,
            whatsappOptIn,
            creationRequestId: creationRequestIdFor(
              attemptRef,
              // EVERY field the server fingerprints — name, address AND phone. A key that omits one
              // reuses the id after the booker corrects it, and the command answers a changed
              // payload with PLAYER_CREATE_IDEMPOTENCY_CONFLICT: the correction becomes unsavable.
              JSON.stringify([bookCyclus ? cyclusId : slot.id, email.trim().toLowerCase(),
                firstName.trim(), lastName.trim(), phone.trim()]),
            ),
          },
        },
      );

      const result = data as { checkoutUrl?: string; token?: string; status?: string } | null;
      if (result?.checkoutUrl) {
        // the Player for this attempt exists; a later booking is a new one, not a retry
        clearCreationAttempt(attemptRef);
        window.location.href = result.checkoutUrl;
        return;
      }

      // Identity continuity: the address matched existing Player(s); nothing was booked. Show the
      // generic verification prompt. The attempt id is KEPT so the resumed booking (after the
      // emailed link is followed and a Player chosen) replays the same attempt rather than making a
      // duplicate.
      if (result?.status === 'verification_required') {
        setVerificationSent(true);
        setSubmitting(false);
        return;
      }

      const code = error ? await extractFnErrorCode(error) : null;
      // Checkout failures must leave a remote trace (PostHog via logger) — a guest
      // sees only a toast, so without this the owner never learns checkout is
      // failing. IDs + codes only, never contact details (privacy posture).
      if (error || !result?.checkoutUrl) {
        logger.warn('Guest checkout refused/failed', {
          component: 'GuestBookingDialog',
          mode: effectiveMode,
          slotId: slot.id,
          cyclusId: cyclusId ?? undefined,
          code: code ?? 'no_checkout_url',
        });
      }
      if (code === 'slot_full') {
        toast.error(t('booking.guest.slotFull', 'Deze plek is net volgeboekt. Kies een ander moment.'));
      } else if (code === 'already_booked' && result?.token) {
        window.location.href = `/booking/${result.token}`;
        return;
      } else if (code === 'already_booked') {
        toast.error(t('booking.guest.alreadyBooked', 'Je hebt deze training al geboekt.'));
      } else if (code === 'no_mollie_account' || code === 'missing_mollie_profile' || code === 'mollie_not_ready') {
        toast.error(t('booking.guest.paymentUnavailable', 'Online betalen is niet beschikbaar voor deze training.'));
      } else if (code === 'mollie_error') {
        toast.error(t('booking.guest.paymentTemporarilyUnavailable', 'Online betalen is tijdelijk niet beschikbaar. Probeer het later opnieuw.'));
      } else if (code === 'slot_not_bookable' || code === 'slot_in_past' || code === 'cyclus_not_bookable') {
        toast.error(t('booking.guest.notBookable', 'Deze training kan niet meer geboekt worden.'));
      } else {
        toast.error(t('booking.guest.failed', 'Er ging iets mis. Probeer het opnieuw.'));
      }
      setSubmitting(false);
    } catch (err) {
      logger.error('Guest checkout threw', err instanceof Error ? err : new Error(String(err)), {
        component: 'GuestBookingDialog',
        mode: effectiveMode,
        slotId: slot.id,
      });
      toast.error(t('booking.guest.failed', 'Er ging iets mis. Probeer het opnieuw.'));
      setSubmitting(false);
    }
  };

  if (verificationSent) {
    // GENERIC by design: this text is identical whether one Player matched or several, and whether
    // or not an account exists — it reveals only that IF the address is on file, a link was sent.
    return (
      <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('booking.guest.verify.title', 'Controleer je e-mail')}</DialogTitle>
            <DialogDescription>
              {t('booking.guest.verify.body',
                'Als dit e-mailadres al bij ons bekend is, hebben we je een link gestuurd om te bevestigen dat jij het bent. Volg die link om je boeking af te ronden.')}
            </DialogDescription>
          </DialogHeader>
          {/* Same-device resume: re-submitting the SAME attempt after the link is followed resolves
              to the chosen person and proceeds to checkout. */}
          <Button
            onClick={() => { setVerificationSent(false); void handleSubmit(); }}
            disabled={submitting}
          >
            {t('booking.guest.verify.continue', 'Ik heb bevestigd — ga verder')}
          </Button>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {effectiveMode === 'cyclus'
              ? t('booking.guest.titleCyclus', 'Boek deze cyclus')
              : t('booking.guest.title', 'Boek deze training')}
          </DialogTitle>
          <DialogDescription>
            {t('booking.guest.subtitle', 'Vul je gegevens in en reken direct af. Je plek is pas geboekt na betaling.')}
          </DialogDescription>
        </DialogHeader>

        {/* This-session vs whole-cyclus choice — only when the slot is part of a cyclus AND the owner
            allows individual-session booking AND the whole series is bookable at all. */}
        {isCyclusSlot && canBookSingle && cyclusOffered && (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-label={t('booking.guest.modeSingle', 'Alleen deze sessie')}
              aria-pressed={mode === 'single'}
              onClick={() => setMode('single')}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                mode === 'single' ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
              )}
            >
              <span className="block text-sm font-medium">{t('booking.guest.modeSingle', 'Alleen deze sessie')}</span>
              {singlePrice != null && <span className="block text-xs text-muted-foreground">{formatPrice(singlePrice)}</span>}
            </button>
            <button
              type="button"
              aria-label={t('booking.guest.modeCyclus', 'Hele cyclus')}
              aria-pressed={mode === 'cyclus'}
              onClick={() => setMode('cyclus')}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                mode === 'cyclus' ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
              )}
            >
              <span className="block text-sm font-medium">{t('booking.guest.modeCyclus', 'Hele cyclus')}</span>
              <span className="block text-xs text-muted-foreground">
                {loadingSessions
                  ? '…'
                  : `${sessions.length} ${sessions.length === 1 ? t('session', 'sessie') : t('booking.guest.sessions', 'sessies')}${cyclusTotal > 0 ? ` · ${formatPrice(cyclusTotal)}` : ''}`}
              </span>
            </button>
          </div>
        )}

        {/* Summary */}
        <div className="rounded-lg border bg-muted/40 p-3 text-sm space-y-1">
          {slot.cyclus_name && <p className="font-medium">{slot.cyclus_name}</p>}
          {slot.trainer_name && <p className={slot.cyclus_name ? 'text-muted-foreground' : 'font-medium'}>{slot.trainer_name}</p>}

          {effectiveMode === 'cyclus' ? (
            loadingSessions ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('booking.guest.loadingSessions', 'Sessies laden…')}
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-0.5 pt-0.5">
                {sessions.map((s) => (
                  <p key={s.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarClock className="h-3 w-3 shrink-0" aria-hidden /> <span className="capitalize">{fmtSession(s)}</span>
                  </p>
                ))}
              </div>
            )
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground">
              <CalendarClock className="h-4 w-4" aria-hidden /> <span className="capitalize">{dayLabel}</span> · {timeLabel}
            </p>
          )}

          {slot.location_name && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <MapPin className="h-4 w-4" aria-hidden /> {slot.location_name}
            </p>
          )}
          {price != null && (
            <p className="font-semibold pt-1">
              {effectiveMode === 'cyclus' ? t('booking.guest.total', 'Totaal') : t('booking.guest.price', 'Prijs')}: {formatPrice(price)}
              {effectiveMode === 'cyclus' && slot.split_payment && (
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  ({t('booking.guest.splitNote', 'verdeeld over spelers')})
                </span>
              )}
            </p>
          )}
        </div>

        {/* Multi-session nudge: park this session in the selection and pick more — one payment
            at the end via the cart drawer. Hidden in whole-cyclus mode and for non-cartable slots. */}
        {effectiveMode === 'single' && cartable && (
          <button
            type="button"
            onClick={handleAddAnotherSession}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed p-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ShoppingCart className="h-4 w-4" aria-hidden />
            {cart && cart.count > 0
              ? t('booking.cart.addAnotherWithCount', 'Voeg toe aan selectie ({{count}} gekozen)', { count: cart.count })
              : t('booking.cart.addAnother', 'Meerdere sessies boeken? Voeg toe en kies er nog een')}
          </button>
        )}

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="guest-first">{t('booking.guest.firstName', 'Voornaam')}</Label>
              <Input
                id="guest-first"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="guest-last">{t('booking.guest.lastName', 'Achternaam')}</Label>
              <Input
                id="guest-last"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
              />
            </div>
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
            <Label htmlFor="guest-phone">{t('booking.guest.phone', 'Telefoon')}</Label>
            <PhoneInput id="guest-phone" value={phone} onChange={setPhone} required />
          </div>
          <WhatsAppOptInField
            id="guest-whatsapp"
            checked={whatsappOptIn}
            onCheckedChange={setWhatsappOptIn}
            phone={phone}
          />
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
