import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isChargeableAddPlayerBooking,
  groupChargeableBookingsByRecipient,
  buildAutoCreateInvoicePayload,
  syncInvoicesAfterAddPlayer,
  getInvoiceFollowUpMessages,
  type AddPlayerBookingRow,
  type InvoiceAfterAddPlayerResult,
} from "@/lib/invoiceAfterAddPlayer";

const invokeMock = vi.fn();
const fromMock = vi.fn();

vi.mock("@/lib/supabaseClient", () => ({
  supabase: {
    functions: { invoke: (...args: unknown[]) => invokeMock(...args) },
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

const applyUpdatesMock = vi.fn();
vi.mock("@/lib/applyAffectedInvoiceUpdates", () => ({
  applyAffectedInvoiceUpdates: (...args: unknown[]) => applyUpdatesMock(...args),
}));

function booking(overrides: Partial<AddPlayerBookingRow> & { id: string }): AddPlayerBookingRow {
  return {
    guest_player_id: "guest-1",
    player_id: null,
    payment_amount: 40,
    payment_status: "pending",
    paid_externally: false,
    slot_id: "slot-1",
    ...overrides,
  };
}

describe("isChargeableAddPlayerBooking", () => {
  it("allows payment_amount > 0 pending booking", () => {
    expect(isChargeableAddPlayerBooking(booking({ id: "b1" }))).toBe(true);
  });

  it("skips payment_amount = 0", () => {
    expect(isChargeableAddPlayerBooking(booking({ id: "b1", payment_amount: 0 }))).toBe(false);
  });

  it("skips paid booking", () => {
    expect(
      isChargeableAddPlayerBooking(booking({ id: "b1", payment_status: "paid" })),
    ).toBe(false);
  });

  it("skips paid_externally", () => {
    expect(
      isChargeableAddPlayerBooking(booking({ id: "b1", paid_externally: true })),
    ).toBe(false);
  });
});

describe("groupChargeableBookingsByRecipient", () => {
  it("groups booking IDs per guest", () => {
    const groups = groupChargeableBookingsByRecipient([
      booking({ id: "b1", guest_player_id: "g1" }),
      booking({ id: "b2", guest_player_id: "g1" }),
      booking({ id: "b3", guest_player_id: "g2", payment_amount: 20 }),
    ]);
    expect(groups).toHaveLength(2);
    const g1 = groups.find((g) => g.guestPlayerId === "g1");
    expect(g1?.bookingIds).toEqual(["b1", "b2"]);
  });
});

describe("buildAutoCreateInvoicePayload", () => {
  it("sets asDraft and splitAmongPlayers when split active", () => {
    expect(buildAutoCreateInvoicePayload(["b1", "b2"], 3)).toEqual({
      bookingIds: ["b1", "b2"],
      asDraft: true,
      splitAmongPlayers: 3,
    });
  });

  it("omits splitAmongPlayers when not split", () => {
    expect(buildAutoCreateInvoicePayload(["b1"], null)).toEqual({
      bookingIds: ["b1"],
      asDraft: true,
    });
  });
});

describe("syncInvoicesAfterAddPlayer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyUpdatesMock.mockResolvedValue({
      classification: {
        draftInvoiceIds: [],
        sentOrPendingInvoiceIds: [],
        paidInvoiceIds: [],
        cancelledInvoiceIds: [],
      },
      draftsRecalculated: false,
      sentRecalculated: false,
      needsConfirmation: false,
      paidUnchangedCount: 0,
    });
    // default invoke returns success

    fromMock.mockImplementation((table: string) => {
      if (table === "bookings") {
        return {
          select: vi.fn().mockReturnValue({
            in: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: [
                  { player_id: null, guest_player_id: "g1" },
                  { player_id: null, guest_player_id: "g2" },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: vi.fn() };
    });
  });

  it("creates draft invoice for chargeable bookings", async () => {
    invokeMock.mockResolvedValue({ data: { success: true }, error: null });

    const result = await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1" })],
      splitPayment: false,
      slotIds: ["slot-1"],
    });

    expect(invokeMock).toHaveBeenCalledWith("auto-create-invoice", {
      body: { bookingIds: ["b1"], asDraft: true },
    });
    expect(result.created).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("skips zero-amount bookings without invoke", async () => {
    const result = await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1", payment_amount: 0 })],
      splitPayment: false,
      slotIds: [],
    });

    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
  });

  it("passes splitAmongPlayers when split payment active", async () => {
    invokeMock.mockResolvedValue({ data: { success: true }, error: null });

    await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1" })],
      splitPayment: true,
      slotIds: ["slot-1", "slot-2"],
    });

    expect(invokeMock).toHaveBeenCalledWith("auto-create-invoice", {
      body: { bookingIds: ["b1"], asDraft: true, splitAmongPlayers: 2 },
    });
  });

  it("treats skipped edge response as non-blocking", async () => {
    invokeMock.mockResolvedValue({
      data: { skipped: true, reason: "incomplete_business_info" },
      error: null,
    });

    const result = await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1" })],
      splitPayment: false,
      slotIds: [],
    });

    expect(result.skipped).toBe(1);
    expect(result.invoiceCreateSkipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("treats deduped as skipped not failed", async () => {
    invokeMock.mockResolvedValue({
      data: { success: true, deduped: true, invoiceId: "inv-1" },
      error: null,
    });

    const result = await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1" })],
      splitPayment: false,
      slotIds: [],
    });

    expect(result.created).toBe(0);
    expect(result.invoiceCreateSkipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.invoiceCreateAttempts).toBe(1);
  });

  it("counts failed on invoke error", async () => {
    invokeMock.mockResolvedValue({ data: null, error: { message: "network" } });

    const result = await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1" })],
      splitPayment: false,
      slotIds: [],
    });

    expect(result.failed).toBe(1);
  });

  it("applies draft-only invoice updates by default", async () => {
    invokeMock.mockResolvedValue({ data: { success: true }, error: null });

    await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1" })],
      splitPayment: false,
      slotIds: ["slot-a"],
    });

    expect(applyUpdatesMock).toHaveBeenCalledWith(["slot-a"], "update_drafts_only");
  });

  it("returns needsConfirmation when sent invoices are affected", async () => {
    invokeMock.mockResolvedValue({ data: { success: true }, error: null });
    applyUpdatesMock.mockResolvedValue({
      classification: {
        draftInvoiceIds: ["d1"],
        sentOrPendingInvoiceIds: ["s1"],
        paidInvoiceIds: [],
        cancelledInvoiceIds: [],
      },
      draftsRecalculated: true,
      sentRecalculated: false,
      needsConfirmation: true,
      paidUnchangedCount: 0,
    });

    const result = await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1" })],
      splitPayment: false,
      slotIds: ["slot-a"],
    });

    expect(result.needsConfirmation).toBe(true);
    expect(result.classification.sentOrPendingInvoiceIds).toContain("s1");
  });

  it("does not update sent invoices without update_drafts_and_sent choice", async () => {
    invokeMock.mockResolvedValue({ data: { success: true }, error: null });
    applyUpdatesMock.mockResolvedValueOnce({
      classification: {
        draftInvoiceIds: [],
        sentOrPendingInvoiceIds: ["s1"],
        paidInvoiceIds: ["paid1"],
        cancelledInvoiceIds: [],
      },
      draftsRecalculated: true,
      sentRecalculated: false,
      needsConfirmation: true,
      paidUnchangedCount: 1,
    });

    const result = await syncInvoicesAfterAddPlayer({
      newBookings: [booking({ id: "b1" })],
      splitPayment: false,
      slotIds: ["slot-a"],
      invoiceUpdateChoice: "update_drafts_only",
    });

    expect(result.sentRecalculated).toBe(false);
    expect(result.paidUnchangedCount).toBe(1);
    expect(applyUpdatesMock).toHaveBeenCalledWith(["slot-a"], "update_drafts_only");
  });
});

function invoiceResult(
  overrides: Partial<InvoiceAfterAddPlayerResult>,
): InvoiceAfterAddPlayerResult {
  return {
    created: 0,
    skipped: 0,
    failed: 0,
    invoiceCreateAttempts: 0,
    invoiceCreateSkipped: 0,
    nonChargeableBookings: 0,
    needsConfirmation: false,
    classification: {
      draftInvoiceIds: [],
      sentOrPendingInvoiceIds: [],
      paidInvoiceIds: [],
      cancelledInvoiceIds: [],
    },
    paidUnchangedCount: 0,
    draftsRecalculated: false,
    sentRecalculated: false,
    ...overrides,
  };
}

describe("getInvoiceFollowUpMessages", () => {
  it("warns when paid invoices are unchanged", () => {
    const messages = getInvoiceFollowUpMessages(
      invoiceResult({ paidUnchangedCount: 2 }),
    );
    expect(messages.paidUnchanged).toBeTruthy();
  });

  it("notes sent not updated when confirmation was needed", () => {
    const messages = getInvoiceFollowUpMessages(
      invoiceResult({
        needsConfirmation: true,
        classification: {
          draftInvoiceIds: [],
          sentOrPendingInvoiceIds: ["s1"],
          paidInvoiceIds: [],
          cancelledInvoiceIds: [],
        },
      }),
    );
    expect(messages.sentNotUpdated).toBeTruthy();
    expect(messages.sentUpdated).toBeUndefined();
  });

  it("notes sent updated when admin chose draft+sent", () => {
    const messages = getInvoiceFollowUpMessages(
      invoiceResult({
        classification: {
          draftInvoiceIds: [],
          sentOrPendingInvoiceIds: ["s1"],
          paidInvoiceIds: [],
          cancelledInvoiceIds: [],
        },
      }),
      { sentWasUpdated: true },
    );
    expect(messages.sentUpdated).toBeTruthy();
    expect(messages.sentNotUpdated).toBeUndefined();
  });
});
