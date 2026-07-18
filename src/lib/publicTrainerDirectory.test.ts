import { describe, it, expect, vi } from 'vitest';
import { searchPublicTrainers } from './publicTrainerDirectory';

// Codex P3: a public SEO page is fed straight from the URL — malformed deep
// links must degrade to "no filter", not surface a Postgres cast/type error.
describe('searchPublicTrainers — URL param hardening', () => {
  const rpcMock = (data: unknown = []) => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    return { rpc } as unknown as { rpc: typeof rpc };
  };

  it('passes a well-formed UUID locationId straight through', async () => {
    const client = rpcMock();
    await searchPublicTrainers({ locationId: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' }, client);
    expect(client.rpc).toHaveBeenCalledWith('search_public_trainers',
      expect.objectContaining({ p_location_id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde' }));
  });

  it('drops a malformed locationId (not a valid UUID) instead of sending it', async () => {
    const client = rpcMock();
    await searchPublicTrainers({ locationId: 'not-a-uuid; DROP TABLE x' }, client);
    expect(client.rpc).toHaveBeenCalledWith('search_public_trainers',
      expect.objectContaining({ p_location_id: null }));
  });

  it("treats the sentinel 'all' the same as no location filter", async () => {
    const client = rpcMock();
    await searchPublicTrainers({ locationId: 'all' }, client);
    expect(client.rpc).toHaveBeenCalledWith('search_public_trainers',
      expect.objectContaining({ p_location_id: null }));
  });

  it('defaults NaN/negative/garbage numeric filters instead of forwarding them', async () => {
    const client = rpcMock();
    await searchPublicTrainers({
      minRating: NaN, minExperience: -5, minTrainerRating: Infinity, page: -3,
    }, client);
    expect(client.rpc).toHaveBeenCalledWith('search_public_trainers', expect.objectContaining({
      p_min_rating: 0, p_min_experience: 0, p_min_trainer_rating: 0, p_page: 1,
    }));
  });

  it('truncates a fractional page to a whole number >= 1', async () => {
    const client = rpcMock();
    await searchPublicTrainers({ page: 2.9 }, client);
    expect(client.rpc).toHaveBeenCalledWith('search_public_trainers',
      expect.objectContaining({ p_page: 2 }));
  });

  it('coerces an unrecognized sort value to the default (never forwards raw input)', async () => {
    const client = rpcMock();
    await searchPublicTrainers({ sort: 'DROP TABLE x' as never }, client);
    expect(client.rpc).toHaveBeenCalledWith('search_public_trainers',
      expect.objectContaining({ p_sort: 'rating' }));
  });
});
