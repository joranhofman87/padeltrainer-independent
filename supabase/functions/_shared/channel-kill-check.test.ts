// N4 M2 — the pre-provider kill re-check's contract, tested directly (both instant workers
// call this at the top of every row iteration):
//   * only an explicit `false` proceeds — null, undefined, an error, a THROWN rpc all count
//     as killed (fail-closed);
//   * on kill the worker's remaining claims are released (token passed through verbatim), and
//     the released count is reported;
//   * a failing release never masks the kill verdict — the rows ride out the stale window.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkChannelKillOrRelease, type KillCheckRpc } from "./channel-kill-check.ts";

function rpcOf(
  killAnswer: { data: unknown; error: { message: string } | null } | "throw",
  releaseAnswer: { data: unknown; error: { message: string } | null } | "throw" = { data: 3, error: null },
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc: KillCheckRpc = (name, args) => {
    calls.push({ name, args });
    const a = name === "is_notification_channel_killed" ? killAnswer : releaseAnswer;
    if (a === "throw") return Promise.reject(new Error("boom"));
    return Promise.resolve(a);
  };
  return { rpc, calls };
}

Deno.test("an explicit false proceeds — and releases NOTHING", async () => {
  const { rpc, calls } = rpcOf({ data: false, error: null });
  const r = await checkChannelKillOrRelease(rpc, "email", "tok-1");
  assertEquals(r, { killed: false });
  assertEquals(calls.length, 1);
});

Deno.test("true kills: the release runs with the worker's own token and its count is reported", async () => {
  const { rpc, calls } = rpcOf({ data: true, error: null }, { data: 7, error: null });
  const r = await checkChannelKillOrRelease(rpc, "whatsapp", "tok-2");
  assertEquals(r, { killed: true, released: 7, reason: "killed" });
  assertEquals(calls[1], {
    name: "release_notification_claims_on_kill",
    args: { p_channel: "whatsapp", p_worker: "tok-2" },
  });
});

Deno.test("FAIL-CLOSED: an rpc error, a null, an undefined and a THROW each count as killed", async () => {
  for (const bad of [
    { data: null, error: { message: "read failed" } },
    { data: null, error: null },
    { data: undefined, error: null },
    "throw" as const,
  ]) {
    const { rpc } = rpcOf(bad);
    const r = await checkChannelKillOrRelease(rpc, "email", "tok-3");
    assertEquals(r.killed, true);
    if (r.killed) assertEquals(r.reason, "check_failed");
  }
});

Deno.test("a non-boolean truthy answer is killed too — never 'probably fine'", async () => {
  const { rpc } = rpcOf({ data: "yes", error: null });
  const r = await checkChannelKillOrRelease(rpc, "email", "tok-4");
  assertEquals(r.killed, true);
  if (r.killed) assertEquals(r.reason, "killed");
});

Deno.test("a FAILING release keeps the kill verdict — released 0, the stale window covers the rows", async () => {
  const { rpc } = rpcOf({ data: true, error: null }, "throw");
  const r = await checkChannelKillOrRelease(rpc, "email", "tok-5");
  assertEquals(r, { killed: true, released: 0, reason: "killed" });
  const { rpc: rpc2 } = rpcOf({ data: true, error: null }, { data: null, error: { message: "release failed" } });
  const r2 = await checkChannelKillOrRelease(rpc2, "email", "tok-6");
  assertEquals(r2, { killed: true, released: 0, reason: "killed" });
});
