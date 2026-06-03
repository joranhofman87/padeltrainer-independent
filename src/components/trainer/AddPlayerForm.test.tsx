import { describe, it, expect } from 'vitest';
import { buildAddPlayerInsertPayload } from './AddPlayerForm';

describe('buildAddPlayerInsertPayload', () => {
  it('includes first_name, last_name, and full_name', () => {
    const payload = buildAddPlayerInsertPayload({
      firstName: 'Jane',
      lastName: 'Player',
      trainerId: 'trainer-1',
      email: 'jane@test.com',
    });

    expect(payload.first_name).toBe('Jane');
    expect(payload.last_name).toBe('Player');
    expect(payload.full_name).toBe('Jane Player');
    expect(payload.trainer_id).toBe('trainer-1');
    expect(payload.email).toBe('jane@test.com');
  });

  it('supports academy scope and first name only', () => {
    const payload = buildAddPlayerInsertPayload({
      firstName: 'Madonna',
      lastName: '',
      academyId: 'academy-1',
    });

    expect(payload.academy_profile_id).toBe('academy-1');
    expect(payload.first_name).toBe('Madonna');
    expect(payload.last_name).toBeNull();
    expect(payload.full_name).toBe('Madonna');
  });
});
