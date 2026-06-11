import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { supabase } from '@/lib/supabaseClient';
import { getCitiesWithTrainers, getPopularCities, getAllCitySlugs } from './cities';

function mockFrom(table: string) {
  const chain: any = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  return chain;
}

describe('getCitiesWithTrainers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array on locations error', async () => {
    const chain: any = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockResolvedValue({ data: null, error: { message: 'fail' } });
    (supabase.from as any).mockReturnValue(chain);

    const result = await getCitiesWithTrainers();
    expect(result).toEqual([]);
  });

  it('aggregates cities correctly', async () => {
    const locChain: any = {};
    locChain.select = vi.fn().mockReturnValue(locChain);
    locChain.eq = vi.fn().mockResolvedValue({
      data: [
        { id: 'loc1', city: 'Amsterdam' },
        { id: 'loc2', city: 'Amsterdam' },
        { id: 'loc3', city: 'Rotterdam' },
      ],
      error: null,
    });

    const tlChain: any = {};
    tlChain.select = vi.fn().mockResolvedValue({
      data: [
        { location_id: 'loc1' },
        { location_id: 'loc1' },
        { location_id: 'loc2' },
        { location_id: 'loc3' },
      ],
      error: null,
    });

    const callCount = 0;
    (supabase.from as any).mockImplementation((table: string) => {
      if (table === 'locations') return locChain;
      if (table === 'trainer_locations') return tlChain;
      return locChain;
    });

    const result = await getCitiesWithTrainers();
    expect(result).toHaveLength(2);

    const amsterdam = result.find(c => c.city === 'Amsterdam');
    expect(amsterdam).toBeDefined();
    expect(amsterdam!.slug).toBe('amsterdam');
    expect(amsterdam!.trainerCount).toBe(3);
    expect(amsterdam!.locationCount).toBe(2);

    const rotterdam = result.find(c => c.city === 'Rotterdam');
    expect(rotterdam!.trainerCount).toBe(1);
    expect(rotterdam!.locationCount).toBe(1);
  });

  it('sorts by trainerCount descending', async () => {
    const locChain: any = {};
    locChain.select = vi.fn().mockReturnValue(locChain);
    locChain.eq = vi.fn().mockResolvedValue({
      data: [
        { id: 'loc1', city: 'Small City' },
        { id: 'loc2', city: 'Big City' },
      ],
      error: null,
    });

    const tlChain: any = {};
    tlChain.select = vi.fn().mockResolvedValue({
      data: [
        { location_id: 'loc2' },
        { location_id: 'loc2' },
        { location_id: 'loc2' },
        { location_id: 'loc1' },
      ],
      error: null,
    });

    (supabase.from as any).mockImplementation((table: string) => {
      if (table === 'locations') return locChain;
      if (table === 'trainer_locations') return tlChain;
      return locChain;
    });

    const result = await getCitiesWithTrainers();
    expect(result[0].city).toBe('Big City');
    expect(result[1].city).toBe('Small City');
  });

  it('generates correct slugs with spaces', async () => {
    const locChain: any = {};
    locChain.select = vi.fn().mockReturnValue(locChain);
    locChain.eq = vi.fn().mockResolvedValue({
      data: [{ id: 'loc1', city: 'Den Haag' }],
      error: null,
    });

    const tlChain: any = {};
    tlChain.select = vi.fn().mockResolvedValue({
      data: [{ location_id: 'loc1' }],
      error: null,
    });

    (supabase.from as any).mockImplementation((table: string) => {
      if (table === 'locations') return locChain;
      if (table === 'trainer_locations') return tlChain;
      return locChain;
    });

    const result = await getCitiesWithTrainers();
    expect(result[0].slug).toBe('den-haag');
  });
});

describe('getPopularCities', () => {
  beforeEach(() => vi.clearAllMocks());

  it('limits results', async () => {
    const locChain: any = {};
    locChain.select = vi.fn().mockReturnValue(locChain);
    locChain.eq = vi.fn().mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => ({ id: `loc${i}`, city: `City${i}` })),
      error: null,
    });

    const tlChain: any = {};
    tlChain.select = vi.fn().mockResolvedValue({
      data: Array.from({ length: 20 }, (_, i) => ({ location_id: `loc${i}` })),
      error: null,
    });

    (supabase.from as any).mockImplementation((table: string) => {
      if (table === 'locations') return locChain;
      if (table === 'trainer_locations') return tlChain;
      return locChain;
    });

    const result = await getPopularCities(5);
    expect(result).toHaveLength(5);
  });
});

describe('getAllCitySlugs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns unique slugs', async () => {
    const chain: any = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockResolvedValue({
      data: [
        { city: 'Amsterdam' },
        { city: 'Amsterdam' },
        { city: 'Rotterdam' },
      ],
      error: null,
    });

    (supabase.from as any).mockReturnValue(chain);

    const result = await getAllCitySlugs();
    expect(result).toEqual(['amsterdam', 'rotterdam']);
  });
});
