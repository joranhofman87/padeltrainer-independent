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
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabaseClient';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { removePlayerFromTrainer } from '@/lib/trainerPlayerRemoval';
import type { AcademyPlayerKind } from '@/lib/academyPlayerDetails';
import { format } from 'date-fns';

type TrainerPlayerRemoveCardProps = {
  kind: AcademyPlayerKind;
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  playerName: string;
  removedAt: string | null;
};

export function TrainerPlayerRemoveCard({
  kind,
  trainerProfileId,
  guestPlayerId,
  profileId,
  playerName,
  removedAt,
}: TrainerPlayerRemoveCardProps) {
  const { t } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (removedAt) {
    return (
      <Card data-testid="trainer-player-removed-banner" className="border-muted">
        <CardHeader>
          <CardTitle className="text-base text-muted-foreground">
            {t('players.detail.removedFromTrainerTitle', 'Removed from trainer')}
          </CardTitle>
          <CardDescription>
            {t('players.detail.removedFromTrainerDesc', 'This player was removed from your trainer account on {{date}}.', {
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

      await removePlayerFromTrainer({
        trainerProfileId,
        guestPlayerId,
        profileId,
        removedByProfileId,
      });

      toast({
        title: t('players.detail.removedFromTrainerSuccess', 'Player removed from trainer'),
        description: t(
          'players.detail.removedFromTrainerSuccessDesc',
          'Historical bookings, invoices, and notes are unchanged.',
        ),
      });
      setConfirmOpen(false);
      invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerProfileId });
      navigate('/app/trainer/players');
    } catch (err: unknown) {
      logger.error(
        'Error removing player from trainer',
        err instanceof Error ? err : new Error(String(err)),
        { component: 'TrainerPlayerRemoveCard' },
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
      <Card data-testid="trainer-player-remove-card" className="border-destructive/30">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            {t('players.detail.dangerZone', 'Danger zone')}
          </CardTitle>
          <CardDescription>
            {kind === 'registered'
              ? t(
                  'players.detail.removeRegisteredTrainerHint',
                  'Remove this player from your trainer list. Their account and history stay intact.',
                )
              : t(
                  'players.detail.removeGuestTrainerHint',
                  'Remove this guest from your trainer list without deleting historical bookings or invoices.',
                )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            data-testid="trainer-player-remove-button"
            onClick={() => setConfirmOpen(true)}
          >
            {t('players.detail.removeFromTrainer', 'Remove from trainer')}
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('players.detail.removeFromTrainerConfirmTitle', 'Remove player from trainer?')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                'players.detail.removeFromTrainerConfirmDesc',
                'This will remove {{name}} from your trainer list, but it will not delete their account or historical bookings/invoices.',
                { name: playerName },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>
              {t('players.detail.cancel', 'Cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid="trainer-player-remove-confirm"
              disabled={removing}
              onClick={(e) => {
                e.preventDefault();
                void handleRemove();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('players.detail.removeFromTrainer', 'Remove from trainer')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
