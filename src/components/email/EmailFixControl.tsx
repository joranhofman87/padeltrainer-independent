import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, MailWarning } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import {
  usePlayerEmailEditCapability,
  updatePlayerEmailDirect,
  updateGuestEmail,
  updateBillingEmailOverride,
} from '@/lib/emailBounce';

interface Props {
  academyProfileId: string;
  playerType: 'registered' | 'guest';
  profileId: string | null;
  guestPlayerId: string | null;
  currentEmail: string | null;
  onFixed?: () => void;
}

/**
 * Inline "fix a bouncing email" control. Picks the right path:
 *  - guest               -> edit the guest contact email directly
 *  - registered/'direct'  -> overwrite the real login email (gated edge fn)
 *  - registered/'override'-> set an invoice-only billing-email override
 * Because bounce state is address-keyed, saving a new address clears the flags.
 */
export function EmailFixControl({ academyProfileId, playerType, profileId, guestPlayerId, currentEmail, onFixed }: Props) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: capability } = usePlayerEmailEditCapability(
    playerType === 'registered' ? profileId : null,
    playerType === 'registered' ? academyProfileId : null,
  );
  const mode: 'guest' | 'direct' | 'override' =
    playerType === 'guest' ? 'guest' : (capability ?? 'override');
  const isOverride = mode === 'override';

  const save = async () => {
    const next = email.trim().toLowerCase();
    if (!next || next === (currentEmail || '').toLowerCase()) return;
    setSaving(true);
    try {
      if (mode === 'guest' && guestPlayerId) {
        await updateGuestEmail(guestPlayerId, next);
      } else if (mode === 'direct' && profileId) {
        await updatePlayerEmailDirect(profileId, academyProfileId, next);
      } else {
        await updateBillingEmailOverride({ academyProfileId, profileId, guestPlayerId, email: next });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['academy-undeliverable-recipients'] }),
        qc.invalidateQueries({ queryKey: ['player-email-edit-capability'] }),
        qc.invalidateQueries({ queryKey: ['players-overview'] }),
        qc.invalidateQueries({ queryKey: ['invoices-delivery-status'] }),
      ]);
      toast({ title: t('emailDelivery.fixed', 'Email updated') });
      setEmail('');
      onFixed?.();
    } catch (e) {
      toast({
        title: getFriendlyErrorMessage(e, t('emailDelivery.fixFailed', 'Could not update email')),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-destructive">
        <MailWarning className="h-4 w-4" />
        {t('emailDelivery.fixTitle', 'This email is bouncing')}
      </div>
      <p className="text-xs text-muted-foreground">
        {isOverride
          ? t('emailDelivery.overrideHelp', "You can't change this player's login email, so set a billing email used only for their invoices.")
          : t('emailDelivery.directHelp', 'Enter a corrected email address.')}
      </p>
      <div className="flex gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={isOverride
            ? t('emailDelivery.billingEmailPlaceholder', 'Billing email')
            : t('emailDelivery.newEmailPlaceholder', 'New email address')}
          className="h-9"
        />
        <Button size="sm" onClick={save} disabled={saving || !email.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('emailDelivery.fixSave', 'Save')}
        </Button>
      </div>
    </div>
  );
}
