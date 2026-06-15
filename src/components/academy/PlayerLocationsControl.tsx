import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MapPin, X, Plus, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { academyPlayersQueryKey } from '@/lib/academyPlayersQuery';
import { usePlayerLocations, setPlayerLocation, playerLocationsQueryKey } from '@/lib/playerLocations';

type Club = { id: string; name: string };

/**
 * The player's CLUBS, matching the players table exactly (get_player_locations =
 * the same union). Removable chips + an "Add club" picker let the academy curate:
 * remove suppresses a club (even an auto/trained one), add force-shows a club the
 * auto sources missed. Writes go through set_player_location (manager-gated).
 */
export function PlayerLocationsControl({
  academyProfileId,
  profileId,
  guestPlayerId,
  academyLocations,
}: {
  academyProfileId: string;
  profileId: string | null;
  guestPlayerId: string | null;
  academyLocations: Club[];
}) {
  const { t } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const { data: shown = [], isLoading } = usePlayerLocations({ academyProfileId, profileId, guestPlayerId });
  const shownIds = new Set(shown.map((s) => s.location_id));
  const addable = academyLocations.filter((l) => !shownIds.has(l.id));

  const mutate = async (locationId: string, dismissed: boolean) => {
    setBusy(true);
    try {
      await setPlayerLocation({ academyProfileId, profileId, guestPlayerId, locationId, dismissed });
      await queryClient.invalidateQueries({ queryKey: playerLocationsQueryKey(academyProfileId, profileId, guestPlayerId) });
      queryClient.invalidateQueries({ queryKey: academyPlayersQueryKey(academyProfileId) });
    } catch (err) {
      logger.error('set player location failed', err instanceof Error ? err : new Error(String(err)), { component: 'PlayerLocationsControl' });
      toast({ title: tCommon('error', 'Error'), description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      ) : shown.length === 0 ? (
        <span className="text-sm text-muted-foreground">{t('players.detail.noClubs', 'No clubs yet')}</span>
      ) : (
        shown.map((s) => (
          <Badge key={s.location_id} variant="secondary" className="gap-1 font-normal">
            {s.location_name}
            <button
              type="button"
              aria-label={t('players.detail.removeClub', 'Remove club')}
              disabled={busy}
              onClick={() => void mutate(s.location_id, true)}
              className="ml-0.5 rounded-sm hover:text-destructive disabled:opacity-50"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))
      )}
      {addable.length > 0 && (
        <Select value="" onValueChange={(v) => v && void mutate(v, false)} disabled={busy}>
          <SelectTrigger
            aria-label={t('players.detail.addClub', 'Add club')}
            className="h-6 w-auto gap-1 border-dashed px-2 text-xs text-muted-foreground"
          >
            <Plus className="h-3 w-3" /> {t('players.detail.addClub', 'Add club')}
          </SelectTrigger>
          <SelectContent>
            {addable.map((l) => (
              <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
