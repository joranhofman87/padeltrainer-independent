import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Loader2, MailWarning } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { updateGuestEmail } from '@/lib/emailBounce';

interface Props {
  academyProfileId: string;
  playerType: 'registered' | 'guest';
  profileId: string | null;
  guestPlayerId: string | null;
  currentEmail: string | null;
  onFixed?: () => void;
}

/**
 * Inline "fix a bouncing email" control.
 *
 * ABC-16 H0 reduced this to the one path that is independently safe:
 *
 *   - GUEST      -> edit the guest contact email directly. A guest has no login, and the
 *                   write lands on `guest_players`, whose policies are ownership-based and
 *                   reference no overlay table.
 *   - REGISTERED -> guidance only. Both former writers are gone: overwriting the player's
 *                   real login email (an academy may not rewrite an accepted identity) and
 *                   the billing override (it wrote `academy_player_metadata`, now read-only).
 *
 * The registered branch deliberately renders NO input. An input that cannot save is worse
 * than none: it invites the work and then throws it away.
 */
export function EmailFixControl({ playerType, guestPlayerId, currentEmail, onFixed }: Props) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  const isGuest = playerType === 'guest';

  const save = async () => {
    const next = email.trim().toLowerCase();
    if (!next || next === (currentEmail || '').toLowerCase()) return;
    if (!guestPlayerId) return;
    setSaving(true);
    try {
      await updateGuestEmail(guestPlayerId, next);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['academy-undeliverable-recipients'] }),
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

      {isGuest ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t('emailDelivery.directHelp', 'Enter a corrected email address.')}
          </p>
          <div className="flex gap-2">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailDelivery.newEmailPlaceholder', 'New email address')}
              className="h-9"
            />
            <Button size="sm" onClick={save} disabled={saving || !email.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t('emailDelivery.fixSave', 'Save')}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="email-fix-self-service">
          {t(
            'emailDelivery.selfServiceHelp',
            'This player signs in with this email address, so only they can change it. Ask them to update it in their own account settings. Setting a separate invoice email is temporarily unavailable.',
          )}
        </p>
      )}
    </div>
  );
}
