import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }) },
}));
const mockUseCycleDetail = vi.fn();
vi.mock('@/lib/cycleDetail', () => ({ useCycleDetail: () => mockUseCycleDetail() }));
vi.mock('@/components/cycles/CycleDetailView', () => ({
  CycleDetailView: ({ cycleId }: { cycleId: string }) => <div data-testid="cycle-detail-view">{cycleId}</div>,
}));
const TrainerCycleDetailView = (await import('@/pages/trainer/TrainerCycleDetailView')).default;

function renderAt(type: string | undefined) {
  mockUseCycleDetail.mockReturnValue({ data: type === undefined ? undefined : { cycle: { type } } });
  return render(
    <MemoryRouter initialEntries={['/app/trainer/cycles/cy1']}>
      <Routes>
        <Route path="/app/trainer/cycles/:cycleId" element={<TrainerCycleDetailView />} />
        <Route path="/app/trainer/cycles" element={<div data-testid="cycles-list" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => mockUseCycleDetail.mockReset());

describe('TrainerCycleDetailView routing (Slice 9d)', () => {
  it('a training cyclus renders the cycle-detail view', () => {
    renderAt('cyclus');
    expect(screen.getByTestId('cycle-detail-view')).toHaveTextContent('cy1');
  });

  it('a registration/event cycle redirects to the trainer cycles list', () => {
    renderAt('registration');
    expect(screen.getByTestId('cycles-list')).toBeInTheDocument();
    expect(screen.queryByTestId('cycle-detail-view')).not.toBeInTheDocument();
  });
});
