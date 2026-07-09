import { describe, it, expect } from 'vitest';
import { toPriorityPerson } from './priorityPerson';

describe('toPriorityPerson', () => {
  it('maps a registered row → registered PriorityPerson (keyed on profile_id)', () => {
    expect(
      toPriorityPerson({ player_type: 'registered', profile_id: 'p1', guest_player_id: null, full_name: 'Alice', email: 'a@x.com' }),
    ).toEqual({ id: 'p1', player_type: 'registered', full_name: 'Alice', email: 'a@x.com' });
  });

  it('maps a GUEST row → guest PriorityPerson (keyed on guest_player_id) — this is what was missing', () => {
    expect(
      toPriorityPerson({ player_type: 'guest', profile_id: null, guest_player_id: 'g1', full_name: 'Bob', email: 'b@x.com' }),
    ).toEqual({ id: 'g1', player_type: 'guest', full_name: 'Bob', email: 'b@x.com' });
  });

  it('a linked guest (guest row that also carries a profile_id) is still a guest, keyed on guest id', () => {
    const p = toPriorityPerson({ player_type: 'guest', profile_id: 'linked-p', guest_player_id: 'g2', full_name: 'Cara', email: null });
    expect(p).toEqual({ id: 'g2', player_type: 'guest', full_name: 'Cara', email: null });
  });

  it('drops rows that cannot be granted priority', () => {
    expect(toPriorityPerson({ player_type: 'registered', profile_id: null, guest_player_id: null, full_name: 'X', email: null })).toBeNull();
    expect(toPriorityPerson({ player_type: 'guest', profile_id: null, guest_player_id: null, full_name: 'X', email: null })).toBeNull();
    expect(toPriorityPerson({ player_type: null, profile_id: 'p', guest_player_id: 'g', full_name: 'X', email: null })).toBeNull();
  });
});
