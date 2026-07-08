import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { hourInTimeZone, isWithinSendWindow } from "./send-window.ts";

// Amsterdam is UTC+1 (CET, winter) and UTC+2 (CEST, summer). The helper must track DST.

Deno.test("hourInTimeZone: winter CET (+1)", () => {
  // 2026-01-15 08:30 UTC → 09:30 Amsterdam
  assertEquals(hourInTimeZone(new Date("2026-01-15T08:30:00Z")), 9);
});

Deno.test("hourInTimeZone: summer CEST (+2)", () => {
  // 2026-07-15 08:30 UTC → 10:30 Amsterdam
  assertEquals(hourInTimeZone(new Date("2026-07-15T08:30:00Z")), 10);
});

Deno.test("hourInTimeZone: midnight normalises to 0", () => {
  // 2026-07-15 22:00 UTC → 00:00 Amsterdam (CEST)
  assertEquals(hourInTimeZone(new Date("2026-07-15T22:00:00Z")), 0);
});

Deno.test("send window: daytime true, night false (summer)", () => {
  assertEquals(isWithinSendWindow(new Date("2026-07-15T12:00:00Z")), true); // 14:00 CEST
  assertEquals(isWithinSendWindow(new Date("2026-07-15T17:30:00Z")), true); // 19:30 CEST — still day
  assertEquals(isWithinSendWindow(new Date("2026-07-15T18:30:00Z")), false); // 20:30 CEST — quiet
  assertEquals(isWithinSendWindow(new Date("2026-07-15T05:00:00Z")), false); // 07:00 CEST — too early
  assertEquals(isWithinSendWindow(new Date("2026-07-15T23:00:00Z")), false); // 01:00 CEST — night
});

Deno.test("send window: boundaries 09:00 in / 20:00 out (winter)", () => {
  assertEquals(isWithinSendWindow(new Date("2026-01-15T08:00:00Z")), true); // 09:00 CET — inclusive start
  assertEquals(isWithinSendWindow(new Date("2026-01-15T18:59:00Z")), true); // 19:59 CET — last daytime hour
  assertEquals(isWithinSendWindow(new Date("2026-01-15T19:00:00Z")), false); // 20:00 CET — exclusive end
});
