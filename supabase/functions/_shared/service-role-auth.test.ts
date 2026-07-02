import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { isServiceRoleRequest, resolveServiceRoleToken } from "./service-role-auth.ts";

const REAL_KEY = "real-service-role-key-abc123";

function b64url(obj: Record<string, unknown>): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A forged, UNSIGNED service_role JWT for this project (correct role + ref, junk signature). */
function forgedServiceRoleJwt(ref = "testref"): string {
  const header = b64url({ alg: "none", typ: "JWT" });
  const payload = b64url({ role: "service_role", ref });
  return `${header}.${payload}.not-a-real-signature`;
}

function withEnv(fn: () => void): void {
  const prevUrl = Deno.env.get("SUPABASE_URL");
  const prevKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_URL", "https://testref.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", REAL_KEY);
  try {
    fn();
  } finally {
    if (prevUrl === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", prevUrl);
    if (prevKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", prevKey);
  }
}

function req(headers: Record<string, string>): Request {
  return new Request("https://example.com", { method: "POST", headers });
}

// --- The P0 regression: a forged service_role JWT must NEVER pass. ---

Deno.test("forged service_role JWT (bearer == apikey, correct ref) is REJECTED", () => {
  withEnv(() => {
    const jwt = forgedServiceRoleJwt("testref");
    const r = req({ Authorization: `Bearer ${jwt}`, apikey: jwt });
    assertEquals(isServiceRoleRequest(r), false);
    assertEquals(resolveServiceRoleToken(r), null);
  });
});

Deno.test("forged service_role JWT as a bare Authorization value is REJECTED", () => {
  withEnv(() => {
    const jwt = forgedServiceRoleJwt("testref");
    const r = req({ Authorization: jwt, apikey: jwt });
    assertEquals(isServiceRoleRequest(r), false);
  });
});

// --- The real key still works for every legitimate header shape. ---

Deno.test("real service-role key via Bearer is accepted", () => {
  withEnv(() => {
    const r = req({ Authorization: `Bearer ${REAL_KEY}`, apikey: REAL_KEY });
    assertEquals(isServiceRoleRequest(r), true);
    assertEquals(resolveServiceRoleToken(r), REAL_KEY);
  });
});

Deno.test("real service-role key via apikey header only is accepted", () => {
  withEnv(() => {
    const r = req({ apikey: REAL_KEY });
    assertEquals(isServiceRoleRequest(r), true);
  });
});

Deno.test("real service-role key as a bare Authorization value is accepted", () => {
  withEnv(() => {
    const r = req({ Authorization: REAL_KEY });
    assertEquals(isServiceRoleRequest(r), true);
  });
});

// --- Everything else fails closed. ---

Deno.test("anon / random bearer token is rejected", () => {
  withEnv(() => {
    const r = req({ Authorization: "Bearer some-user-jwt", apikey: "anon-key" });
    assertEquals(isServiceRoleRequest(r), false);
    assertEquals(resolveServiceRoleToken(r), null);
  });
});

Deno.test("no headers at all is rejected", () => {
  withEnv(() => {
    assertEquals(isServiceRoleRequest(req({})), false);
  });
});

Deno.test("fails closed when SUPABASE_SERVICE_ROLE_KEY is unset", () => {
  const prev = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  try {
    // Even presenting the (now-unknown) real key must not pass when env is absent.
    const r = req({ Authorization: `Bearer ${REAL_KEY}`, apikey: REAL_KEY });
    assertEquals(isServiceRoleRequest(r), false);
    assertEquals(resolveServiceRoleToken(r), null);
  } finally {
    if (prev !== undefined) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", prev);
  }
});
