import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { computeRegistrationCharge, type RegistrationPricingCycle } from "./registration-pricing.ts";

// GOLDEN — the registration charge math, locked across the pricing matrix. The F2/Slice-8 pricing
// work (and any refactor of this function) must reproduce these byte-for-byte: this is what the
// public form previews AND what the invoice charges, so any drift is a real over/under-charge.
// VAT 9% throughout (the live academy rate); spans chosen so floor(weeks) = 10.

const baseCycle = (over: Partial<RegistrationPricingCycle>): RegistrationPricingCycle => ({
  type: "registration",
  total_price: null,
  price_per_session: null,
  price_table: null,
  start_date: "2026-04-01",
  end_date: "2026-06-10", // 70 days → floor 10 weeks
  settings: {},
  ...over,
});

Deno.test("GOLDEN: per-lesson, single VAT 9%, prices include VAT", () => {
  const charge = computeRegistrationCharge(
    baseCycle({ price_table: [{ price: 20 }], settings: { lesson_types: ["group"] } }),
    9,
    { lessonTypes: ["group"] },
  );
  assertEquals(charge, {
    lineItems: [{ description: "group (10×)", quantity: 1, unit_price: 200, vat_rate: 9 }],
    subtotal: 183.49,
    vatAmount: 16.51,
    total: 200,
    vatRate: 9,
    vatBreakdown: {},
    lessonCount: 10,
  });
});

Deno.test("GOLDEN: package (cyclus_option) priced by total_price, single VAT 9%", () => {
  const charge = computeRegistrationCharge(
    baseCycle({
      end_date: "2026-06-17",
      settings: {
        cyclus_options: [{ label: "10 lessen", number_of_sessions: 10, number_of_weeks: 11, total_price: 171 }],
      },
    }),
    9,
    { lessonTypes: [], cyclusOptionLabel: "10 lessen" },
  );
  assertEquals(charge, {
    lineItems: [{ description: "10 lessen", quantity: 1, unit_price: 171, vat_rate: 9 }],
    subtotal: 156.88,
    vatAmount: 14.12,
    total: 171,
    vatRate: 9,
    vatBreakdown: {},
    lessonCount: 10, // number_of_sessions, not the 11-week span
  });
});

Deno.test("GOLDEN: multi-VAT per-lesson (group 9% default + private row-VAT 21%)", () => {
  const charge = computeRegistrationCharge(
    baseCycle({
      price_table: [{ price: 20 }, { price: 30, vat_rate: 21 }],
      settings: { lesson_types: ["group", "private"] },
    }),
    9,
    { lessonTypes: ["group", "private"] },
  );
  assertEquals(charge, {
    lineItems: [
      { description: "group (10×)", quantity: 1, unit_price: 200, vat_rate: 9 },
      { description: "private (10×)", quantity: 1, unit_price: 300, vat_rate: 21 },
    ],
    subtotal: 431.42,
    vatAmount: 68.58,
    total: 500,
    vatRate: 9,
    vatBreakdown: { 9: { subtotal: 183.49, vat: 16.51 }, 21: { subtotal: 247.93, vat: 52.07 } },
    lessonCount: 10,
  });
});

Deno.test("GOLDEN: per-lesson, prices EXCLUDE VAT 9%", () => {
  const charge = computeRegistrationCharge(
    baseCycle({ price_table: [{ price: 20 }], settings: { lesson_types: ["group"], prices_include_vat: false } }),
    9,
    { lessonTypes: ["group"] },
  );
  assertEquals(charge, {
    lineItems: [{ description: "group (10×)", quantity: 1, unit_price: 200, vat_rate: 9 }],
    subtotal: 200,
    vatAmount: 18,
    total: 218,
    vatRate: 9,
    vatBreakdown: {},
    lessonCount: 10,
  });
});

Deno.test("GOLDEN: returns null (no €0 mint) when there is no payable price", () => {
  // no price_table + no price_per_session → nothing to charge per-lesson
  assertEquals(
    computeRegistrationCharge(baseCycle({ settings: { lesson_types: ["group"] } }), 9, { lessonTypes: ["group"] }),
    null,
  );
});

Deno.test("GOLDEN: rejects an out-of-set duration (no free multiplier) → null", () => {
  assertEquals(
    computeRegistrationCharge(
      baseCycle({ price_table: [{ price: 20 }], settings: { lesson_types: ["group"], duration_options: [10, 11] } }),
      9,
      { lessonTypes: ["group"], durationWeeks: 99 },
    ),
    null,
  );
});

Deno.test("GOLDEN: ignores a non-offered lesson type (underpayment guard) → null", () => {
  assertEquals(
    computeRegistrationCharge(
      baseCycle({ price_table: [{ price: 20 }], settings: { lesson_types: ["group"] } }),
      9,
      { lessonTypes: ["hacker_cheap_type"] },
    ),
    null,
  );
});
