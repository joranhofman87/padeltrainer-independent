import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { PlayerRemoveCard } from '@/components/players/PlayerRemoveCard';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { removePlayerFromTrainer } from '@/lib/trainerPlayerRemoval';
import type { AcademyPlayerKind } from '@/lib/academyPlayerDetails';

type TrainerPlayerRemoveCardProps = {
  kind: AcademyPlayerKind;
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  playerName: string;
  removedAt: string | null;
};

/** Trainer-scoped remove card — a thin wrapper over the shared {@link PlayerRemoveCard}. */
export function TrainerPlayerRemoveCard({
  kind,
  trainerProfileId,
  guestPlayerId,
  profileId,
  playerName,
  removedAt,
}: TrainerPlayerRemoveCardProps) {
  const { t } = useTranslation('trainer');
  const queryClient = useQueryClient();

  return (
    <PlayerRemoveCard
      rolePrefix="trainer"
      removedAt={removedAt}
      navigateTo="/app/trainer/players"
      invalidate={() => invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerProfileId })}
      remove={(removedByProfileId) =>
        removePlayerFromTrainer({ trainerProfileId, guestPlayerId, profileId, removedByProfileId })}
      copy={{
        removedTitle: t('players.detail.removedFromTrainerTitle', 'Removed from trainer'),
        removedDesc: removedAt
          ? t('players.detail.removedFromTrainerDesc', 'This player was removed from your trainer account on {{date}}.', {
              date: format(new Date(removedAt), 'dd-MM-yyyy HH:mm'),
            })
          : '',
        dangerHint:
          kind === 'registered'
            ? t('players.detail.removeRegisteredTrainerHint', 'Remove this player from your trainer list. Their account and history stay intact.')
            : t('players.detail.removeGuestTrainerHint', 'Remove this guest from your trainer list without deleting historical bookings or invoices.'),
        removeButton: t('players.detail.removeFromTrainer', 'Remove from trainer'),
        confirmTitle: t('players.detail.removeFromTrainerConfirmTitle', 'Remove player from trainer?'),
        confirmDesc: t('players.detail.removeFromTrainerConfirmDesc', 'This will remove {{name}} from your trainer list, but it will not delete their account or historical bookings/invoices.', {
          name: playerName,
        }),
        successTitle: t('players.detail.removedFromTrainerSuccess', 'Player removed from trainer'),
        successDesc: t('players.detail.removedFromTrainerSuccessDesc', 'Historical bookings, invoices, and notes are unchanged.'),
      }}
    />
  );
}
