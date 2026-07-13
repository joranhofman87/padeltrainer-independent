import { describe, it, expect } from 'vitest';
import { toRebookRoundOverviewRow } from './rebookRoundsOverview';
import type { RebookRound, RebookManageData, RebookManageGroup } from './rebookManage';

const round = (over: Partial<RebookRound> = {}): RebookRound => ({
  id: 'cyc-1',
  name: 'Winter 2026',
  startDate: '2026-01-06',
  status: 'open',
  archived: false,
  cycleIds: ['cyc-1', 'cyc-2', 'cyc-3'],
  ...over,
});

const group = (capacity: number, locationId: string | null = 'loc-1'): RebookManageGroup => ({
  groupId: `g-${capacity}`,
  weekday: 'woensdag',
  time: '19:00',
  trainerId: null,
  locationId,
  trainerName: null,
  locationName: null,
  slotIds: [],
  capacity,
  status: 'rebooked',
  players: [],
});

const data = (over: Partial<RebookManageData> = {}): RebookManageData => ({
  cycleName: 'Winter 2026',
  invitationMessage: '',
  reminderMessage: '',
  reminderSubject: '',
  groups: [group(4), group(4)],
  counts: { rebooked: 0, awaiting: 0, declined: 0, members: 0, public: 0 },
  summary: { invited: 51, rebooked: 38, declined: 4, noResponse: 9, clickedYesUnpaid: 2 },
  paidCount: 30,
  unpaidCount: 8,
  paidAmount: 1140,
  outstandingAmount: 360,
  invitesSent: 45,
  invitesTotal: 51,
  uninvitedCount: 6,
  cycleIds: ['cyc-1', 'cyc-2', 'cyc-3'],
  roundId: 'round-1',
  priorityDeadline: { deadline: null, varies: false, editableSlotCount: 0 },
  paymentMode: 'deferred_split',
  strictMollie: false,
  publicOpenMode: 'cyclus_only',
  publicOpenSplit: false,
  releasePolicy: 'auto',
  ...over,
});

describe('toRebookRoundOverviewRow', () => {
  it('folds round identity + status funnel + money + invites into one row', () => {
    const r = toRebookRoundOverviewRow(round(), data());
    expect(r).toMatchObject({
      id: 'cyc-1',
      name: 'Winter 2026',
      startDate: '2026-01-06',
      status: 'open',
      archived: false,
      seriesCount: 3, // cycleIds.length
      invited: 51,
      rebooked: 38,
      noResponse: 9,
      declined: 4,
      clickedYesUnpaid: 2,
      paidCount: 30,
      paidAmount: 1140,
      outstandingAmount: 360,
      invitesSent: 45,
      invitesTotal: 51,
      statsLoaded: true,
    });
  });

  it('maps the round deadline through from priorityDeadline (null when unknown)', () => {
    expect(toRebookRoundOverviewRow(round(), data()).deadline).toBeNull();
    const d = data({ priorityDeadline: { deadline: '2026-07-14T07:00:00Z', varies: false, editableSlotCount: 10 } });
    expect(toRebookRoundOverviewRow(round(), d).deadline).toBe('2026-07-14T07:00:00Z');
  });

  it('derives the distinct location ids of the round from its groups (dedup, nulls dropped)', () => {
    const d = data({ groups: [group(4, 'loc-1'), group(4, 'loc-1'), group(2, 'loc-2'), group(2, null)] });
    expect(toRebookRoundOverviewRow(round(), d).locationIds.sort()).toEqual(['loc-1', 'loc-2']);
  });

  it('capacity is the sum of the round series capacities; openSpots = capacity − rebooked', () => {
    const r = toRebookRoundOverviewRow(round(), data({ groups: [group(4), group(4), group(6)] }));
    expect(r.capacity).toBe(14);
    // rebooked 38 > capacity 14 in the default summary → floored at 0
    expect(r.openSpots).toBe(0);
  });

  it('openSpots reflects remaining seats when capacity exceeds rebooked', () => {
    const r = toRebookRoundOverviewRow(
      round(),
      data({ groups: [group(20)], summary: { invited: 12, rebooked: 8, declined: 1, noResponse: 3, clickedYesUnpaid: 0 } }),
    );
    expect(r.capacity).toBe(20);
    expect(r.openSpots).toBe(12);
  });

  it('a single-cycle legacy round has seriesCount 1 and carries a null start date through', () => {
    const r = toRebookRoundOverviewRow(round({ cycleIds: ['solo'], startDate: null }), data({ groups: [] }));
    expect(r.seriesCount).toBe(1);
    expect(r.startDate).toBeNull();
    expect(r.capacity).toBe(0);
    expect(r.openSpots).toBe(0);
  });
});
