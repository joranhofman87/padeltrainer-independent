import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runIdentityWorker, type SendMail, type WorkerDb } from "../notification-identity-worker/index.ts";

/** A recording transport. Every test injects one: without it the "healthy" cases would call the real
 *  provider with a fake key, fail, and still pass — green for exactly the wrong reason. */
function recordingSend(result: { ok: boolean; id?: string } = { ok: true, id: "msg_1" }) {
  const sends: Array<{ payload: Record<string, unknown>; opts: { idempotencyKey: string } }> = [];
  const send: SendMail = (_k, payload, opts) => {
    sends.push({ payload: payload as unknown as Record<string, unknown>, opts });
    return Promise.resolve(result);
  };
  return { send, sends };
}

/**
 * Behavioural tests for the dedicated identity sender, against a scripted Supabase double.
 *
 * The properties worth holding here are the ones a type checker cannot: that the worker claims with
 * its OWN worker kind (so it can never take a generic row), that the capability never reaches the
 * database or a log line, and that a refusal is recorded terminally with the stable code rather than
 * retried until the attempt budget burns the visitor's challenge.
 */

const CHALLENGE = "11111111-2222-4333-8444-555555555555";
const OUTBOX = "99999999-8888-4777-8666-555555555555";

interface Call { name: string; args: Record<string, unknown> }

function makeSupabase(over: {
  target?: Record<string, unknown> | null;
  suppressed?: boolean | null;
  suppressionError?: boolean;
  keyState?: { current_version: number; min_mintable_version: number } | null;
  payload?: Record<string, unknown>;
  killed?: boolean;
} = {}) {
  const calls: Call[] = [];
  const target = over.target === undefined
    ? {
      contact_normalized: "visitor@example.com",
      workflow: "slot",
      key_version: 1,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      already_consumed: false,
      key_mintable: true,
    }
    : over.target;

  const supabase = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "claim_notification_outbox_batch") {
        return Promise.resolve({
          data: [{
            outbox_id: OUTBOX,
            event_type: "identity_verification_requested",
            payload: over.payload ?? { challenge_id: CHALLENGE },
            attempts: 1,
          }],
          error: null,
        });
      }
      if (name === "identity_challenge_send_target") {
        return Promise.resolve({ data: target ? [target] : [], error: null });
      }
      if (name === "is_email_suppressed") {
        if (over.suppressionError) {
          return Promise.resolve({ data: null, error: { message: "boom" } });
        }
        return Promise.resolve({
          data: over.suppressed === undefined ? false : over.suppressed,
          error: null,
        });
      }
      if (name === "record_notification_send_result") {
        return Promise.resolve({ data: "sent", error: null });
      }
      // the per-row kill re-check. `false` = not killed; the worker fails CLOSED on anything else,
      // which is why this must be answered explicitly rather than falling through to null.
      if (name === "is_notification_channel_killed") {
        return Promise.resolve({ data: over.killed ?? false, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(_t: string) {
      return {
        select: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: over.keyState === undefined
                ? { current_version: 1, min_mintable_version: 1 }
                : over.keyState,
              error: null,
            }),
        }),
      };
    },
  };
  return { supabase: supabase as unknown as WorkerDb, calls };
}

const KEY = "a".repeat(64);
const withKey = async (fn: () => Promise<void>) => {
  Deno.env.set("IDENTITY_VERIFY_TOKEN_KEY_V1", KEY);
  try { await fn(); } finally { Deno.env.delete("IDENTITY_VERIFY_TOKEN_KEY_V1"); }
};

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.log = orig; } };
}

Deno.test("it claims with its OWN worker kind — it can never take a generic row", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase();
    const { send } = recordingSend();
    await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    const claim = calls.find((c) => c.name === "claim_notification_outbox_batch");
    assert(claim, "must claim");
    assertEquals(claim!.args.p_worker_kind, "identity_verify");
    assertEquals(claim!.args.p_channel, "email");
  });
});

Deno.test("the capability NEVER reaches the database or the logs", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase();
    const { send } = recordingSend();
    const cap = captureLogs();
    try {
      await runIdentityWorker({
        supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
      });
    } finally { cap.restore(); }

    const everythingWritten = JSON.stringify(calls);
    // a token is `v<version>.<uuid>.<sig>` — the signature is what must never be persisted
    assert(!/v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/.test(everythingWritten),
      "no capability token may appear in any RPC argument");
    assert(!everythingWritten.includes(KEY), "the signing key must never be sent to the database");

    const logged = cap.lines.join("\n");
    assert(!/v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/.test(logged), "no token in logs");
    assert(!logged.includes(KEY), "no key material in logs");
    assert(!logged.includes("visitor@example.com"), "no email address in logs");
    assert(!logged.includes(CHALLENGE), "no challenge id in logs");
  });
});

Deno.test("a hard-bounced address is recorded TERMINALLY with the stable code", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase({ suppressed: true });
    const { send } = recordingSend();
    const r = await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    assertEquals(r.refused, 1);
    assertEquals(r.sent, 0);
    const rec = calls.find((c) => c.name === "record_notification_send_result");
    assert(rec, "must record");
    assertEquals(rec!.args.p_error, "identity_send_undeliverable");
    assertEquals(rec!.args.p_terminal, true);
  });
});

Deno.test("an already-consumed challenge is not mailed, and is not left to retry", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase({
      target: {
        contact_normalized: "visitor@example.com", workflow: "slot", key_version: 1,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        already_consumed: true, key_mintable: true,
      },
    });
    const { send } = recordingSend();
    const r = await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    assertEquals(r.refused, 1);
    const rec = calls.find((c) => c.name === "record_notification_send_result");
    assertEquals(rec!.args.p_error, "identity_send_already_consumed");
    assertEquals(rec!.args.p_terminal, true);
  });
});

Deno.test("a missing signing key is NOT terminal — a config fault must not burn the challenge", async () => {
  // no IDENTITY_VERIFY_TOKEN_KEY_V1 in the environment
  const { supabase, calls } = makeSupabase();
  const { send } = recordingSend();
  const r = await runIdentityWorker({
    supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
  });
  assertEquals(r.failed, 1);
  const rec = calls.find((c) => c.name === "record_notification_send_result");
  assertEquals(rec!.args.p_error, "identity_send_key_unavailable");
  assert(rec!.args.p_terminal !== true, "a missing key must stay retryable");
});

Deno.test("a row whose payload names no challenge refuses terminally instead of looping", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase({ payload: {}, target: null });
    const { send } = recordingSend();
    const r = await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    assertEquals(r.refused, 1);
    const rec = calls.find((c) => c.name === "record_notification_send_result");
    assertEquals(rec!.args.p_error, "identity_send_no_challenge");
    assertEquals(rec!.args.p_terminal, true);
  });
});

Deno.test("the send target is read from the CHALLENGE, keyed by the payload's challenge id", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase();
    const { send } = recordingSend();
    await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    const t = calls.find((c) => c.name === "identity_challenge_send_target");
    assert(t, "must resolve the address from the challenge, not the outbox row");
    assertEquals(t!.args.p_challenge_id, CHALLENGE);
  });
});

Deno.test("the healthy path actually SENDS — one email, to the challenge's address, idempotent on the outbox id", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase();
    const { send, sends } = recordingSend();
    const r = await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    assertEquals(r.sent, 1);
    assertEquals(r.refused, 0);
    assertEquals(r.failed, 0);
    assertEquals(sends.length, 1, "exactly one email per claimed row");
    assertEquals(sends[0].payload.to, ["visitor@example.com"]);
    // the provider idempotency key IS the outbox id, so any retry of this row dedupes at Resend
    assertEquals(sends[0].opts.idempotencyKey, OUTBOX);
    const rec = calls.find((c) => c.name === "record_notification_send_result");
    assertEquals(rec!.args.p_status, "sent");
    assertEquals(rec!.args.p_provider_message_id, "msg_1");
  });
});

Deno.test("the capability appears ONLY in the mail body, never in provider metadata", async () => {
  await withKey(async () => {
    const { supabase } = makeSupabase();
    const { send, sends } = recordingSend();
    await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    const p = sends[0].payload as { html: string; subject: string; to: string[] };
    const TOKEN = /v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/;
    assert(TOKEN.test(p.html), "the body must carry the link");
    assert(!TOKEN.test(p.subject), "no capability in the subject");
    assert(!TOKEN.test(JSON.stringify(sends[0].opts)), "no capability in provider options");
  });
});

Deno.test("a provider failure is recorded NON-terminally, so the visitor's challenge survives a bad minute", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase();
    const { send } = recordingSend({ ok: false });
    const r = await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    assertEquals(r.failed, 1);
    const rec = calls.find((c) => c.name === "record_notification_send_result");
    assertEquals(rec!.args.p_error, "identity_send_provider_failed");
    assert(rec!.args.p_terminal !== true, "a provider blip must stay retryable");
  });
});

Deno.test("a channel KILL stops the batch before any capability email leaves", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase({ killed: true });
    const { send, sends } = recordingSend();
    const r = await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    assertEquals(sends.length, 0, "a killed channel sends nothing");
    assertEquals(r.sent, 0);
    // and nothing was finalised, so the rows stay reclaimable rather than being burned
    assert(!calls.some((c) => c.name === "record_notification_send_result"),
      "a kill must not terminally finalise the claimed rows");
  });
});

Deno.test("an ERRORING suppression check is retryable, not a permanent hard bounce", async () => {
  await withKey(async () => {
    const { supabase, calls } = makeSupabase({ suppressionError: true });
    const { send, sends } = recordingSend();
    const r = await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    assertEquals(sends.length, 0, "nothing is sent when deliverability is unknown");
    assertEquals(r.failed, 1);
    const rec = calls.find((c) => c.name === "record_notification_send_result");
    assertEquals(rec!.args.p_error, "identity_send_suppression_unreadable");
    assert(rec!.args.p_terminal !== true, "an unreadable check must NOT burn the row");
  });
});

Deno.test("a NULL suppression answer is also 'unknown', never 'undeliverable'", async () => {
  // The SQL contract is a non-null boolean; a null would mean the contract drifted. Treating that as
  // a hard bounce would permanently strand real customers on a schema change.
  await withKey(async () => {
    const { supabase, calls } = makeSupabase({ suppressed: null });
    const { send, sends } = recordingSend();
    const r = await runIdentityWorker({
      supabase, resendKey: "re_test", siteUrl: "https://x.test", fromAddress: "n@x.test", send,
    });
    assertEquals(sends.length, 0);
    assertEquals(r.failed, 1);
    const rec = calls.find((c) => c.name === "record_notification_send_result");
    assertEquals(rec!.args.p_error, "identity_send_suppression_unreadable");
    assert(rec!.args.p_terminal !== true);
  });
});
