import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithCycles } from './renderWithCycles';
import type { CycleDetail } from '@/lib/cycleDetail';

const { mockUseCycleDetail } = vi.hoisted(() => ({ mockUseCycleDetail: vi.fn() }));
vi.mock('@/lib/cycleDetail', () => ({ useCycleDetail: () => mockUseCycleDetail() }));
const { CycleDetailView } = await import('@/components/cycles/CycleDetailView');

const sampleDetail: CycleDetail = {
  cycle: {
    id: 'cy1',
    name: 'Zomercyclus',
    status: 'open',
    start_date: null,
    end_date: null,
    location: { id: 'l1', name: 'Court A', city: 'Amsterdam' },
  } as unknown as CycleDetail['cycle'],
  slots: [
    { id: 's1', start_time: '2026-07-06T18:00:00Z', end_time: '2026-07-06T19:00:00Z', trainer_id: 't1', max_participants: 4, is_public: true, cyclus_name: 'Zomercyclus', playerNames: ['Alice', 'Bob'], bookedCount: 2, paymentStatus: 'all_paid' },
    { id: 's2', start_time: '2026-07-13T18:00:00Z', end_time: '2026-07-13T19:00:00Z', trainer_id: 't1', max_participants: 4, is_public: true, cyclus_name: 'Zomercyclus', playerNames: [], bookedCount: 0, paymentStatus: 'no_players' },
  ],
  roster: [
    { name: 'Alice', sessionCount: 2 },
    { name: 'Bob', sessionCount: 1 },
  ],
  totalSlots: 2,
  totalPlayers: 2,
};

const loaded = { data: sampleDetail, isLoading: false, isError: false };
beforeEach(() => mockUseCycleDetail.mockReset());

describe('CycleDetailView (Slice 9b)', () => {
  it('renders header + sessions + roster (TZ-safe fields)', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderWithCycles(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    // Header
    expect(screen.getByRole('heading', { name: 'Zomercyclus' })).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument(); // status badge (status.open)
    expect(screen.getByText('2 players · 2 sessions')).toBeInTheDocument();
    expect(screen.getByText(/Court A/)).toBeInTheDocument();
    // Sessions (desktop + mobile both in DOM → use *AllBy*)
    expect(screen.getAllByText('2/4').length).toBeGreaterThan(0); // occupied
    expect(screen.getAllByText('0/4').length).toBeGreaterThan(0); // empty session
    expect(screen.getAllByText('Alice, Bob').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0); // all_paid badge
    expect(screen.getAllByText('No players').length).toBeGreaterThan(0); // s2
    // Roster: per-player session count badges
    expect(screen.getByText('2×')).toBeInTheDocument();
    expect(screen.getByText('1×')).toBeInTheDocument();
  });

  it('is read-only by default — no cycle-scope CTAs when no handlers passed', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderWithCycles(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.queryByRole('button', { name: /Edit whole cycle/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete cycle/ })).not.toBeInTheDocument();
  });

  it('renders + wires the cycle-scope CTAs when handlers are provided', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    const onEditWholeCycle = vi.fn();
    const onEditPrice = vi.fn();
    const onDeleteCycle = vi.fn();
    renderWithCycles(
      <CycleDetailView cycleId="cy1" onOpenSlot={() => {}} onEditWholeCycle={onEditWholeCycle} onEditPrice={onEditPrice} onDeleteCycle={onDeleteCycle} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit whole cycle/ }));
    fireEvent.click(screen.getByRole('button', { name: /Edit price/ }));
    fireEvent.click(screen.getByRole('button', { name: /Delete cycle/ }));
    expect(onEditWholeCycle).toHaveBeenCalledOnce();
    expect(onEditPrice).toHaveBeenCalledOnce();
    expect(onDeleteCycle).toHaveBeenCalledOnce();
  });

  it('opens a single session on row click', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    const onOpenSlot = vi.fn();
    renderWithCycles(<CycleDetailView cycleId="cy1" onOpenSlot={onOpenSlot} />);
    fireEvent.click(screen.getAllByText('Alice, Bob')[0]); // first occurrence = desktop row
    expect(onOpenSlot).toHaveBeenCalledWith('s1');
  });

  it('loading → no cycle content yet', () => {
    mockUseCycleDetail.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderWithCycles(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.queryByText('Zomercyclus')).not.toBeInTheDocument();
  });

  it('not-found when there is no cycle and no slots', () => {
    mockUseCycleDetail.mockReturnValue({
      data: { cycle: null, slots: [], roster: [], totalSlots: 0, totalPlayers: 0 },
      isLoading: false,
      isError: false,
    });
    renderWithCycles(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.getByText('Cycle not found')).toBeInTheDocument();
  });

  it('error state surfaces the load error', () => {
    mockUseCycleDetail.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderWithCycles(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
  });
});
