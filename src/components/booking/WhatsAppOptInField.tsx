import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { MessageCircle } from 'lucide-react';

/**
 * The WhatsApp opt-in checkbox for SELF-SERVICE booking flows — the moment a person is
 * entering (or confirming) their OWN number and can actually consent.
 *
 * Deliberately NOT used on staff "book for player" surfaces. A trainer typing a player's phone
 * is not that player consenting, and the server enforces that too: there is no on-behalf-of
 * form of the opt-in RPCs at all.
 *
 * Meta requires opt-in that names the business and the channel, and enforcement is mechanical —
 * recipients blocking or reporting drives the sender's quality rating down and can get the
 * number disabled. So:
 *   * ALWAYS unchecked by default. `checked` is a required prop rather than defaulted, so a
 *     caller cannot get an opted-in control by forgetting to pass it.
 *   * The label states WHO sends and WHAT for; it is not a bare "WhatsApp?".
 *   * Hidden entirely when there is no usable number — an opt-in with nothing to send to is a
 *     promise we cannot keep.
 */
export interface WhatsAppOptInFieldProps {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The number consent is being given for. Blank/absent hides the field. */
  phone: string | null | undefined;
  /** Shown so the person can see the number they are consenting for. */
  showNumber?: boolean;
  /**
   * TRUE when ticking this also stores the number on the person's account. Ticking a messaging
   * box is not by itself consent to keep data on the profile, so when that is what happens the
   * label must say so — otherwise the consent granted is narrower than the action taken.
   */
  savesToProfile?: boolean;
  disabled?: boolean;
}

export function WhatsAppOptInField({
  id,
  checked,
  onCheckedChange,
  phone,
  showNumber = false,
  savesToProfile = false,
  disabled,
}: WhatsAppOptInFieldProps) {
  const { t } = useTranslation('common');
  const trimmed = (phone ?? '').trim();
  if (!trimmed) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        disabled={disabled}
        className="mt-0.5"
        data-testid="whatsapp-optin"
      />
      <Label htmlFor={id} className="text-sm font-normal leading-snug cursor-pointer">
        <span className="flex items-center gap-1.5 font-medium">
          <MessageCircle className="h-3.5 w-3.5" aria-hidden />
          {t('booking.whatsapp.optInTitle', 'Herinneringen via WhatsApp')}
        </span>
        <span className="text-muted-foreground">
          {showNumber
            ? t('booking.whatsapp.optInWithNumber', 'Stuur me een herinnering voor deze training op {{phone}}. Je kunt dit altijd stoppen.', { phone: trimmed })
            : t('booking.whatsapp.optIn', 'Stuur me een herinnering voor deze training via WhatsApp. Je kunt dit altijd stoppen.')}
          {savesToProfile && (
            <>
              {' '}
              <span data-testid="whatsapp-optin-profile-note">
                {t('booking.whatsapp.savesToProfile', 'We bewaren dit nummer bij je profiel.')}
              </span>
            </>
          )}
        </span>
      </Label>
    </div>
  );
}
