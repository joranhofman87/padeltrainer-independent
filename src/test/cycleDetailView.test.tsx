import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { format } from 'date-fns';
import type { ReactElement } from 'react';
import { renderWithCycles } from './renderWithCycles';
import { supabaseMock, setMockData } from './fixtures/supabaseMock';
import type { CycleDetail } from '@/lib/cycleDetail';
import type { SlotEditFormSlot, SlotEditFormValues } from '@/components/slots/SlotEditForm';

const {
  mockUseCycleDetail,
  mockApplyDelete,
  mockSyncSplit,
  mockSyncPrice,
  mockUpdatePricing,
  mockApplyEdit,
  editOverride,
  mockToast,
} = vi.hoisted(() => ({
  mockUseCycleDetail: vi.fn(),
  mockApplyDelete: vi.fn(),
  mockSyncSplit: vi.fn(() => Promise.resolve()),
  mockSyncPrice: vi.fn(() => Promise.resolve()),
  mockUpdatePricing: vi.fn(() => Promise.resolve()),
  mockApplyEdit: vi.fn(),
  editOverride: { current: {} as Partial<SlotEditFormValues> },
  mockToast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
vi.mock('@/lib/cycleDetail', () => ({ useCycleDetail: () => mockUseCycleDetail() }));
vi.mock('@/lib/slotDeleteGuard', () => ({ applySlotDeleteToCycle: (...a: unknown[]) => mockApplyDelete(...a) }));
vi.mock('@/lib/invoiceSync', () => ({
  syncSplitCountForCycle: (...a: unknown[]) => mockSyncSplit(...a),
  syncInvoicesAfterPriceChange: (...a: unknown[]) => mockSyncPrice(...a),
}));
vi.mock('@/lib/cycles', () => ({
  updateCyclePricing: (...a: unknown[]) => mockUpdatePricing(...a),
  applySlotEditToCycle: (...a: unknown[]) => mockApplyEdit(...a),
}));
// Derive a full SlotEditFormValues from a slot exactly like SlotEditForm's init, so the stub emits
// the rep slot's baseline + the test's override → the component's buildCycleEditPatch is deterministic.
function formValuesFromSlot(slot: SlotEditFormSlot, over: Partial<SlotEditFormValues> = {}): SlotEditFormValues {
  const start = new Date(slot.start_time);
  const end = new Date(slot.end_time);
  return {
    date: format(start, 'yyyy-MM-dd'),
    startTime: format(start, 'HH:mm'),
    duration: Math.round((end.getTime() - start.getTime()) / 60000),
    trainerId: slot.trainer_id,
    locationId: slot.location_id || 'none',
    maxParticipants: slot.max_participants,
    ratingSystem: slot.rating_system,
    minRating: slot.min_rating,
    maxRating: slot.max_rating,
    cyclusName: slot.cyclus_name || '',
    isMarkedFull: !slot.is_public,
    pricePerSession: '',
    totalPrice: '',
    splitPayment: false,
    pricesIncludeVat: true,
    extraCosts: [],
    ...over,
  };
}
// Stub the (large) shared edit form: stub-save emits baseline + override.
vi.mock('@/components/slots/SlotEditForm', () => ({
  SlotEditForm: ({
    slot,
    onSubmit,
    onCancel,
  }: {
    slot: SlotEditFormSlot;
    onSubmit: (v: SlotEditFormValues, applyToCyclus: boolean) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="slot-edit-form">
      <button onClick={() => onSubmit(formValuesFromSlot(slot, editOverride.current), true)}>stub-save</button>
      <button onClick={onCancel}>stub-cancel</button>
    </div>
  ),
}));
// The pricing card's preset picker fetches presets on mount — stub it so the modal renders cheaply.
vi.mock('@/components/settings/ExtraCostPresetPicker', () => ({ ExtraCostPresetPicker: () => null }));
vi.mock('sonner', () => ({ toast: mockToast }));
const { CycleDetailView } = await import('@/components/cycles/CycleDetailView');

// The representative slot openEditModal fetches (a full availability_slots row).
const repSlotRow = {
  id: 's1',
  start_time: '2099-07-06T18:00:00Z',
  end_time: '2099-07-06T19:00:00Z',
  trainer_id: 't1',
  location_id: 'loc1',
  max_participants: 4,
  rating_system: 'knltb',
  min_rating: null,
  max_rating: null,
  cyclus_id: 'cy1',
  cyclus_name: 'Zomercyclus',
  is_public: true,
  price_per_session: 25,
  total_price: null,
  split_payment: false,
  prices_include_vat: true,
  extra_costs: [],
};

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
  mockApplyEdit.mockReset();
  editOverride.current = {};
  mockToast.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  setMockData({ availability_slots: [repSlotRow] });
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

  it('is read-only by default — no edit/delete CTAs without canEdit', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    expect(screen.queryByRole('button', { name: /Remove future sessions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit whole cycle/ })).not.toBeInTheDocument();
  });

  it('edit whole cycle: open → no change → toast nothing, RPC not called', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    editOverride.current = {};
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit locations={[{ id: 'loc1', name: 'Court A' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit whole cycle/ }));
    await screen.findByTestId('slot-edit-form'); // modal opened after the rep-slot fetch
    fireEvent.click(screen.getByText('stub-save'));
    await waitFor(() => expect(screen.queryByTestId('slot-edit-form')).not.toBeInTheDocument());
    expect(mockApplyEdit).not.toHaveBeenCalled(); // empty patch short-circuits
  });

  it('edit whole cycle: change capacity → applySlotEditToCycle(cycleId, future ids, diff) + onMutated', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockApplyEdit.mockResolvedValue({ updatedCount: 2, blockedCount: 0, blockedSlotIds: [] });
    editOverride.current = { maxParticipants: 6 };
    const onMutated = vi.fn();
    renderView(
      <CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit locations={[{ id: 'loc1', name: 'Court A' }]} onMutated={onMutated} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Edit whole cycle/ }));
    await screen.findByTestId('slot-edit-form');
    fireEvent.click(screen.getByText('stub-save'));
    await waitFor(() => expect(mockApplyEdit).toHaveBeenCalledWith('cy1', ['s1', 's2'], { maxParticipants: 6 }));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it('edit whole cycle: a fully-blocked capacity shrink surfaces as an error toast (nothing changed)', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockApplyEdit.mockResolvedValue({ updatedCount: 0, blockedCount: 2, blockedSlotIds: ['s1', 's2'] });
    editOverride.current = { maxParticipants: 1 };
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit locations={[{ id: 'loc1', name: 'Court A' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit whole cycle/ }));
    await screen.findByTestId('slot-edit-form');
    fireEvent.click(screen.getByText('stub-save'));
    await waitFor(() => expect(mockApplyEdit).toHaveBeenCalled());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('edit whole cycle: all-past cycle → guarded (no modal, no RPC)', () => {
    mockUseCycleDetail.mockReturnValue({
      data: {
        ...sampleDetail,
        slots: sampleDetail.slots.map((s) => ({ ...s, start_time: '2020-01-01T18:00:00Z', end_time: '2020-01-01T19:00:00Z' })),
      },
      isLoading: false,
      isError: false,
    });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit locations={[{ id: 'loc1', name: 'Court A' }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit whole cycle/ }));
    expect(screen.queryByTestId('slot-edit-form')).not.toBeInTheDocument();
    expect(mockApplyEdit).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('button', { name: /Remove future sessions/ }));
    // confirm (the AlertDialog "Delete" action)
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
    fireEvent.click(screen.getByRole('button', { name: /Remove future sessions/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(mockApplyDelete).toHaveBeenCalled());
    expect(mockSyncSplit).not.toHaveBeenCalled();
  });

  it('delete cycle: cancel does NOT call the RPC', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /Remove future sessions/ }));
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
