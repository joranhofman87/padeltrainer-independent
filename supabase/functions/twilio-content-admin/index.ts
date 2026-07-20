// Notification Foundation v2 — PR 9: Twilio Content Template ADMIN tool.
//
// WhatsApp business-initiated messages (all of ours — reminders fire on our schedule, not in
// reply to anything) must use a Meta-APPROVED Content Template. This function manages those
// templates through Twilio's Content API so they don't have to be hand-built in the console,
// and so the exact body/variable order lives in version control next to the worker that fills
// them.
//
// It is an OPS tool, not part of the send path: service-role only, and it never runs on its
// own — nothing schedules it. It exists because the Twilio credentials are injected here as
// function secrets, so neither a human nor an assistant needs to handle them to create a
// template.
//
// Actions:
//   list                      → GET  /v1/Content                      (what exists today)
//   create {template}         → POST /v1/Content                      (creates the content; NOT sent to Meta)
//   submit {sid, name, category} → POST /v1/Content/{sid}/ApprovalRequests/whatsapp (Meta review)
//   status {sid}              → GET  /v1/Content/{sid}/ApprovalRequests
//
// create and submit are DELIBERATELY separate: creating content is internal and reversible,
// submitting puts a template in front of Meta under the business's identity. Review the created
// body before submitting.
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { requireServiceRole } from "../_shared/auth.ts";
import { restrictedCors } from "../_shared/cors.ts";

// Privileged ops endpoint → restrictedCors (echoes only whitelisted origins), per the
// guidance in _shared/cors.ts. The service-role guard is the real gate, but a wide-open
// `*` on an admin endpoint is not what this repo does.
const jsonWith = (cors: Record<string, string>) => (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const CONTENT_API = "https://content.twilio.com/v1/Content";

/** Basic auth from the injected secrets — the values never leave this function. */
function twilioAuthHeader(sid: string, token: string): string {
  return `Basic ${btoa(`${sid}:${token}`)}`;
}

serve(async (req: Request): Promise<Response> => {
  const cors = restrictedCors(req);
  const json = jsonWith(cors);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const guard = requireServiceRole(req);
  if (guard) {
    // requireServiceRole's SHARED response carries wide-open `*` CORS. Re-wrap it with this
    // endpoint's restricted headers so EVERY path is consistent — including rejection.
    // Re-wrapping (rather than re-authoring the body) keeps us correct if that shared
    // message ever changes.
    return new Response(await guard.text(), {
      status: guard.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (!accountSid || !authToken) {
    return json({ error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not configured" }, 500);
  }
  const auth = twilioAuthHeader(accountSid, authToken);

  let payload: {
    action?: string;
    sid?: string;
    name?: string;
    category?: string;
    template?: { friendly_name: string; language: string; variables?: Record<string, string>; body: string };
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const action = payload.action ?? "list";

  try {
    if (action === "diagnose") {
      // Reports only the SHAPE of the credentials — never the values — so a bad paste can be
      // identified without anyone handling secrets. Twilio: Account SID = "AC" + 32 chars (34
      // total); Auth Token = 32 chars; an API Key SID starts "SK" and is NOT an Account SID.
      const shape = (v: string) => ({
        length: v.length,
        prefix: v.slice(0, 2),
        has_surrounding_whitespace: v !== v.trim(),
        has_newline: /[\r\n]/.test(v),
      });
      return json({
        ok: true,
        account_sid: shape(accountSid),
        auth_token: { length: authToken.length, has_surrounding_whitespace: authToken !== authToken.trim(), has_newline: /[\r\n]/.test(authToken) },
        expected: { account_sid: "prefix 'AC', length 34", auth_token: "length 32" },
        whatsapp_from_set: Boolean(Deno.env.get("TWILIO_WHATSAPP_FROM")),
        whatsapp_from_prefix: (Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "").slice(0, 9),
      });
    }

    if (action === "list") {
      const res = await fetch(`${CONTENT_API}?PageSize=50`, { headers: { Authorization: auth } });
      const body = await res.json();
      // project to the fields that matter, so the response is readable
      const contents = (body?.contents ?? []).map((c: Record<string, unknown>) => ({
        sid: c.sid, friendly_name: c.friendly_name, language: c.language,
        variables: c.variables, types: Object.keys((c.types ?? {}) as object),
      }));
      // On failure, surface Twilio's own error body — swallowing it makes credential problems
      // look like "no templates exist", which is exactly the wrong diagnosis.
      if (!res.ok) return json({ ok: false, status: res.status, twilio_error: body }, res.status);
      return json({ ok: true, count: contents.length, contents });
    }

    if (action === "create") {
      const t = payload.template;
      if (!t?.friendly_name || !t?.language || !t?.body) {
        return json({ error: "template.friendly_name, template.language and template.body are required" }, 400);
      }
      const res = await fetch(CONTENT_API, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          friendly_name: t.friendly_name,
          language: t.language,
          variables: t.variables ?? {},
          types: { "twilio/text": { body: t.body } },
        }),
      });
      const body = await res.json();
      return json({ ok: res.ok, status: res.status, sid: body?.sid ?? null, body }, res.ok ? 200 : res.status);
    }

    if (action === "submit") {
      // The Meta-facing step. `name` must be lowercase_with_underscores; category drives both
      // approval odds and per-message price — a reminder is UTILITY, never MARKETING.
      if (!payload.sid || !payload.name || !payload.category) {
        return json({ error: "sid, name and category are required" }, 400);
      }
      const res = await fetch(`${CONTENT_API}/${payload.sid}/ApprovalRequests/whatsapp`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name: payload.name, category: payload.category }),
      });
      const body = await res.json();
      return json({ ok: res.ok, status: res.status, body }, res.ok ? 200 : res.status);
    }

    if (action === "status") {
      if (!payload.sid) return json({ error: "sid is required" }, 400);
      const res = await fetch(`${CONTENT_API}/${payload.sid}/ApprovalRequests`, {
        headers: { Authorization: auth },
      });
      const body = await res.json();
      return json({ ok: res.ok, status: res.status, body }, res.ok ? 200 : res.status);
    }

    return json({ error: `unknown action '${action}' (expected list|create|submit|status)` }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
