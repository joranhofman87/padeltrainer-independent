import { describe, it, expect } from "vitest";
import {
  isInvoiceBusinessProfileComplete,
  resolveAutoCreateBusinessGate,
} from "../../supabase/functions/_shared/invoice-business.ts";

describe("isInvoiceBusinessProfileComplete", () => {
  it("requires business_name, kvk_number, and iban", () => {
    expect(
      isInvoiceBusinessProfileComplete({
        business_name: "Academy BV",
        kvk_number: "123",
        iban: "NL00BANK0123456789",
      }),
    ).toBe(true);
  });

  it("is false when any field is missing", () => {
    expect(
      isInvoiceBusinessProfileComplete({
        business_name: "Academy BV",
        kvk_number: null,
        iban: "NL00BANK0123456789",
      }),
    ).toBe(false);
  });
});

describe("resolveAutoCreateBusinessGate", () => {
  const incomplete = {
    business_name: null,
    kvk_number: null,
    iban: null,
  };

  const complete = {
    business_name: "Padel BV",
    kvk_number: "12345678",
    iban: "NL00BANK0123456789",
  };

  it("asDraft true + incomplete → create draft (no skip)", () => {
    expect(resolveAutoCreateBusinessGate(true, incomplete)).toEqual({
      skip: false,
      incompleteBusinessProfile: true,
    });
  });

  it("asDraft false + incomplete → skip as before", () => {
    expect(resolveAutoCreateBusinessGate(false, incomplete)).toEqual({
      skip: true,
      incompleteBusinessProfile: true,
      reason: "incomplete_business_info",
    });
  });

  it("asDraft true + complete → create normally", () => {
    expect(resolveAutoCreateBusinessGate(true, complete)).toEqual({
      skip: false,
      incompleteBusinessProfile: false,
    });
  });

  it("asDraft false + complete → create normally", () => {
    expect(resolveAutoCreateBusinessGate(false, complete)).toEqual({
      skip: false,
      incompleteBusinessProfile: false,
    });
  });
});

describe("draft vs sent policy (documented expectations)", () => {
  it("zero-price skip is independent of business gate", () => {
    // missing_price_data is enforced in auto-create-invoice after line items, not here
    expect(resolveAutoCreateBusinessGate(true, { business_name: null })).toMatchObject({
      skip: false,
    });
  });

  it("duplicate handling is independent of business gate", () => {
    expect(resolveAutoCreateBusinessGate(true, { business_name: "X", kvk_number: "1", iban: "NL1" })).toMatchObject({
      skip: false,
      incompleteBusinessProfile: false,
    });
  });
});
