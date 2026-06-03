import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FN_URL = `${SUPABASE_URL}/functions/v1/create-invoice-payment`;

Deno.test("rejects request without publicToken", async () => {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ invoiceId: "00000000-0000-0000-0000-000000000000" }),
  });
  const body = await res.json();
  assertEquals(res.status, 400);
  assertEquals(body.error, "publicToken required");
});

Deno.test("rejects invalid publicToken", async () => {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      invoiceId: "00000000-0000-0000-0000-000000000000",
      publicToken: "invalid-token-not-in-db",
    }),
  });
  const body = await res.json();
  assertEquals(res.status, 404);
  assertEquals(body.error, "Invoice not found");
});
