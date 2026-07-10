import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { buildTargetCycleNames, seriesLabel } from "./rebook-target-naming.ts";

const TZ = "Europe/Amsterdam";
// 2026-09-02T07:00Z = Wednesday 09:00 Amsterdam (CEST).
const WED_9 = "2026-09-02T07:00:00.000Z";
const WED_19 = "2026-09-02T17:00:00.000Z";

Deno.test("seriesLabel renders the academy-local Dutch day + time", () => {
  assertEquals(seriesLabel(WED_9, TZ), "Wo 09:00");
  assertEquals(seriesLabel(WED_19, TZ), "Wo 19:00");
});

Deno.test("single series keeps the round name verbatim (old behavior)", () => {
  const names = buildTargetCycleNames("Volgende ronde 2026", [{ key: "a", startIso: WED_9 }], TZ);
  assertEquals(names.get("a"), "Volgende ronde 2026");
});

Deno.test("multi-series: day+time suffix when unique", () => {
  const names = buildTargetCycleNames("Ronde 3", [
    { key: "a", startIso: WED_9 },
    { key: "b", startIso: WED_19 },
  ], TZ);
  assertEquals(names.get("a"), "Ronde 3 — Wo 09:00");
  assertEquals(names.get("b"), "Ronde 3 — Wo 19:00");
});

Deno.test("same day+time, two trainers → trainer disambiguates", () => {
  const names = buildTargetCycleNames("Ronde 3", [
    { key: "a", startIso: WED_9, trainerName: "Jan", locationName: "Padel City" },
    { key: "b", startIso: WED_9, trainerName: "Piet", locationName: "Padel City" },
    { key: "c", startIso: WED_19, trainerName: "Jan" },
  ], TZ);
  assertEquals(names.get("a"), "Ronde 3 — Wo 09:00 · Jan");
  assertEquals(names.get("b"), "Ronde 3 — Wo 09:00 · Piet");
  assertEquals(names.get("c"), "Ronde 3 — Wo 19:00"); // no collision → no suffix
});

Deno.test("same day+time + same trainer, two locations → location disambiguates", () => {
  const names = buildTargetCycleNames("Ronde 3", [
    { key: "a", startIso: WED_9, trainerName: "Jan", locationName: "Padel City" },
    { key: "b", startIso: WED_9, trainerName: "Jan", locationName: "Beach Club" },
  ], TZ);
  assertEquals(names.get("a"), "Ronde 3 — Wo 09:00 · Jan · Padel City");
  assertEquals(names.get("b"), "Ronde 3 — Wo 09:00 · Jan · Beach Club");
});

Deno.test("identical everything → numeric last resort keeps names distinct", () => {
  const names = buildTargetCycleNames("Ronde 3", [
    { key: "a", startIso: WED_9, trainerName: "Jan", locationName: "Padel City" },
    { key: "b", startIso: WED_9, trainerName: "Jan", locationName: "Padel City" },
  ], TZ);
  const all = [...names.values()];
  assertEquals(new Set(all).size, 2); // distinct, whatever the suffix
  assertEquals(all[0].startsWith("Ronde 3 — Wo 09:00"), true);
});

Deno.test("missing trainer/location names fall through without crashing", () => {
  const names = buildTargetCycleNames("R", [
    { key: "a", startIso: WED_9 },
    { key: "b", startIso: WED_9 },
  ], TZ);
  assertEquals(new Set([...names.values()]).size, 2); // numeric fallback
});
