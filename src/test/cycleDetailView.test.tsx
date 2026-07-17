import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  mockCancelDelete,
  mockDeleteCycle,
  mockSyncSplit,
  mockSyncPrice,
  mockUpdatePricing,
  mockApplyEdit,
  mockApplyEndDate,
  editOverride,
  mockToast,
} = vi.hoisted(() => ({
  mockUseCycleDetail: vi.fn(),
  mockApplyDelete: vi.fn(),
  mockCancelDelete: vi.fn((..._a: unknown[]) => Promise.resolve({ deletedCount: 1, protectedCount: 0, protectedSlotIds: [], cancelledBookings: 0, syncError: null })),
  mockDeleteCycle: vi.fn((..._a: unknown[]) => Promise.resolve()),
  mockSyncSplit: vi.fn(() => Promise.resolve()),
  mockSyncPrice: vi.fn(() => Promise.resolve()),
  mockUpdatePricing: vi.fn(() => Promise.resolve()),
  mockApplyEdit: vi.fn(),
  mockApplyEndDate: vi.fn((..._a: unknown[]) => Promise.resolve({ added: 0, removed: 0 })),
  editOverride: { current: {} as Partial<SlotEditFormValues> },
  mockToast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/lib/supabaseClient', () => ({ supabase: supabaseMock }));
vi.mock('@/lib/cycleDetail', () => ({
  useCycleDetail: () => mockUseCycleDetail(),
  representativeSlotPrice: (slots: Array<{ price_per_session: number | null }>) =>
    slots?.find((s) => s.price_per_session != null)?.price_per_session ?? null,
}));
vi.mock('@/lib/slotDeleteGuard', () => ({
  applySlotDeleteToCycle: (...a: unknown[]) => mockApplyDelete(...a),
  cancelBookingsAndDeleteSlots: (...a: unknown[]) => mockCancelDelete(...a),
}));
vi.mock('@/lib/cycleWrites', () => ({ deleteCycle: (...a: unknown[]) => mockDeleteCycle(...a) }));
vi.mock('@/lib/invoiceSync', () => ({
  syncSplitCountForCycle: (...a: unknown[]) => mockSyncSplit(...a),
  syncInvoicesAfterPriceChange: (...a: unknown[]) => mockSyncPrice(...a),
}));
vi.mock('@/lib/cycleExtension', () => ({ applyCycleEndDate: (...a: unknown[]) => mockApplyEndDate(...a) }));
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
// CycleEndDateFields runs preview effects (findSlotsAfterDate / previewCycleExtension) that hit the
// network — stub it to a controlled date input that reports a fixed plan up.
vi.mock('@/components/cycles/CycleEndDateFields', () => ({
  CycleEndDateFields: ({
    value,
    onChange,
    onPlanChange,
  }: {
    value: string;
    onChange: (v: string) => void;
    onPlanChange: (p: { endDate: string; invalid: boolean; willAdd: number; removableIds: string[]; protectedCount: number; protectedIds: string[]; removeUnbooked: boolean; removeBooked: boolean }) => void;
  }) => (
    <input
      data-testid="end-date-input"
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        onPlanChange({ endDate: e.target.value, invalid: false, willAdd: 0, removableIds: [], protectedCount: 0, protectedIds: [], removeUnbooked: false, removeBooked: false });
      }}
    />
  ),
}));
// The pricing card's preset picker fetches presets on mount — stub it so the card renders cheaply.
vi.mock('@/components/settings/ExtraCostPresetPicker', () => ({ ExtraCostPresetPicker: () => null }));
vi.mock('sonner', () => ({ toast: mockToast }));
const { CycleDetailView } = await import('@/components/cycles/CycleDetailView');

// The representative slot the session-settings effect fetches (a full availability_slots row).
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
    { id: 's1', start_time: '2099-07-06T18:00:00Z', end_time: '2099-07-06T19:00:00Z', trainer_id: 't1', max_participants: 4, is_public: true, cyclus_name: 'Zomercyclus', price_per_session: 50, playerNames: ['Alice', 'Bob'], bookedCount: 2, paymentStatus: 'all_paid' },
    { id: 's2', start_time: '2099-07-13T18:00:00Z', end_time: '2099-07-13T19:00:00Z', trainer_id: 't1', max_participants: 4, is_public: true, cyclus_name: 'Zomercyclus', price_per_session: 50, playerNames: [], bookedCount: 0, paymentStatus: 'no_players' },
  ],
  roster: [
    { name: 'Alice', sessionCount: 2, playerId: 'p-alice', guestPlayerId: null, personId: 'p-alice', hasLogin: true, refs: [{ playerId: 'p-alice', guestPlayerId: null }] },
    { name: 'Bob', sessionCount: 1, playerId: null, guestPlayerId: 'g-bob', personId: 'g-bob', hasLogin: false, refs: [{ playerId: null, guestPlayerId: 'g-bob' }] },
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
  mockCancelDelete.mockReset();
  mockCancelDelete.mockResolvedValue({ deletedCount: 1, protectedCount: 0, protectedSlotIds: [], cancelledBookings: 0, syncError: null });
  mockDeleteCycle.mockReset();
  mockDeleteCycle.mockResolvedValue(undefined);
  mockSyncSplit.mockReset();
  mockSyncSplit.mockResolvedValue(undefined);
  mockSyncPrice.mockReset();
  mockSyncPrice.mockResolvedValue(undefined);
  mockUpdatePricing.mockReset();
  mockUpdatePricing.mockResolvedValue(undefined);
  mockApplyEdit.mockReset();
  mockApplyEndDate.mockReset();
  mockApplyEndDate.mockResolvedValue({ added: 0, removed: 0 });
  editOverride.current = {};
  mockToast.mockReset();
  mockToast.success.mockReset();
  mockToast.error.mockReset();
  setMockData({ availability_slots: [repSlotRow] });
});

describe('CycleDetailView (inline edit)', () => {
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

  it('roster Guest badge tells LOGINS, not seats: a merged (guest-keyed) human with a login gets NO badge', () => {
    // The exact owner-reported bug: Bram is a merged human whose PRIMARY ref is the guest side
    // (guestPlayerId set) but who HAS a login (hasLogin true) → must NOT wear the Guest badge;
    // an accountless guest still does.
    mockUseCycleDetail.mockReturnValue({
      data: {
        ...sampleDetail,
        roster: [
          { name: 'Bram', sessionCount: 1, playerId: null, guestPlayerId: 'g-bram', personId: 'per-bram', hasLogin: true, refs: [{ playerId: null, guestPlayerId: 'g-bram' }] },
          { name: 'Gast', sessionCount: 1, playerId: null, guestPlayerId: 'g-gast', personId: 'g-gast', hasLogin: false, refs: [{ playerId: null, guestPlayerId: 'g-gast' }] },
        ],
        totalPlayers: 2,
      },
      isLoading: false,
      isError: false,
    });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    // exactly ONE Guest badge in the whole roster (the accountless one)…
    expect(screen.getAllByText('Guest')).toHaveLength(1);
    // …and it belongs to Gast's row, not Bram's.
    const bramRow = screen.getByText('Bram').closest('button')!;
    const gastRow = screen.getByText('Gast').closest('button')!;
    expect(within(bramRow).queryByText('Guest')).not.toBeInTheDocument();
    expect(within(gastRow).getByText('Guest')).toBeInTheDocument();
  });

  it('is read-only by default — no inline edit cards / actions without canEdit or canEditPrice', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} />);
    // No session-settings, price, looptijd cards.
    expect(screen.queryByTestId('slot-edit-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('end-date-input')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit cycle pricing')).not.toBeInTheDocument();
    // No per-row edit/delete actions, no danger-zone delete.
    expect(screen.queryByRole('button', { name: 'Edit session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete entire cycle/ })).not.toBeInTheDocument();
  });

  it('opens a single session on row click', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    const onOpenSlot = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={onOpenSlot} />);
    fireEvent.click(screen.getAllByText('Alice, Bob')[0]);
    expect(onOpenSlot).toHaveBeenCalledWith('s1');
  });

  // --- Inline session-settings editor ---
  it('session settings: no change → toast nothing, RPC not called', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    editOverride.current = {};
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit locations={[{ id: 'loc1', name: 'Court A' }]} />);
    await screen.findByTestId('slot-edit-form'); // rep slot fetched on mount
    fireEvent.click(screen.getByText('stub-save'));
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    expect(mockApplyEdit).not.toHaveBeenCalled(); // empty patch short-circuits
  });

  it('session settings: change capacity → applySlotEditToCycle(cycleId, future ids, diff) + onMutated', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockApplyEdit.mockResolvedValue({ updatedCount: 2, blockedCount: 0, blockedSlotIds: [] });
    editOverride.current = { maxParticipants: 6 };
    const onMutated = vi.fn();
    renderView(
      <CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit locations={[{ id: 'loc1', name: 'Court A' }]} onMutated={onMutated} />,
    );
    await screen.findByTestId('slot-edit-form');
    fireEvent.click(screen.getByText('stub-save'));
    await waitFor(() => expect(mockApplyEdit).toHaveBeenCalledWith('cy1', ['s1', 's2'], { maxParticipants: 6 }));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it('session settings: a fully-blocked capacity shrink surfaces as an error toast', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockApplyEdit.mockResolvedValue({ updatedCount: 0, blockedCount: 2, blockedSlotIds: ['s1', 's2'] });
    editOverride.current = { maxParticipants: 1 };
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit locations={[{ id: 'loc1', name: 'Court A' }]} />);
    await screen.findByTestId('slot-edit-form');
    fireEvent.click(screen.getByText('stub-save'));
    await waitFor(() => expect(mockApplyEdit).toHaveBeenCalled());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('session settings: all-past cycle → shows the "no future" note, no form', () => {
    mockUseCycleDetail.mockReturnValue({
      data: {
        ...sampleDetail,
        slots: sampleDetail.slots.map((s) => ({ ...s, start_time: '2020-01-01T18:00:00Z', end_time: '2020-01-01T19:00:00Z' })),
      },
      isLoading: false,
      isError: false,
    });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit locations={[{ id: 'loc1', name: 'Court A' }]} />);
    expect(screen.queryByTestId('slot-edit-form')).not.toBeInTheDocument();
    expect(screen.getByText('No future sessions to edit')).toBeInTheDocument();
    expect(mockApplyEdit).not.toHaveBeenCalled();
  });

  // --- Inline price card ---
  it('price card: hidden unless canEditPrice', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    expect(screen.queryByText('Edit cycle pricing')).not.toBeInTheDocument();
  });

  it('price card: Save calls updateCyclePricing + resync + onMutated (always, ignoring toggle)', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    const onMutated = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEditPrice onMutated={onMutated} />);
    // Batch 2 (a): seeded from the SLOTS' actual price (50), NOT the drifted cycle row (25) — so
    // opening + saving the card can't push the stale cycle value back over the real slot prices.
    expect(screen.getByDisplayValue('50')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(mockUpdatePricing).toHaveBeenCalledWith('cy1', {
        price_per_session: 50,
        extra_costs: [],
        split_payment: false,
        prices_include_vat: true,
      }),
    );
    await waitFor(() => expect(mockSyncPrice).toHaveBeenCalledWith(['s1', 's2']));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  // --- Inline looptijd card ---
  it('looptijd card: Save calls applyCycleEndDate(cycleId, endDate, opts) + onMutated', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockApplyEndDate.mockResolvedValue({ added: 3, removed: 0 });
    const onMutated = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit onMutated={onMutated} />);
    const input = screen.getByTestId('end-date-input');
    fireEvent.change(input, { target: { value: '2099-08-31' } });
    // The looptijd Save lives in the same card as the date input.
    const card = input.closest('.space-y-4') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(mockApplyEndDate).toHaveBeenCalledWith('cy1', '2099-08-31', { removableIds: [], removeUnbooked: false, bookedIdsToRemove: undefined, skipInvoices: false }),
    );
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  // --- Per-session delete (cancel-then-delete via cancelBookingsAndDeleteSlots) ---
  it('per-session delete: confirm → cancelBookingsAndDeleteSlots(cycleId, [slotId], {skipInvoices:false}) + onMutated', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockCancelDelete.mockResolvedValue({ deletedCount: 1, protectedCount: 0, protectedSlotIds: [], cancelledBookings: 0, syncError: null });
    const onMutated = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit onMutated={onMutated} />);
    // First session row's Delete action.
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete session' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(mockCancelDelete).toHaveBeenCalledWith('cy1', ['s1'], { skipInvoices: false }));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it('per-session delete: deletedCount 0 (nothing removed) → error toast', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockCancelDelete.mockResolvedValue({ deletedCount: 0, protectedCount: 1, protectedSlotIds: ['s1'], cancelledBookings: 0, syncError: null });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete session' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(mockCancelDelete).toHaveBeenCalled());
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  });

  it('per-session delete: toggle "don\'t update invoices" → cancelBookingsAndDeleteSlots called with skipInvoices:true', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockCancelDelete.mockResolvedValue({ deletedCount: 1, protectedCount: 0, protectedSlotIds: [], cancelledBookings: 0, syncError: null });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    fireEvent.click(screen.getByRole('checkbox')); // page-level "Don't update invoices" toggle
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete session' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    await waitFor(() => expect(mockCancelDelete).toHaveBeenCalledWith('cy1', ['s1'], { skipInvoices: true }));
  });

  // --- Whole-cycle delete (FULL: cancel all bookings + delete ALL sessions + remove the cycle row) ---
  it('delete cycle: confirm → cancelBookingsAndDeleteSlots(cycleId, ALL slot ids, {skipInvoices:false}) + deleteCycle + onCycleDeleted', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockCancelDelete.mockResolvedValue({ deletedCount: 2, protectedCount: 0, protectedSlotIds: [], cancelledBookings: 2, syncError: null });
    const onCycleDeleted = vi.fn();
    const onMutated = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit onCycleDeleted={onCycleDeleted} onMutated={onMutated} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete entire cycle/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete cycle$/ }));
    await waitFor(() => expect(mockCancelDelete).toHaveBeenCalledWith('cy1', ['s1', 's2'], { skipInvoices: false }));
    await waitFor(() => expect(mockDeleteCycle).toHaveBeenCalledWith('cy1'));
    await waitFor(() => expect(onCycleDeleted).toHaveBeenCalled());
    // navigation owns the post-delete refresh — onMutated is NOT also fired
    expect(onMutated).not.toHaveBeenCalled();
  });

  it('delete cycle: falls back to onMutated when onCycleDeleted is not wired', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockCancelDelete.mockResolvedValue({ deletedCount: 2, protectedCount: 0, protectedSlotIds: [], cancelledBookings: 2, syncError: null });
    const onMutated = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit onMutated={onMutated} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete entire cycle/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete cycle$/ }));
    await waitFor(() => expect(mockDeleteCycle).toHaveBeenCalledWith('cy1'));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it('delete cycle: a booking racing in (protectedCount>0) keeps the cycle row and does not navigate away', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockCancelDelete.mockResolvedValue({ deletedCount: 1, protectedCount: 1, protectedSlotIds: ['s1'], cancelledBookings: 0, syncError: null });
    const onCycleDeleted = vi.fn();
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit onCycleDeleted={onCycleDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: /Delete entire cycle/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete cycle$/ }));
    await waitFor(() => expect(mockCancelDelete).toHaveBeenCalled());
    expect(mockDeleteCycle).not.toHaveBeenCalled();
    expect(onCycleDeleted).not.toHaveBeenCalled();
  });

  it('delete cycle: toggle "don\'t update invoices" → cancelBookingsAndDeleteSlots called with skipInvoices:true', async () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    mockCancelDelete.mockResolvedValue({ deletedCount: 2, protectedCount: 0, protectedSlotIds: [], cancelledBookings: 2, syncError: null });
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    fireEvent.click(screen.getByRole('checkbox')); // page-level "Don't update invoices" toggle
    fireEvent.click(screen.getByRole('button', { name: /Delete entire cycle/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Delete cycle$/ }));
    await waitFor(() => expect(mockCancelDelete).toHaveBeenCalledWith('cy1', ['s1', 's2'], { skipInvoices: true }));
  });

  it('delete cycle: cancel does NOT call the RPC', () => {
    mockUseCycleDetail.mockReturnValue(loaded);
    renderView(<CycleDetailView cycleId="cy1" onOpenSlot={() => {}} canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /Delete entire cycle/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(mockCancelDelete).not.toHaveBeenCalled();
  });

  // --- States ---
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
