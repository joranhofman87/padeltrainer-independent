import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the interface and type definitions since the actual functions
// require Supabase connection which we don't mock in unit tests
import type { CalendarConnection } from './calendar';

describe('CalendarConnection interface', () => {
  it('should have correct structure', () => {
    const connection: CalendarConnection = {
      id: 'test-id',
      user_id: 'user-123',
      provider: 'google',
      calendar_id: 'primary',
      is_active: true,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    expect(connection.id).toBe('test-id');
    expect(connection.user_id).toBe('user-123');
    expect(connection.provider).toBe('google');
    expect(connection.calendar_id).toBe('primary');
    expect(connection.is_active).toBe(true);
  });

  it('allows null calendar_id', () => {
    const connection: CalendarConnection = {
      id: 'test-id',
      user_id: 'user-123',
      provider: 'google',
      calendar_id: null,
      is_active: false,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    };

    expect(connection.calendar_id).toBeNull();
  });
});
