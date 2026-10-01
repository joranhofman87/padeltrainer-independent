import { useTranslation } from 'react-i18next';
import { MapPin, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { usePlayerLocations } from '@/lib/playerLocations';

type Club = { id: string; name: string };

/**
 * The player's CLUBS, matching the players table exactly (get_player_locations = the same
 * union).
 *
 * ABC-16 H0 — curation is temporarily view-only. Adding or removing a club called
 * `set_player_location`, whose manager gate proved only that the caller manages the ACADEMY;
 * the subject was a caller-supplied profile or guest id that nothing checked. The RPC's
 * client EXECUTE is withdrawn, so the remove "x" and the "Add club" picker are gone rather
 * than left to fail on click.
 *
 * Every club that was displayed before is still displayed, including ones a previous manual
 * attach surfaced: this reads `get_player_locations`, which H0 did not change.
 */
export function PlayerLocationsControl({
  academyProfileId,
  profileId,
  guestPlayerId,
}: {
  academyProfileId: string;
  profileId: string | null;
  guestPlayerId: string | null;
  /** Retained so the caller's props keep type-checking; unused while curation is view-only. */
  academyLocations?: Club[];
}) {
  const { t } = useTranslation('trainer');
  const { data: shown = [], isLoading } = usePlayerLocations({ academyProfileId, profileId, guestPlayerId });

  const readOnlyHint = t(
    'players.detail.clubsReadOnly',
    'Clubs are temporarily view-only while we improve how players are linked to your academy.',
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5" title={readOnlyHint}>
      <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : shown.length === 0 ? (
        <span className="text-sm text-muted-foreground">{t('players.detail.noClubs', 'No clubs yet')}</span>
      ) : (
        shown.map((s) => (
          <Badge key={s.location_id} variant="secondary" className="gap-1 font-normal">
            {s.location_name}
          </Badge>
        ))
      )}
    </div>
  );
}
