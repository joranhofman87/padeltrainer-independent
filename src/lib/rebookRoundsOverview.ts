import {
  listRebookRounds,
  getCycleRebookStatus,
  type RebookRound,
  type RebookManageData,
} from '@/lib/rebookManage';
import { logger } from '@/lib/logger';

/**
 * One flattened overview row per rebooking ROUND for the manage hub's table — round identity plus the
 * same aggregates the per-round manage view shows (response funnel + money + invites + seats), so the
 * hub and the drill-in never disagree. `id` is the round's primary cycle id (the drill-in target).
 */
export interface RebookRoundOverviewRow {
  id: string;
  name: string;
  startDate: string | null;
  status: string; // cycle status: draft | open | closed
  archived: boolean;
  seriesCount: number; // cycles in the round (per-series split ⇒ >1)
  invited: number;
  rebooked: number;
  noResponse: number;
  declined: number;
  clickedYesUnpaid: number;
  paidCount: number;
  paidAmount: number; // €
  outstandingAmount: number; // €
  invitesSent: number;
  invitesTotal: number;
  capacity: number; // summed seats across the round's series
  openSpots: number; // capacity − rebooked (floored at 0)
  /** false ⇒ this round's stats failed to load; the row still shows name/date/status with metrics zeroed. */
  statsLoaded: boolean;
  cycleIds: string[];
}

/** Pure: fold a round + its aggregated status into one overview row. */
export function toRebookRoundOverviewRow(round: RebookRound, data: RebookManageData): RebookRoundOverviewRow {
  const capacity = data.groups.reduce((sum, g) => sum + (g.capacity || 0), 0);
  return {
    id: round.id,
    name: round.name,
    startDate: round.startDate,
    status: round.status,
    archived: round.archived,
    seriesCount: round.cycleIds.length,
    invited: data.summary.invited,
    rebooked: data.summary.rebooked,
    noResponse: data.summary.noResponse,
    declined: data.summary.declined,
    clickedYesUnpaid: data.summary.clickedYesUnpaid,
    paidCount: data.paidCount,
    paidAmount: data.paidAmount,
    outstandingAmount: data.outstandingAmount,
    invitesSent: data.invitesSent,
    invitesTotal: data.invitesTotal,
    capacity,
    openSpots: Math.max(0, capacity - data.summary.rebooked),
    statsLoaded: true,
    cycleIds: round.cycleIds,
  };
}

/** A round whose stats couldn't load still lists (identity known), metrics zeroed + statsLoaded=false. */
function zeroRow(round: RebookRound): RebookRoundOverviewRow {
  return {
    id: round.id,
    name: round.name,
    startDate: round.startDate,
    status: round.status,
    archived: round.archived,
    seriesCount: round.cycleIds.length,
    invited: 0,
    rebooked: 0,
    noResponse: 0,
    declined: 0,
    clickedYesUnpaid: 0,
    paidCount: 0,
    paidAmount: 0,
    outstandingAmount: 0,
    invitesSent: 0,
    invitesTotal: 0,
    capacity: 0,
    openSpots: 0,
    statsLoaded: false,
    cycleIds: round.cycleIds,
  };
}

/**
 * One overview row per rebooking round, with the same aggregates the per-round manage view shows
 * (fanned out via getCycleRebookStatus so the numbers match exactly). A round whose stats fail to load
 * still appears (name/date/status), metrics zeroed + statsLoaded=false.
 *
 * Cost: one getCycleRebookStatus per round (each reads that round's slots/claims/invoices). Fine for
 * the handful of rounds an academy runs; a batched RPC is the future optimization if that ever grows.
 */
export async function listRebookRoundOverview(
  academyProfileId: string,
  opts?: { includeArchived?: boolean },
): Promise<RebookRoundOverviewRow[]> {
  const rounds = await listRebookRounds(academyProfileId, opts);
  return Promise.all(
    rounds.map(async (round) => {
      try {
        return toRebookRoundOverviewRow(round, await getCycleRebookStatus(round.id));
      } catch (e) {
        logger.error('Failed to load rebook round stats', e as Error, {
          component: 'rebookRoundsOverview',
          roundId: round.id,
        });
        return zeroRow(round);
      }
    }),
  );
}
