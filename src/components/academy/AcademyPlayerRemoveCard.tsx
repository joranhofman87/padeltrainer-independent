import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { PlayerRemoveCard } from '@/components/players/PlayerRemoveCard';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { removePlayerFromAcademy } from '@/lib/academyPlayerRemoval';
import type { AcademyPlayerKind } from '@/lib/academyPlayerDetails';

type AcademyPlayerRemoveCardProps = {
  kind: AcademyPlayerKind;
  academyProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  playerName: string;
  removedAt: string | null;
};

/** Academy-scoped remove card — a thin wrapper over the shared {@link PlayerRemoveCard}. */
export function AcademyPlayerRemoveCard({
  kind,
  academyProfileId,
  guestPlayerId,
  profileId,
  playerName,
  removedAt,
}: AcademyPlayerRemoveCardProps) {
  const { t } = useTranslation('trainer');
  const queryClient = useQueryClient();

  return (
    <PlayerRemoveCard
      rolePrefix="academy"
      removedAt={removedAt}
      navigateTo="/app/academy/players"
      invalidate={() => invalidateAllPlayerData(queryClient, { kind: 'academy', id: academyProfileId })}
      remove={(removedByProfileId) =>
        removePlayerFromAcademy({ academyProfileId, guestPlayerId, profileId, removedByProfileId })}
      copy={{
        removedTitle: t('players.detail.removedFromAcademyTitle', 'Removed from academy'),
        removedDesc: removedAt
          ? t('players.detail.removedFromAcademyDesc', 'This player was removed from your academy on {{date}}.', {
              date: format(new Date(removedAt), 'dd-MM-yyyy HH:mm'),
            })
          : '',
        dangerHint:
          kind === 'registered'
            ? t('players.detail.removeRegisteredHint', 'Remove this player from your academy list. Their account and history stay intact.')
            : t('players.detail.removeGuestHint', 'Remove this guest from your academy list without deleting historical bookings or invoices.'),
        removeButton: t('players.detail.removeFromAcademy', 'Remove from academy'),
        confirmTitle: t('players.detail.removeFromAcademyConfirmTitle', 'Remove player from academy?'),
        confirmDesc: t('players.detail.removeFromAcademyConfirmDesc', 'This will remove {{name}} from your academy list, but it will not delete their account or historical bookings/invoices.', {
          name: playerName,
        }),
        successTitle: t('players.detail.removedFromAcademySuccess', 'Player removed from academy'),
        successDesc: t('players.detail.removedFromAcademySuccessDesc', 'Historical bookings and invoices are unchanged.'),
      }}
    />
  );
}
