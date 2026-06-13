import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Users, X, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabaseClient';
import { formatDate } from '@/lib/format';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { fetchTrainerDisplayNamesByProfileIds } from '@/lib/trainerDisplayNames';
import { declineClaimAsManager, type ClaimStatus } from '@/lib/priorityClaims';

interface Props {
  cycleId: string;
}

interface SlotRow {
  id: string;
  start_time: string;
  trainer_id: string | null;
  location_id: string | null;
}

interface ClaimRow {
  id: string;
  slot_id: string;
  player_id: string | null;
  guest_player_id: string | null;
  status: ClaimStatus;
  rebook_group_id: string | null;
  claim_token: string;
}

interface RosterData {
  slots: SlotRow[];
  claims: ClaimRow[];
  nameByPlayerId: Map<string, string>;
  nameByGuestId: Map<string, string>;
  trainerNameById: Map<string, string>;
}

/** A distinct tentative player within a rebook group, with all their pending claim ids. */
interface GroupPlayer {
  key: string;
  name: string;
  claimIds: string[];
}

/** A rebook series (group) with its earliest slot and its tentative players. */
interface RosterGroup {
  key: string;
  earliestStart: string;
  trainerId: string | null;
  players: GroupPlayer[];
}

async function loadRoster(cycleId: string): Promise<RosterData> {
  const { data: slotData, error: slotError } = await supabase
    .from('availability_slots')
    .select('id, start_time, trainer_id, location_id')
    .eq('cyclus_id', cycleId);
  if (slotError) throw slotError;
  const slots = (slotData ?? []) as SlotRow[];
  const slotIds = slots.map((s) => s.id);

  if (slotIds.length === 0) {
    return {
      slots,
      claims: [],
      nameByPlayerId: new Map(),
      nameByGuestId: new Map(),
      trainerNameById: new Map(),
    };
  }

  const { data: claimData, error: claimError } = await supabase
    .from('slot_priority_claims')
    .select('id, slot_id, player_id, guest_player_id, status, rebook_group_id, claim_token')
    .in('slot_id', slotIds);
  if (claimError) throw claimError;
  const claims = (claimData ?? []) as ClaimRow[];

  // Resolve display names. Academies cannot read `profiles` directly, so
  // registered players are looked up via the `profiles_public` view (keyed on
  // profiles.id); guests come from `guest_players`.
  const playerIds = [...new Set(claims.map((c) => c.player_id).filter((id): id is string => !!id))];
  const guestIds = [...new Set(claims.map((c) => c.guest_player_id).filter((id): id is string => !!id))];
  const trainerIds = [...new Set(slots.map((s) => s.trainer_id).filter((id): id is string => !!id))];

  const nameByPlayerId = new Map<string, string>();
  const nameByGuestId = new Map<string, string>();

  const [profilesResult, guestsResult, trainerNameById] = await Promise.all([
    playerIds.length > 0
      ? supabase.from('profiles_public').select('id, full_name').in('id', playerIds)
      : Promise.resolve({ data: [], error: null } as const),
    guestIds.length > 0
      ? supabase.from('guest_players').select('id, full_name').in('id', guestIds)
      : Promise.resolve({ data: [], error: null } as const),
    fetchTrainerDisplayNamesByProfileIds(trainerIds, supabase, 'TentativeRosterSection'),
  ]);

  for (const p of profilesResult.data ?? []) {
    if (p.id && p.full_name) nameByPlayerId.set(p.id, p.full_name);
  }
  for (const g of guestsResult.data ?? []) {
    if (g.id && g.full_name) nameByGuestId.set(g.id, g.full_name);
  }

  return { slots, claims, nameByPlayerId, nameByGuestId, trainerNameById };
}

export default function TentativeRosterSection({ cycleId }: Props) {
  const { t } = useTranslation('cycles');
  const [removingKey, setRemovingKey] = useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['tentative-roster', cycleId],
    queryFn: () => loadRoster(cycleId),
    enabled: !!cycleId,
    staleTime: 30_000,
  });

  const { groups, counts } = useMemo(() => {
    if (!data) {
      return { groups: [] as RosterGroup[], counts: { claimed: 0, pending: 0, declined: 0 } };
    }
    const { slots, claims, nameByPlayerId, nameByGuestId } = data;
    const slotById = new Map(slots.map((s) => [s.id, s]));

    // Count distinct PLAYERS per status (a multi-week series is one player, not
    // N claims) so "4 tentatief" matches the 4 names shown.
    const playerKeyOf = (c: { player_id: string | null; guest_player_id: string | null; id: string }) =>
      c.player_id ? `p:${c.player_id}` : c.guest_player_id ? `g:${c.guest_player_id}` : `c:${c.id}`;
    const claimedSet = new Set<string>();
    const pendingSet = new Set<string>();
    const declinedSet = new Set<string>();
    for (const c of claims) {
      if (c.status === 'claimed') claimedSet.add(playerKeyOf(c));
      else if (c.status === 'pending') pendingSet.add(playerKeyOf(c));
      else if (c.status === 'declined') declinedSet.add(playerKeyOf(c));
    }
    const counts = { claimed: claimedSet.size, pending: pendingSet.size, declined: declinedSet.size };

    // Build groups from PENDING claims only, keyed on rebook_group_id (fallback
    // to slot_id when a claim has no group). Within a group, collapse a player's
    // weekly claims into one entry so removing them opens the whole series.
    const grouped = new Map<string, Map<string, GroupPlayer>>();
    for (const c of claims) {
      if (c.status !== 'pending') continue;
      const groupKey = c.rebook_group_id ?? `slot:${c.slot_id}`;
      const playerKey = c.player_id
        ? `p:${c.player_id}`
        : c.guest_player_id
          ? `g:${c.guest_player_id}`
          : `c:${c.id}`;
      if (!grouped.has(groupKey)) grouped.set(groupKey, new Map());
      const playersInGroup = grouped.get(groupKey)!;
      const existing = playersInGroup.get(playerKey);
      if (existing) {
        existing.claimIds.push(c.id);
      } else {
        const name = c.player_id
          ? nameByPlayerId.get(c.player_id) ?? t('tentativeRoster.unknownPlayer', 'Unknown player')
          : c.guest_player_id
            ? nameByGuestId.get(c.guest_player_id) ?? t('tentativeRoster.unknownPlayer', 'Unknown player')
            : t('tentativeRoster.unknownPlayer', 'Unknown player');
        playersInGroup.set(playerKey, { key: playerKey, name, claimIds: [c.id] });
      }
    }

    const groups: RosterGroup[] = [];
    for (const [groupKey, playersInGroup] of grouped) {
      // Earliest slot in the group defines the heading (weekday + time + trainer).
      let earliestStart: string | null = null;
      let trainerId: string | null = null;
      for (const player of playersInGroup.values()) {
        for (const claimId of player.claimIds) {
          const claim = claims.find((cc) => cc.id === claimId);
          const slot = claim ? slotById.get(claim.slot_id) : undefined;
          if (slot && (earliestStart === null || slot.start_time < earliestStart)) {
            earliestStart = slot.start_time;
            trainerId = slot.trainer_id;
          }
        }
      }
      groups.push({
        key: groupKey,
        earliestStart: earliestStart ?? '',
        trainerId,
        players: [...playersInGroup.values()].sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    groups.sort((a, b) => a.earliestStart.localeCompare(b.earliestStart));

    return { groups, counts };
  }, [data, t]);

  if (isLoading || !data) return null;

  // Nothing to surface and nothing happened yet → stay out of the way entirely.
  if (groups.length === 0 && counts.claimed === 0 && counts.declined === 0) return null;

  const handleRemove = async (player: GroupPlayer) => {
    setRemovingKey(player.key);
    try {
      // Decline every pending claim this player holds in the series so the whole
      // weekly series opens up, not just one session.
      for (const claimId of player.claimIds) {
        await declineClaimAsManager(claimId);
      }
      await refetch();
      toast.success(t('tentativeRoster.removed', 'Speler verwijderd — plek komt vrij'));
    } catch (e) {
      toast.error(
        getFriendlyErrorMessage(e, t('tentativeRoster.removeError', 'Kon de speler niet verwijderen. Probeer het opnieuw.')),
      );
    } finally {
      setRemovingKey(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4" />
            {t('tentativeRoster.title', 'Voorlopige spelers (herboeking)')}
          </CardTitle>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="secondary">
              {t('tentativeRoster.countPending', { count: counts.pending, defaultValue: '{{count}} tentatief' })}
            </Badge>
            <Badge variant="default">
              {t('tentativeRoster.countClaimed', { count: counts.claimed, defaultValue: '{{count}} bevestigd' })}
            </Badge>
            <Badge variant="outline">
              {t('tentativeRoster.countDeclined', { count: counts.declined, defaultValue: '{{count}} afgemeld' })}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('tentativeRoster.empty', 'Geen voorlopige spelers meer — alle uitnodigingen zijn beantwoord.')}
          </p>
        ) : (
          groups.map((group) => {
            const trainerName = group.trainerId ? data.trainerNameById.get(group.trainerId) : null;
            const heading = group.earliestStart
              ? `${formatDate(group.earliestStart, 'EEEEEE HH:mm')}${trainerName ? ` · ${trainerName}` : ''}`
              : trainerName ?? t('tentativeRoster.groupFallback', 'Serie');
            return (
              <div key={group.key} className="space-y-2">
                <h4 className="text-sm font-medium capitalize">{heading}</h4>
                <div className="space-y-1.5">
                  {group.players.map((player) => (
                    <div key={player.key} className="flex items-center justify-between gap-2 border rounded-md p-2">
                      <span className="text-sm">{player.name}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={removingKey !== null}
                        onClick={() => handleRemove(player)}
                      >
                        {removingKey === player.key ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <X className="h-4 w-4 mr-1" />
                        )}
                        {t('tentativeRoster.remove', 'Verwijderen')}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
