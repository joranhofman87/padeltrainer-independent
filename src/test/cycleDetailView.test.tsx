import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderWithCycles } from './renderWithCycles';
import type { CycleDetail } from '@/lib/cycleDetail';

const { mockUseCycleDetail, mockApplyDelete, mockSyncSplit, mockSyncPrice, mockUpdatePricing } = vi.hoisted(() => ({
  mockUseCycleDetail: vi.fn(),
  mockApplyDelete: vi.fn(),
  mockSyncSplit: vi.fn(() => Promise.resolve()),
  mockSyncPrice: vi.fn(() => Promise.resolve()),
  mockUpdatePricing: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/lib/cycleDetail', () => ({ useCycleDetail: () => mockUseCycleDetail() }));
vi.mock('@/lib/slotDeleteGuard', () => ({ applySlotDeleteToCycle: (...a: unknown[]) => mockApplyDelete(...a) }));
vi.mock('@/lib/invoiceSync', () => ({
  syncSplitCountForCycle: (...a: unknown[]) => mockSyncSplit(...a),
  syncInvoicesAfterPriceChange: (...a: unknown[]) => mockSyncPrice(...a),
}));
vi.mock('@/lib/cycles', () => ({ updateCyclePricing: (...a: unknown[]) => mockUpdatePricing(...a) }));
// The pricing card's preset picker fetches presets on mount — stub it so the modal renders cheaply.
vi.mock('@/components/settings/ExtraCostPresetPicker', () => ({ ExtraCostPresetPicker: () => null }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
const { CycleDetailView } = await import('@/components/cycles/CycleDetailView');

// Far-future dates so the slots are always in the whole-cycle delete scope (future-only), regardless
// of when the test runs.
const sampleDetail: CycleDetail = {
  cycle: {
    id: 'cy1',
    name: 'Zomercyclus',
    status: 'open',
    start_date: null,
    end_date: null,
    price_per_session: 25,
    settings: { extra_costs: [], split_payment: false, prices_include_vat: true },
    location: { id: 'l1', name: 'Court A', city: 'Amsterdam' },
  } as unknown as CycleDetail['cycle'],
  slots: [
    { id: 's1', start_time: '2099-07-06T18:00:00Z', end_time: '2099-07-06T19:00:00Z', trainer_id: 't1', max_participants: 4, is_public: true, cyclus_name: 'Zomercyclus', playerNames: ['Alice', 'Bob'], bookedCount: 2, paymentStatus: 'all_paid' },
    { id: 's2', start_time: '2099-07-13T18:00:00Z', end_time: '2099-07-13T19:00:00Z', trainer_id: 't1', max_participants: 4, is_public: true, cyclus_name: 'Zomercyclus', playerNames: [], bookedCount: 0, paymentStatus: 'no_players' },
  ],
  roster: [
    { name: 'Alice', sessionCount: 2 },
    { name: 'Bob', sessionCount: 1 },
  ],
  totalSlots: 2,
  totalPlayers: 2,
};

const loaded = { data: sampleDetail, isLoading: false, isError: false };

function renderView(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithCycles(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  mockUseCycleDetail.mockReset();
  mockApplyDelete.mockReset();
  mockSyncSplit.mockReset();
  mockSyncSplit.mockResolvedValue(undefined);
  mockSyncPrice.mockReset();
  mockSyncPrice.mockResolvedValue(undefined);
  mockUpdatePricing.mockReset();
  mockUpdatePricing.mockResolvedValue(undefined);
});

describe('CycleDetailView (Slice 9b/9c)', () => {
  it('renders header + sessions + roster (TZ-safe fields)', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Zomercyclus' })).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('2 players · 2 sessions')).toBeInTheDocument();
    expect(screen.getByText(/Court A/)).toBeInTheDocument();
    expect(screen.getAllByText('2/4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0/4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Alice, Bob').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
    expect(screen.getAllByText('No players').length).toBeGreaterThan(0);
    expect(screen.getByText('2×')).toBeInTheDocument();
    expect(screen.getByText('1×')).toBeInTheDocument();
  });

  it('is read-only by default — no Delete CTA without canEdit', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.queryByRole('button', { name: /Delete cycle/ })).not.toBeInTheDocument();
  });

  it('opens a single session on row click', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    const onOpenSlot = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={onOpenSlot} />);
    fireEvent.click(screen.getAllByText('Alice, Bob')[0]);
    expect(onOpenSlot).toHaveBeenCalledWith('s1');
  });

  it('delete cycle: confirm → applySlotDeleteToCycle(cycleId, future slot ids) + onMutated', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockApplyDelete.mockResolvedValue({ deletedCount: 1, protectedCount: 1, protectedSlotIds: ['s1'] });
    const onMutated = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit onMutated={onMutated} />);
    // CTA opens the confirm dialog
    fireEvent.click(screen.getByRole('button', { name: /Delete cycle/ }));
    // confirm (exact "Delete", not "Delete cycle")
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(mockApplyDelete).toHaveBeenCalledWith('cy1', ['s1', 's2']));
    // RPC stamps split_count but not line items → caller must resync (RPC contract).
    await waitFor(() => expect(mockSyncSplit).toHaveBeenCalledWith('cy1'));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it('delete cycle: skips the invoice resync when nothing was deleted', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockApplyDelete.mockResolvedValue({ deletedCount: 0, protectedCount: 2, protectedSlotIds: ['s1', 's2'] });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /Delete cycle/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(mockApplyDelete).toHaveBeenCalled());
    expect(mockSyncSplit).not.toHaveBeenCalled();
  });

  it('delete cycle: cancel does NOT call the RPC', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /Delete cycle/ }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(mockApplyDelete).not.toHaveBeenCalled();
  });

  it('edit price: CTA hidden unless canEditPrice', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    expect(screen.queryByRole('button', { name: /Edit price/ })).not.toBeInTheDocument();
  });

  it('edit price: opens modal → Save calls updateCyclePricing + resync + onMutated', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    const onMutated = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEditPrice onMutated={onMutated} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit price/ }));
    expect(screen.getByText('Edit cycle pricing')).toBeInTheDocument();
    expect(screen.getByDisplayValue('25')).toBeInTheDocument(); // seeded price_per_session
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(mockUpdatePricing).toHaveBeenCalledWith('cy1', {
        price_per_session: 25,
        extra_costs: [],
        split_payment: false,
        prices_include_vat: true,
      }),
    );
    await waitFor(() => expect(mockSyncPrice).toHaveBeenCalledWith(['s1', 's2']));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it('loading → no cycle content yet', () => {
    mockUseCycleDetail.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.queryByText('Zomercyclus')).not.toBeInTheDocument();
  });

  it('not-found when there is no cycle and no slots', () => {
    mockUseCycleDetail.mockReturnValue({
      data: { cycle: null, slots: [], roster: [], totalSlots: 0, totalPlayers: 0 },
      isLoading: false,
      isError: false,
    });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.getByText('Cycle not found')).toBeInTheDocument();
  });

  it('error state surfaces the load error', () => {
    mockUseCycleDetail.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
  });
});
