import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

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
 * Shared, role-neutral "remove player" danger-zone card.
 *
 * ABC-16 H0 — removal is temporarily unavailable. Soft removal wrote (and for a player with
 * no prior overlay row, CREATED) the `academy_player_metadata` row that three authorization
 * predicates accepted as proof of the academy↔player relationship, for a caller-chosen
 * subject. Until an H1 command derives the subject from canonical membership server-side
 * there is no writer, so the button is disabled rather than left to fail after the user has
 * confirmed a destructive-sounding action.
 *
 * Players ALREADY removed are unaffected: the removed banner below still renders from the
 * same `removed_at`, which H0 neither changed nor stopped reading.
 */
export type PlayerRemoveCardProps = {
  /** data-testid prefix, e.g. 'trainer' or 'academy'. */
  rolePrefix: string;
  removedAt: string | null;
  copy: PlayerRemoveCardCopy;
  /** Where to go after a successful removal. Unused while removal is contained. */
  navigateTo?: string;
  /** Invalidate the role's player caches. Unused while removal is contained. */
  invalidate?: () => void;
  /** The role removal writer. Unused while removal is contained. */
  remove?: (removedByProfileId: string | null) => Promise<void>;
};

export function PlayerRemoveCard({ rolePrefix, removedAt, copy }: PlayerRemoveCardProps) {
  const { t } = useTranslation('trainer');

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

  return (
    <Card data-testid={`${rolePrefix}-player-remove-card`} className="border-destructive/30">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {t('players.detail.dangerZone', 'Danger zone')}
        </CardTitle>
        <CardDescription>{copy.dangerHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button variant="destructive" data-testid={`${rolePrefix}-player-remove-button`} disabled>
          {copy.removeButton}
        </Button>
        <p className="text-xs text-muted-foreground" data-testid={`${rolePrefix}-player-remove-unavailable`}>
          {t(
            'players.detail.removeUnavailable',
            'Removing a player is temporarily unavailable while we improve how players are linked to your academy. Nothing about this player has changed.',
          )}
        </p>
      </CardContent>
    </Card>
  );
}
