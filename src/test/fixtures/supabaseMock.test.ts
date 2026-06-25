import { describe, it, expect, beforeEach } from 'vitest';
import { supabaseMock, setMockData } from './supabaseMock';

describe('supabaseMock harness', () => {
  beforeEach(() =>
    setMockData(
      {
        slots: [
          { id: 'a', cyclus_id: 'c1', status: 'open' },
          { id: 'b', cyclus_id: 'c1', status: 'cancelled' },
          { id: 'c', cyclus_id: 'c2', status: 'open' },
        ],
      },
      { my_rpc: (args: { x: number }) => ({ data: args.x * 2, error: null }) },
    ),
  );

  it('applies eq + in filters on await', async () => {
    const { data } = await supabaseMock.from('slots').select('*').eq('cyclus_id', 'c1');
    expect((data as { id: string }[]).map((r) => r.id).sort()).toEqual(['a', 'b']);
    const { data: d2 } = await supabaseMock.from('slots').select('*').in('status', ['open']);
    expect((d2 as { id: string }[]).map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('maybeSingle / single return the first match or null', async () => {
    const { data } = await supabaseMock.from('slots').select('*').eq('id', 'c').maybeSingle();
    expect((data as { id: string }).id).toBe('c');
    const { data: none } = await supabaseMock.from('slots').select('*').eq('id', 'zzz').maybeSingle();
    expect(none).toBeNull();
  });

  it('rpc runs the configured handler', async () => {
    const { data } = await supabaseMock.rpc('my_rpc', { x: 21 });
    expect(data).toBe(42);
    const { data: unknown } = await supabaseMock.rpc('not_configured', {});
    expect(unknown).toBeNull();
  });
});
