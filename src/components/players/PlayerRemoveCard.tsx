import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabaseClient';

/** Role-resolved copy for the remove card — the wrapper resolves its own i18n keys (which differ
 *  per role, e.g. removeRegisteredTrainerHint vs removeRegisteredHint) and the date/name
 *  interpolation, and passes the finished strings in. */
export type PlayerRemoveCardCopy = {
  removedTitle: string;
  removedDesc: string;
  dangerHint: string;
  removeButton: string;
  confirmTitle: string;
  confirmDesc: string;
  successTitle: string;
  successDesc: string;
};

/**
 * Shared, role-neutral "remove player" danger-zone card. The trainer and academy variants were
 * near-identical copies of the SAME removal flow (auth → resolve actor profile → remove → toast →
 * invalidate → navigate) with only role-specific copy/keys/writer/path differing. This is the single
 * source of that flow; thin role wrappers inject the removal writer, the post-remove route, the
 * cache-invalidation, and the resolved copy.
 */
export type PlayerRemoveCardProps = {
  /** data-testid prefix, e.g. 'trainer' or 'academy'. */
  rolePrefix: string;
  removedAt: string | null;
  copy: PlayerRemoveCardCopy;
  /** Where to go after a successful removal. */
  navigateTo: string;
  /** Invalidate the role's player caches (binds invalidateAllPlayerData with the role scope). */
  invalidate: () => void;
  /** The role removal writer (binds removePlayerFromTrainer / removePlayerFromAcademy). */
  remove: (removedByProfileId: string | null) => Promise<void>;
};

export function PlayerRemoveCard({
  rolePrefix,
  removedAt,
  copy,
  navigateTo,
  invalidate,
  remove,
}: PlayerRemoveCardProps) {
  const { t } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (removedAt) {
    return (
      <Card data-testid={`${rolePrefix}-player-removed-banner`} className="border-muted">
        <CardHeader>
          <CardTitle className="text-base text-muted-foreground">{copy.removedTitle}</CardTitle>
          <CardDescription>{copy.removedDesc}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      let removedByProfileId: string | null = null;
      const { data: authData } = await supabase.auth.getUser();
      if (authData.user?.id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('user_id', authData.user.id)
          .maybeSingle();
        removedByProfileId = profile?.id ?? null;
      }

      await remove(removedByProfileId);

      toast({ title: copy.successTitle, description: copy.successDesc });
      setConfirmOpen(false);
      invalidate();
      navigate(navigateTo);
    } catch (err: unknown) {
      logger.error(
        'Error removing player',
        err instanceof Error ? err : new Error(String(err)),
        { component: 'PlayerRemoveCard', rolePrefix },
      );
      toast({
        title: tCommon('error', 'Error'),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <Card data-testid={`${rolePrefix}-player-remove-card`} className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {t('players.detail.dangerZone', 'Danger zone')}
          </CardTitle>
          <CardDescription>{copy.dangerHint}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            data-testid={`${rolePrefix}-player-remove-button`}
            onClick={() => setConfirmOpen(true)}
          >
            {copy.removeButton}
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={copy.confirmTitle}
        description={copy.confirmDesc}
        confirmLabel={copy.removeButton}
        cancelLabel={t('players.detail.cancel', 'Cancel')}
        onConfirm={handleRemove}
        loading={removing}
        confirmTestId={`${rolePrefix}-player-remove-confirm`}
      />
    </>
  );
}
