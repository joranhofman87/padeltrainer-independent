import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { requireUser } from "./auth.ts";

// requireUser builds a service-role client up-front, so it needs these to be set. A dead URL keeps
// the (unreachable) token lookup fast: a missing token short-circuits to 401 with no network, and a
// bad token fails the auth lookup against the dead URL → 401. Neither path reaches a real backend.
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");

Deno.test("requireUser returns 401 when Authorization is missing", async () => {
  const req = new Request("https://example.com", { method: "POST" });
  const result = await requireUser(req);
  assertEquals(result instanceof Response, true);
  if (result instanceof Response) {
    assertEquals(result.status, 401);
    const body = await result.json();
    assertEquals(body.error, "unauthorized");
    assertEquals(body.message, "Please log in again.");
  }
});

Deno.test("requireUser returns 401 for invalid bearer token", async () => {
  const req = new Request("https://example.com", {
    method: "POST",
    headers: { Authorization: "Bearer not-a-valid-jwt" },
  });
  const result = await requireUser(req);
  assertEquals(result instanceof Response, true);
  if (result instanceof Response) {
    assertEquals(result.status, 401);
    const body = await result.json();
    assertEquals(body.error, "unauthorized");
  }
});
