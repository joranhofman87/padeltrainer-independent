// N7 step 3c — the EXTERNAL liveness surface for the digest worker.
//
// `public.notif_digest_worker_liveness()` is service_role-only, so nothing outside the platform can
// read it. This is the one place that does, behind its own credential, returning six PII-free
// operational facts and — the part that matters — a status code an uptime provider can alert on
// without being taught to parse anything.
//
// verify_jwt = false (config.toml): an uptime provider cannot carry a Supabase JWT. The
// NOTIF_LIVENESS_TOKEN is the auth, compared in constant time, and it fails CLOSED when unset.
//
// THIS FILE IS ONLY WIRING. Every decision — auth, env parsing, RPC result shape, error redaction,
// headers, status codes — lives in _shared/notif-liveness-core.ts behind `createLivenessHandler`,
// where Deno tests can reach it. A `Deno.serve` callback is not testable, and the untestable half
// is exactly where an outage would otherwise read as healthy.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { createLivenessHandler } from "../_shared/notif-liveness-core.ts";

const handler = createLivenessHandler({
  env: (name) => Deno.env.get(name),
  readLiveness: async () => {
    const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await client.rpc("notif_digest_worker_liveness");
    if (error) throw new Error(error.message);
    return data;
  },
});

Deno.serve(handler);
