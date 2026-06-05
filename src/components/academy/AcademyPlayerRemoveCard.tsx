import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabaseClient';
import { removePlayerFromAcademy } from '@/lib/academyPlayerRemoval';
import type { AcademyPlayerKind } from '@/lib/academyPlayerDetails';
import { format } from 'date-fns';

type AcademyPlayerRemoveCardProps = {
  kind: AcademyPlayerKind;
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  playerName: string;
  removedAt: string | null;
};

export function AcademyPlayerRemoveCard({
  kind,
  academyProfileId,
  guestPlayerId,
  profileId,
  playerName,
  removedAt,
}: AcademyPlayerRemoveCardProps) {
  const { t } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (removedAt) {
    return (
      <Card data-testid="academy-player-removed-banner" className="border-muted">
        <CardHeader>
          <CardTitle className="text-base text-muted-foreground">
            {t('players.detail.removedFromAcademyTitle', 'Removed from academy')}
          </CardTitle>
          <CardDescription>
            {t('players.detail.removedFromAcademyDesc', 'This player was removed from your academy on {{date}}.', {
              date: format(new Date(removedAt), 'dd-MM-yyyy HH:mm'),
            })}
          </CardDescription>
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

      await removePlayerFromAcademy({
        academyProfileId,
        guestPlayerId,
        profileId,
        removedByProfileId,
      });

      toast({
        title: t('players.detail.removedFromAcademySuccess', 'Player removed from academy'),
        description: t(
          'players.detail.removedFromAcademySuccessDesc',
          'Historical bookings and invoices are unchanged.',
        ),
      });
      setConfirmOpen(false);
      navigate('/app/academy/players');
    } catch (err: unknown) {
      logger.error(
        'Error removing player from academy',
        err instanceof Error ? err : new Error(String(err)),
        { component: 'AcademyPlayerRemoveCard' },
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
      <Card data-testid="academy-player-remove-card" className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {t('players.detail.dangerZone', 'Danger zone')}
          </CardTitle>
          <CardDescription>
            {kind === 'registered'
              ? t(
                  'players.detail.removeRegisteredHint',
                  'Remove this player from your academy list. Their account and history stay intact.',
                )
              : t(
                  'players.detail.removeGuestHint',
                  'Remove this guest from your academy list without deleting historical bookings or invoices.',
                )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            data-testid="academy-player-remove-button"
            onClick={() => setConfirmOpen(true)}
          >
            {t('players.detail.removeFromAcademy', 'Remove from academy')}
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('players.detail.removeFromAcademyConfirmTitle', 'Remove player from academy?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'players.detail.removeFromAcademyConfirmDesc',
                'This will remove {{name}} from your academy list, but it will not delete their account or historical bookings/invoices.',
                { name: playerName },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>
              {t('players.detail.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="academy-player-remove-confirm"
              disabled={removing}
              onClick={(e) => {
                e.preventDefault();
                void handleRemove();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('players.detail.removeFromAcademy', 'Remove from academy')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
