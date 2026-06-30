import { describe, it, expect, vi } from 'vitest';
import { publishCycles } from './cycleWrites';

describe('publishCycles', () => {
  it('publishes every cyclus with the shared makePublic flag and counts successes', async () => {
    const publishOne = vi.fn().mockResolvedValue(undefined);
    const res = await publishCycles(['a', 'b', 'c'], true, undefined, publishOne);
    expect(res).toEqual({ published: 3, failed: 0 });
    expect(publishOne).toHaveBeenCalledTimes(3);
    expect(publishOne).toHaveBeenNthCalledWith(1, 'a', true, expect.anything());
  });

  it('is resilient — one cyclus failing does not abort the rest', async () => {
    const publishOne = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const res = await publishCycles(['a', 'b', 'c'], false, undefined, publishOne);
    expect(res).toEqual({ published: 2, failed: 1 });
    expect(publishOne).toHaveBeenCalledTimes(3);
  });

  it('returns zeros for an empty list (no-op)', async () => {
    const publishOne = vi.fn();
    expect(await publishCycles([], true, undefined, publishOne)).toEqual({ published: 0, failed: 0 });
    expect(publishOne).not.toHaveBeenCalled();
  });
});
