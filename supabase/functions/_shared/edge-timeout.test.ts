import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { withTimeout } from "./edge-timeout.ts";

Deno.test("withTimeout resolves when the promise beats the deadline", async () => {
  const r = await withTimeout(Promise.resolve("ok"), 1000, "fast");
  assertEquals(r, "ok");
});

Deno.test("withTimeout resolves a slightly-slow promise within the deadline", async () => {
  const slow = new Promise<number>((res) => setTimeout(() => res(42), 10));
  const r = await withTimeout(slow, 1000, "slow-ok");
  assertEquals(r, 42);
});

Deno.test("withTimeout rejects with timeout:<label> when the promise hangs", async () => {
  const never = new Promise<string>(() => {});
  await assertRejects(
    () => withTimeout(never, 20, "hang"),
    Error,
    "timeout:hang",
  );
});

Deno.test("withTimeout propagates the promise's own rejection unchanged", async () => {
  await assertRejects(
    () => withTimeout(Promise.reject(new Error("boom")), 1000, "err"),
    Error,
    "boom",
  );
});
