import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The academy wrapper supplies role props + redirects a registration/event cycle to its workflow.
vi.mock('@/components/academy/AcademyLayout', () => ({ useAcademyContext: () => ({ activeAcademy: { id: 'ac1' } }) }));
vi.mock('@/lib/academy', () => ({
  getAcademyTrainersWithProfiles: () => Promise.resolve([]),
  getAcademyLocations: () => Promise.resolve([]),
}));
const mockUseCycleDetail = vi.fn();
vi.mock('@/lib/cycleDetail', () => ({ useCycleDetail: () => mockUseCycleDetail() }));
vi.mock('@/components/cycles/CycleDetailView', () => ({
  CycleDetailView: ({ cycleId }: { cycleId: string }) => <div data-testid="cycle-detail-view">{cycleId}</div>,
}));
const AcademyCycleDetailView = (await import('@/pages/academy/AcademyCycleDetailView')).default;

function renderAt(type: string | undefined) {
  mockUseCycleDetail.mockReturnValue({ data: type === undefined ? undefined : { cycle: { type } } });
  return render(
    <MemoryRouter initialEntries={['/app/academy/cycles/cy1']}>
      <Routes>
        <Route path="/app/academy/cycles/:cycleId" element={<AcademyCycleDetailView />} />
        <Route path="/app/academy/registrations/:cycleId" element={<div data-testid="reg-workflow" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => mockUseCycleDetail.mockReset());

describe('AcademyCycleDetailView routing (Slice 9d)', () => {
  it('a training cyclus renders the cycle-detail view', () => {
    renderAt('cyclus');
    expect(screen.getByTestId('cycle-detail-view')).toHaveTextContent('cy1');
    expect(screen.queryByTestId('reg-workflow')).not.toBeInTheDocument();
  });

  it('a registration cycle redirects to the registration workflow', () => {
    renderAt('registration');
    expect(screen.getByTestId('reg-workflow')).toBeInTheDocument();
    expect(screen.queryByTestId('cycle-detail-view')).not.toBeInTheDocument();
  });

  it('an event cycle redirects to the registration workflow', () => {
    renderAt('event');
    expect(screen.getByTestId('reg-workflow')).toBeInTheDocument();
  });

  it('while the cycle is still loading, it renders the view (no premature redirect)', () => {
    renderAt(undefined);
    expect(screen.getByTestId('cycle-detail-view')).toBeInTheDocument();
  });
});
