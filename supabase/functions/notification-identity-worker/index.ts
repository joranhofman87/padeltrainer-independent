/**
 * SLICE A part 2 — the dedicated identity-verification sender.
 *
 * It exists because a verification challenge is the one email in this system whose ADDRESS and whose
 * BODY are both absent from the outbox row. The address is absent because the row is keyed to a
 * person while the challenge proves control of a specific typed address; the body is absent because
 * it contains a capability, and a capability written into a queue row is a capability sitting in
 * every backup and every log. Both are resolved here, at send time, and neither is written back.
 *
 * It claims `p_worker_kind => 'identity_verify'`, which by construction (migration 20261201100000)
 * is the complement of what the generic worker claims: the two can run concurrently, on the same
 * channel, and cannot take the same row.
 *
 * Deploy position: AFTER the routing migration (which already makes the generic worker safe on its
 * own) and BEFORE the guest entrypoints that can enqueue a challenge. Until this is deployed,
 * challenges queue visibly as `pending` rather than failing.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

import { buildIdentityToken, envKeyLookup } from "../_shared/identity-verify-token.ts";
import {
  evaluateIdentitySendGate,
  identityVerificationLink,
  renderIdentityVerificationEmail,
} from "../_shared/identity-send-gate.ts";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { requireServiceRole } from "../_shared/auth.ts";
import { checkChannelKillOrRelease } from "../_shared/channel-kill-check.ts";

/**
 * The narrow slice of the client this worker uses. A structural type rather than
 * `ReturnType<typeof createClient>`: the generated database generics make that type depend on the
 * whole schema, which is both fragile across regenerations and impossible to satisfy from a test
 * double. What this worker actually needs is two calls.
 */
export interface WorkerDb {
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): {
      maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
    };
  };
}

const BATCH_LIMIT = 20;
const WORKER_KIND = "identity_verify";

interface ClaimedRow {
  outbox_id: string;
  event_type: string;
  payload: Record<string, unknown> | null;
  attempts: number;
}

/** Non-PII by construction: ids that are not addresses, a stable code, and counts. The challenge id
 *  is deliberately NOT logged — it is the subject of the capability, and slice C will decide the
 *  correlation convention. Nothing here can be replayed into a working link. */
function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, worker: WORKER_KIND, ...fields }));
}

/** The provider call, injectable. Without this seam a test cannot tell a successful send from a
 *  failed one, and a "healthy path" test quietly becomes a provider-failure test that still passes —
 *  the exact class of green-for-the-wrong-reason this repo has been bitten by before. */
export type SendMail = (
  key: string,
  payload: { from: string; to: string[]; subject: string; html: string },
  opts: { idempotencyKey: string },
) => Promise<{ ok: boolean; id?: string }>;

export async function runIdentityWorker(deps: {
  supabase: WorkerDb;
  resendKey: string;
  siteUrl: string;
  fromAddress: string;
  now?: () => Date;
  send?: SendMail;
}): Promise<{ claimed: number; sent: number; refused: number; failed: number }> {
  const { supabase, resendKey, siteUrl, fromAddress } = deps;
  const send: SendMail = deps.send ??
    ((k, p, o) => sendResendEmail(k, p, o) as unknown as Promise<{ ok: boolean; id?: string }>);
  const now = deps.now ?? (() => new Date());
  const workerToken = `identity-${crypto.randomUUID()}`;

  const { data: claimed, error: claimErr } = await supabase.rpc("claim_notification_outbox_batch", {
    p_channel: "email",
    p_worker: workerToken,
    p_limit: BATCH_LIMIT,
    p_worker_kind: WORKER_KIND,
  });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

  const rows = (claimed ?? []) as ClaimedRow[];
  let sent = 0, refused = 0, failed = 0;

  const record = async (
    outboxId: string,
    status: "sent" | "failed",
    opts: { messageId?: string; error?: string; terminal?: boolean } = {},
  ) => {
    // token-guarded: a superseded run's late write no-ops, which is what makes a stale takeover safe
    const { error } = await supabase.rpc("record_notification_send_result", {
      p_outbox_id: outboxId,
      p_worker: workerToken,
      p_status: status,
      p_provider_message_id: opts.messageId ?? null,
      p_error: opts.error ?? null,
      p_terminal: opts.terminal ?? false,
    });
    if (error) log("record_failed", { outbox_id: outboxId, error: error.message });
  };

  for (const row of rows) {
    // The SQL kill gate only guards CLAIM time. A kill that lands while this batch is in flight must
    // stop the remaining sends too, or an emergency stop still lets up to BATCH_LIMIT capability
    // emails out. Same fail-closed contract as the generic worker: an unreadable check also stops.
    const kill = await checkChannelKillOrRelease(
      (name, args) => supabase.rpc(name, args),
      "email",
      workerToken,
    );
    if (kill.killed) {
      log("channel_killed", { reason: kill.reason, released: kill.released });
      break;
    }

    const challengeId = (row.payload ?? {})["challenge_id"] as string | undefined;

    // The address comes from the CHALLENGE, never from the outbox row's destination: the row is
    // keyed to a candidate person whose current contact may be a different address entirely.
    const { data: targetRows, error: targetErr } = challengeId
      ? await supabase.rpc("identity_challenge_send_target", { p_challenge_id: challengeId })
      : { data: null, error: null };
    if (targetErr) {
      // an unreadable target is NOT terminal: it is probably transient, and burning the row would
      // cost the visitor their booking. Let the attempt budget decide.
      failed++;
      await record(row.outbox_id, "failed", { error: "identity_send_target_unreadable" });
      log("target_unreadable", { outbox_id: row.outbox_id });
      continue;
    }
    const target = (Array.isArray(targetRows) ? (targetRows[0] ?? null) : (targetRows ?? null)) as
      import("../_shared/identity-send-gate.ts").IdentitySendTarget | null;

    // Deliverability. An ERROR here is NOT the same as "this address is dead": treating a
    // PostgREST hiccup as a hard bounce would strand a real customer permanently, which is the exact
    // failure this slice exists to remove. Unreadable => leave the row retryable and move on.
    let suppressed: boolean | null = null;
    if (target?.contact_normalized) {
      const s = await supabase.rpc("is_email_suppressed", { p_email: target.contact_normalized });
      if (s.error) {
        failed++;
        await record(row.outbox_id, "failed", { error: "identity_send_suppression_unreadable" });
        log("suppression_unreadable", { outbox_id: row.outbox_id });
        continue;
      }
      suppressed = s.data as boolean | null;
    }

    const verdict = evaluateIdentitySendGate({ target, now: now(), suppressed });
    if (verdict.action === "stop") {
      refused++;
      await record(row.outbox_id, "failed", { error: verdict.code, terminal: true });
      log("refused", { outbox_id: row.outbox_id, code: verdict.code });
      continue;
    }

    // THE ONLY PLACE A CAPABILITY EXISTS. Built here, from a key that lives only in this function's
    // environment, and referenced exactly once — inside the mail body. Deterministic, so a retry of
    // this same row rebuilds byte-identical bytes under an unchanged provider idempotency key.
    let token: string;
    try {
      const state = await readKeyState(supabase);
      token = await buildIdentityToken(challengeId!, verdict.keyVersion, state, envKeyLookup);
    } catch (_e) {
      // deliberately does not log the error text: it can name key versions and configuration.
      failed++;
      await record(row.outbox_id, "failed", { error: "identity_send_key_unavailable" });
      log("key_unavailable", { outbox_id: row.outbox_id });
      continue;
    }

    const lang = (row.payload ?? {})["lang"] === "en" ? "en" : "nl";
    const { subject, html } = renderIdentityVerificationEmail(
      lang,
      identityVerificationLink(siteUrl, token),
    );

    const outcome = await send(
      resendKey,
      { from: fromAddress, to: [verdict.to], subject, html },
      { idempotencyKey: row.outbox_id },
    );

    if (outcome.ok) {
      sent++;
      await record(row.outbox_id, "sent", { messageId: outcome.id });
      log("sent", { outbox_id: row.outbox_id, workflow: verdict.workflow });
    } else {
      failed++;
      await record(row.outbox_id, "failed", { error: "identity_send_provider_failed" });
      log("provider_failed", { outbox_id: row.outbox_id });
    }
  }

  return { claimed: rows.length, sent, refused, failed };
}

/** The single-row signing-key state. `identity_verify_key_state` is REVOKEd from everyone and
 *  granted SELECT to service_role alone, so this read is itself part of the boundary. A null answer
 *  makes `buildIdentityToken` throw, which this worker turns into a non-terminal
 *  `identity_send_key_unavailable` — a misconfigured key is an operational fault to fix, not a
 *  reason to burn a visitor's challenge. */
async function readKeyState(supabase: WorkerDb) {
  const { data, error } = await supabase
    .from("identity_verify_key_state")
    .select("current_version, min_mintable_version")
    .maybeSingle();
  if (error || !data) return null;
  const r = data as { current_version: number; min_mintable_version: number };
  return { currentVersion: r.current_version, minMintableVersion: r.min_mintable_version };
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    // Same self-authenticating drainer contract as notification-email-worker: verify_jwt is false
    // because pg_cron presents the service-role key itself, so the FUNCTION must do the check.
    // Without this, an unauthenticated caller could drain the identity queue on demand.
    const guard = requireServiceRole(req);
    if (guard) return guard;
    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      ) as unknown as WorkerDb;
      const result = await runIdentityWorker({
        supabase,
        resendKey: Deno.env.get("RESEND_API_KEY")!,
        siteUrl: Deno.env.get("SITE_URL") ?? "https://padeltrainer.ai",
        fromAddress: Deno.env.get("NOTIFICATION_FROM_EMAIL") ?? "no-reply@padeltrainer.ai",
      });
      log("run_complete", result);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      log("run_failed", { error: String(e).slice(0, 200) });
      return new Response(JSON.stringify({ error: "run_failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  });
}
