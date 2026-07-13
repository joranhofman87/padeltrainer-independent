import { describe, it, expect } from 'vitest';
import { summariseRoundDeadline, computeWindowTargets, type DeadlineSlotRow } from './rebookRoundDeadline';

const T = (h: number) => new Date(Date.UTC(2026, 8, 1, h, 0, 0)).toISOString(); // 2026-09-01 hh:00Z

const slot = (over: Partial<DeadlineSlotRow>): DeadlineSlotRow => ({
  id: over.id ?? 's1',
  priority_window_ends_at: T(18),
  member_window_starts_at: T(18),
  member_window_ends_at: T(20),
  public_release_status: 'auto_release_scheduled',
  ...over,
});

describe('summariseRoundDeadline — the manage-header deadline', () => {
  it('uniform round → single deadline, no varies', () => {
    const s = summariseRoundDeadline([slot({ id: 'a' }), slot({ id: 'b' })]);
    expect(s).toEqual({ deadline: T(18), varies: false, editableSlotCount: 2 });
  });

  it('RELEASED slots are excluded from the headline and the editable count', () => {
    const s = summariseRoundDeadline([
      slot({ id: 'a' }),
      slot({ id: 'b', priority_window_ends_at: T(23), public_release_status: 'released' }),
    ]);
    expect(s.deadline).toBe(T(18)); // the released slot's later end does not win
    expect(s.varies).toBe(false);
    expect(s.editableSlotCount).toBe(1);
  });

  it('mixed non-released deadlines → the LATEST wins + varies flag', () => {
    const s = summariseRoundDeadline([slot({ id: 'a', priority_window_ends_at: T(12) }), slot({ id: 'b', priority_window_ends_at: T(18) })]);
    expect(s.deadline).toBe(T(18));
    expect(s.varies).toBe(true);
  });

  it('sub-minute jitter between slots does NOT read as varies', () => {
    const base = new Date(Date.UTC(2026, 8, 1, 18, 0, 5)).toISOString(); // +5s
    const s = summariseRoundDeadline([slot({ id: 'a' }), slot({ id: 'b', priority_window_ends_at: base })]);
    expect(s.varies).toBe(false);
  });

  it('all released (or no windows) → null deadline, 0 editable', () => {
    expect(summariseRoundDeadline([slot({ public_release_status: 'released' })])).toEqual({
      deadline: null, varies: false, editableSlotCount: 0,
    });
    expect(summariseRoundDeadline([])).toEqual({ deadline: null, varies: false, editableSlotCount: 0 });
  });
});

describe('computeWindowTargets — per-slot windows for a new deadline', () => {
  const NEW = T(23);

  it('preserves each slot\'s member DURATION and keeps member start = new priority end', () => {
    const [batch] = computeWindowTargets([slot({})], NEW); // member window was 2h
    expect(batch.patch.priority_window_ends_at).toBe(NEW);
    expect(batch.patch.member_window_starts_at).toBe(NEW);
    expect(batch.patch.member_window_ends_at).toBe(new Date(new Date(NEW).getTime() + 2 * 3600_000).toISOString());
  });

  it('slots without a member window keep it null', () => {
    const [batch] = computeWindowTargets([slot({ member_window_starts_at: null, member_window_ends_at: null })], NEW);
    expect(batch.patch.member_window_starts_at).toBeNull();
    expect(batch.patch.member_window_ends_at).toBeNull();
  });

  it('released slots are excluded entirely', () => {
    expect(computeWindowTargets([slot({ public_release_status: 'released' })], NEW)).toEqual([]);
  });

  it('a negative member duration (inconsistent data) clamps to 0, never before the priority end', () => {
    const [batch] = computeWindowTargets([slot({ member_window_ends_at: T(10) })], NEW); // member end BEFORE priority end
    expect(batch.patch.member_window_ends_at).toBe(NEW);
  });

  it('a uniform round collapses into ONE batch; distinct member durations split batches', () => {
    const uniform = computeWindowTargets([slot({ id: 'a' }), slot({ id: 'b' })], NEW);
    expect(uniform).toHaveLength(1);
    expect(uniform[0].ids.sort()).toEqual(['a', 'b']);

    const mixed = computeWindowTargets(
      [slot({ id: 'a' }), slot({ id: 'b', member_window_ends_at: T(22) })], // 2h vs 4h member window
      NEW,
    );
    expect(mixed).toHaveLength(2);
  });

  it('extend-after-lapse: a lapsed-but-unreleased slot (end-now / natural lapse) IS included', () => {
    const lapsed = slot({ priority_window_ends_at: T(1), member_window_starts_at: T(1), member_window_ends_at: T(3) });
    const [batch] = computeWindowTargets([lapsed], NEW);
    expect(batch.ids).toEqual(['s1']);
    expect(batch.patch.priority_window_ends_at).toBe(NEW);
    expect(batch.patch.member_window_ends_at).toBe(new Date(new Date(NEW).getTime() + 2 * 3600_000).toISOString());
  });
});
