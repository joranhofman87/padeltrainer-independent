import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { computeRebookExclusion, type SeriesForExclusion } from "./rebook-exclusion.ts";

const S = (seriesKey: string, ...registeredPlayerIds: string[]): SeriesForExclusion => ({ seriesKey, registeredPlayerIds });
const sorted = (a: string[]) => [...a].sort();

Deno.test("an excluded key removes only that series; the rest stay included", () => {
  const r = computeRebookExclusion([S("a", "p1"), S("b", "p2"), S("c", "p3")], ["b"], []);
  assertEquals([...r.includedKeys].sort(), ["a", "c"]);
  assertEquals([...r.excludedKeys], ["b"]);
});

Deno.test("second-bucket collects the excluded series' registered players", () => {
  const r = computeRebookExclusion([S("a", "p1"), S("b", "p2", "p3")], ["b"], ["b"]);
  assertEquals(sorted(r.secondBucketProfileIds), ["p2", "p3"]);
});

Deno.test("a player in BOTH an included and an excluded series is NOT added (subtracted)", () => {
  // p2 is in included 'a' and excluded 'b' → they already get a real claim via 'a'.
  const r = computeRebookExclusion([S("a", "p2"), S("b", "p2", "p3")], ["b"], ["b"]);
  assertEquals(sorted(r.secondBucketProfileIds), ["p3"]);
});

Deno.test("a guest-only excluded series adds nobody (no registered player ids)", () => {
  const r = computeRebookExclusion([S("a", "p1"), S("b")], ["b"], ["b"]);
  assertEquals(r.secondBucketProfileIds, []);
});

Deno.test("secondBucketSeriesKeys must be a subset of excluded — a non-excluded key is ignored", () => {
  // 'a' is not excluded, so even if asked to move its players, it doesn't (it's being rebooked).
  const r = computeRebookExclusion([S("a", "p1"), S("b", "p2")], ["b"], ["a", "b"]);
  assertEquals(r.secondBucketProfileIds, ["p2"]);
  assertEquals([...r.includedKeys].sort(), ["a"]);
});

Deno.test("excluded but NOT second-bucket → players dropped entirely (per-removal 'don't move')", () => {
  const r = computeRebookExclusion([S("a", "p1"), S("b", "p2")], ["b"], []);
  assertEquals(r.secondBucketProfileIds, []);
  assertEquals([...r.excludedKeys], ["b"]);
});

Deno.test("dedupes a player who appears across two second-bucket series", () => {
  const r = computeRebookExclusion([S("a", "p1"), S("b", "p9"), S("c", "p9")], ["b", "c"], ["b", "c"]);
  assertEquals(r.secondBucketProfileIds, ["p9"]);
});

Deno.test("an excluded key that doesn't match any series is ignored", () => {
  const r = computeRebookExclusion([S("a", "p1")], ["ghost"], ["ghost"]);
  assertEquals([...r.includedKeys], ["a"]);
  assertEquals([...r.excludedKeys], []);
  assertEquals(r.secondBucketProfileIds, []);
});
