import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// P2-14: after a cycle price/roster/end-date mutation the wrapper's onMutated must invalidate the
// role's invoice-list query keys AND all player data — otherwise the academy/trainer invoices and
// player caches show stale money for up to the global 60s staleTime.

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/components/academy/AcademyLayout', () => ({
  useAcademyContext: () => ({ activeAcademy: { id: 'ac1' } }),
}));
vi.mock('@/lib/academy', () => ({
  getAcademyTrainersWithProfiles: () => Promise.resolve([]),
  getAcademyLocations: () => Promise.resolve([]),
}));
vi.mock('@/lib/cycleDetail', () => ({ useCycleDetail: () => ({ data: { cycle: { type: 'cyclus' } } }) }));

// Trainer wrapper reads its trainer_profiles id from supabase; return a fixed id.
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'trainer_profiles') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'tp1' } }) }) }) };
      }
      // availability_slots / locations lookups → empty so the location effect no-ops.
      return {
        select: () => ({
          eq: () => ({ not: () => Promise.resolve({ data: [] }) }),
          in: () => Promise.resolve({ data: [] }),
        }),
      };
    },
  },
}));

// Capture the onMutated prop the wrapper hands to the shared view so we can fire it directly.
let capturedOnMutated: (() => void) | undefined;
vi.mock('@/components/cycles/CycleDetailView', () => ({
  CycleDetailView: (props: { onMutated?: () => void }) => {
    capturedOnMutated = props.onMutated;
    return <div data-testid="cycle-detail-view" />;
  },
}));

const AcademyCycleDetailView = (await import('@/pages/academy/AcademyCycleDetailView')).default;
const TrainerCycleDetailView = (await import('@/pages/trainer/TrainerCycleDetailView')).default;

function invalidatedKeys(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey);
}

beforeEach(() => {
  capturedOnMutated = undefined;
});

describe('CycleDetailView wrappers wire onMutated to invoice + player invalidation (P2-14)', () => {
  it('academy onMutated invalidates academy-invoices AND all academy player data', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/app/academy/cycles/cy1']}>
          <Routes>
            <Route path="/app/academy/cycles/:cycleId" element={<AcademyCycleDetailView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(capturedOnMutated).toBeTypeOf('function');
    capturedOnMutated!();
    const keys = invalidatedKeys(spy);
    expect(keys).toContainEqual(['academy-invoices']);
    // invalidateAllPlayerData(qc, { kind: 'academy', id: 'ac1' }) → ['players', 'academy', 'ac1']
    expect(keys).toContainEqual(['players', 'academy', 'ac1']);
  });

  it('trainer onMutated invalidates trainer-invoices AND all trainer player data', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/app/trainer/cycles/cy1']}>
          <Routes>
            <Route path="/app/trainer/cycles/:cycleId" element={<TrainerCycleDetailView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Let the trainer_profiles fetch resolve so trainerId is set before firing onMutated.
    await vi.waitFor(() => expect(capturedOnMutated).toBeTypeOf('function'));
    await vi.waitFor(() => {
      capturedOnMutated!();
      const keys = invalidatedKeys(spy);
      expect(keys).toContainEqual(['trainer-invoices']);
      expect(keys).toContainEqual(['players', 'trainer', 'tp1']);
    });
  });
});
