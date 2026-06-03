import { describe, it, expect } from "vitest";
import {
  computeCyclusGroupPaymentStatus,
  isActiveBooking,
  isPaidBooking,
  matchesPaidFilter,
} from "@/lib/cyclusGroupPayment";

describe("isActiveBooking", () => {
  it("treats confirmed and pending as active", () => {
    expect(isActiveBooking({ status: "confirmed" })).toBe(true);
    expect(isActiveBooking({ status: "pending" })).toBe(true);
  });

  it("ignores cancelled", () => {
    expect(isActiveBooking({ status: "cancelled" })).toBe(false);
  });
});

describe("isPaidBooking", () => {
  it("counts payment_status paid", () => {
    expect(
      isPaidBooking({ status: "confirmed", payment_status: "paid", paid_externally: false }),
    ).toBe(true);
  });

  it("counts paid_externally", () => {
    expect(
      isPaidBooking({ status: "confirmed", payment_status: "pending", paid_externally: true }),
    ).toBe(true);
  });
});

describe("computeCyclusGroupPaymentStatus", () => {
  it("returns no_players when there are no active bookings", () => {
    expect(computeCyclusGroupPaymentStatus([])).toBe("no_players");
  });

  it("returns all_paid when every active booking is paid", () => {
    expect(
      computeCyclusGroupPaymentStatus([
        { status: "confirmed", payment_status: "paid", paid_externally: false },
        { status: "pending", payment_status: "paid", paid_externally: false },
      ]),
    ).toBe("all_paid");
  });

  it("returns has_unpaid when at least one active booking is unpaid", () => {
    expect(
      computeCyclusGroupPaymentStatus([
        { status: "confirmed", payment_status: "paid", paid_externally: false },
        { status: "confirmed", payment_status: "pending", paid_externally: false },
      ]),
    ).toBe("has_unpaid");
  });

  it("treats paid_externally as paid", () => {
    expect(
      computeCyclusGroupPaymentStatus([
        { status: "confirmed", payment_status: "pending", paid_externally: true },
      ]),
    ).toBe("all_paid");
  });

  it("ignores cancelled bookings", () => {
    expect(
      computeCyclusGroupPaymentStatus([
        { status: "cancelled", payment_status: "pending", paid_externally: false },
        { status: "confirmed", payment_status: "paid", paid_externally: false },
      ]),
    ).toBe("all_paid");
  });
});

describe("matchesPaidFilter", () => {
  it("filters paid groups", () => {
    expect(matchesPaidFilter("all_paid", "paid")).toBe(true);
    expect(matchesPaidFilter("has_unpaid", "paid")).toBe(false);
  });

  it("filters unpaid groups", () => {
    expect(matchesPaidFilter("has_unpaid", "unpaid")).toBe(true);
    expect(matchesPaidFilter("all_paid", "unpaid")).toBe(false);
  });

  it("filters no players", () => {
    expect(matchesPaidFilter("no_players", "no_players")).toBe(true);
    expect(matchesPaidFilter("all_paid", "no_players")).toBe(false);
  });
});
