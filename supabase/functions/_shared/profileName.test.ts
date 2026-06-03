import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  getDisplayName,
  resolveGuestNameForInvoice,
  resolveRegistrationNameFields,
} from "./profileName.ts";

Deno.test("resolveGuestNameForInvoice prefers structured guest names", () => {
  assertEquals(
    resolveGuestNameForInvoice({
      first_name: "Jan",
      last_name: "Jansen",
      full_name: "Wrong Legacy",
    }),
    "Jan Jansen",
  );
});

Deno.test("resolveGuestNameForInvoice falls back to full_name", () => {
  assertEquals(
    resolveGuestNameForInvoice({ full_name: "Legacy Guest" }),
    "Legacy Guest",
  );
});

Deno.test("resolveRegistrationNameFields for guest registration", () => {
  const fields = resolveRegistrationNameFields({
    firstName: "Jane",
    lastName: "Player",
  });
  assertEquals(fields.full_name, "Jane Player");
  assertEquals(fields.first_name, "Jane");
  assertEquals(fields.last_name, "Player");
});

Deno.test("getDisplayName uses structured fields", () => {
  assertEquals(
    getDisplayName({ first_name: "Jan", last_name: "Meer", full_name: "X" }),
    "Jan Meer",
  );
});
