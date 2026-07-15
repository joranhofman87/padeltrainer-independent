import { describe, it, expect, vi, beforeEach } from 'vitest';

const rpc = vi.fn();
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
}));

import { getShortUrl, registrationShortTargetPath, getShortCodesByTarget } from '@/lib/shortLinks';

describe('getShortUrl', () => {
  it('builds an absolute /s/<code> URL on the marketing domain', () => {
    expect(getShortUrl('aB3xK9q')).toBe('https://padeltrainer.ai/s/aB3xK9q');
  });
});

describe('registrationShortTargetPath', () => {
  it('is the slugless, rename-proof /nl/register/<id> target', () => {
    expect(registrationShortTargetPath('abc-123')).toBe('/nl/register/abc-123');
  });
});

describe('getShortCodesByTarget', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a target_id → code map on success', async () => {
    rpc.mockResolvedValue({
      data: [
        { target_id: 'r1', code: 'AAA1111' },
        { target_id: 'r2', code: 'BBB2222' },
      ],
      error: null,
    });
    const map = await getShortCodesByTarget('registration', ['r1', 'r2']);
    expect(map.get('r1')).toBe('AAA1111');
    expect(map.get('r2')).toBe('BBB2222');
  });

  it('short-circuits (no RPC call) for an empty id list', async () => {
    const map = await getShortCodesByTarget('registration', []);
    expect(map.size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('is RESILIENT: an RPC error returns an empty map (listing still renders)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const map = await getShortCodesByTarget('registration', ['r1']);
    expect(map.size).toBe(0);
  });

  it('is RESILIENT: a thrown/rejected RPC returns an empty map', async () => {
    rpc.mockRejectedValue(new Error('network down'));
    const map = await getShortCodesByTarget('registration', ['r1']);
    expect(map.size).toBe(0);
  });
});
