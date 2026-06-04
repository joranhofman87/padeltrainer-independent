import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchTrainerDisplayNamesByProfileIds } from './trainerDisplayNames';
import { logger } from '@/lib/logger';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function createClient(handlers: {
  trainerProfiles?: { data: { id: string; user_id: string; business_name: string | null }[] | null; error?: { message: string; code?: string } | null };
  profilesPublic?: { data: { user_id: string; full_name: string | null }[] | null };
  profiles?: { data: { user_id: string; full_name: string | null }[] | null };
}) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'trainer_profiles') {
        return {
          select: () => ({
            in: async () => handlers.trainerProfiles ?? { data: [], error: null },
          }),
        };
      }
      if (table === 'profiles_public') {
        return {
          select: () => ({
            in: async () => handlers.profilesPublic ?? { data: [], error: null },
          }),
        };
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            in: async () => handlers.profiles ?? { data: [], error: null },
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  } as never;
}

describe('fetchTrainerDisplayNamesByProfileIds', () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
  });

  it('returns empty map for empty ids without querying', async () => {
    const client = createClient({});
    const map = await fetchTrainerDisplayNamesByProfileIds([], client);
    expect(map.size).toBe(0);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('prefers business_name from trainer_profiles', async () => {
    const client = createClient({
      trainerProfiles: {
        data: [{ id: 'tp-1', user_id: 'user-1', business_name: 'RL Academy Coach' }],
      },
    });
    const map = await fetchTrainerDisplayNamesByProfileIds(['tp-1'], client);
    expect(map.get('tp-1')).toBe('RL Academy Coach');
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it('falls back to profiles_public full_name', async () => {
    const client = createClient({
      trainerProfiles: {
        data: [{ id: 'tp-2', user_id: 'user-2', business_name: null }],
      },
      profilesPublic: {
        data: [{ user_id: 'user-2', full_name: 'Sam Trainer' }],
      },
    });
    const map = await fetchTrainerDisplayNamesByProfileIds(['tp-2'], client);
    expect(map.get('tp-2')).toBe('Sam Trainer');
  });

  it('logs and returns partial map on trainer_profiles error', async () => {
    const client = createClient({
      trainerProfiles: { data: null, error: { message: 'fail', code: 'PGRST200' } },
    });
    const map = await fetchTrainerDisplayNamesByProfileIds(['tp-1'], client);
    expect(map.size).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
