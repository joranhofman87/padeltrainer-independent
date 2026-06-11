import { describe, it, expect } from "vitest";
import { getFriendlyErrorMessage, isTechnicalErrorMessage, extractRawMessage } from "@/lib/friendlyError";

const FALLBACK = "Er ging iets mis. Probeer het opnieuw.";

describe("getFriendlyErrorMessage", () => {
  it("hides raw backend/edge/Postgres leakage behind the fallback", () => {
    const technical = [
      "Edge Function returned a non-2xx status code",
      "new row violates row-level security policy for table \"bookings\"",
      'duplicate key value violates unique constraint "invoices_trainer_id_invoice_number_key"',
      "JSON object requested, multiple (or no) rows returned",
      "Failed to fetch",
      '{"name":"AuthRetryableFetchError","status":0}',
      "[object Object]",
      "permission denied for table invoices",
      "supabase request failed",
    ];
    for (const msg of technical) {
      expect(getFriendlyErrorMessage(new Error(msg), FALLBACK)).toBe(FALLBACK);
    }
  });

  it("passes through intentional, already-translated user messages", () => {
    expect(getFriendlyErrorMessage(new Error("Dit tijdslot is al volgeboekt."), FALLBACK))
      .toBe("Dit tijdslot is al volgeboekt.");
    expect(getFriendlyErrorMessage("Je hebt nog geen betaalmethode gekozen.", FALLBACK))
      .toBe("Je hebt nog geen betaalmethode gekozen.");
  });

  it("uses the fallback for empty/missing errors", () => {
    expect(getFriendlyErrorMessage(null, FALLBACK)).toBe(FALLBACK);
    expect(getFriendlyErrorMessage(new Error(""), FALLBACK)).toBe(FALLBACK);
    expect(getFriendlyErrorMessage({}, FALLBACK)).toBe(FALLBACK);
  });

  it("extracts messages from common Supabase error shapes", () => {
    expect(extractRawMessage({ message: "boom" })).toBe("boom");
    expect(extractRawMessage({ error_description: "bad grant" })).toBe("bad grant");
    expect(extractRawMessage({ error: "nope" })).toBe("nope");
  });

  it("treats a JSON object dump as technical", () => {
    expect(isTechnicalErrorMessage('{"foo":1}')).toBe(true);
    expect(isTechnicalErrorMessage("Gewoon een nette melding")).toBe(false);
  });
});
