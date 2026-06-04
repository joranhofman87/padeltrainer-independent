import { assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import { requireUser } from "./auth.ts";

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
