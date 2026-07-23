// The verified guest contact helper shared by all three manual rebook senders (Codex round-3 #1):
// a guest is reached at their OWN email then their VERIFIED account (person_links → twin → linked,
// resolved in SQL), NEVER the raw claim.player_id. The precedence itself is proven in
// rebookIdentityGuestFirst.pglite (guest_verified_account_profile); here we prove the edge helper's
// own → account → skip resolution + that fetchGuestContacts fails loud and de-dups.
import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  fetchGuestContacts, guestContactEmail, guestContactName, type GuestContactMap,
} from "./rebook-guest-contact.ts";

const row = (over: Partial<{ own_name: string | null; own_email: string | null; account_name: string | null; account_email: string | null; has_account: boolean }>) =>
  ({ guest_id: "g", own_name: null, own_email: null, account_name: null, account_email: null, has_account: false, ...over });
const mapOf = (r: ReturnType<typeof row>): GuestContactMap => new Map([["g", { ...r, guest_id: "g" }]]);

Deno.test("guestContactEmail: OWN email wins over the account email", () => {
  assertEquals(guestContactEmail("g", mapOf(row({ own_email: "own@x.com", account_email: "acc@x.com" }))), "own@x.com");
});
Deno.test("guestContactEmail: falls back to the VERIFIED account email when the guest has none of their own", () => {
  assertEquals(guestContactEmail("g", mapOf(row({ account_email: "acc@x.com", has_account: true }))), "acc@x.com");
});
Deno.test("guestContactEmail: no own + no account → null (skip; NEVER the raw player_id)", () => {
  assertEquals(guestContactEmail("g", mapOf(row({}))), null);
  assertEquals(guestContactEmail("unknown", mapOf(row({ own_email: "own@x.com" }))), null);
  assertEquals(guestContactEmail(null, new Map()), null);
});
Deno.test("guestContactName: own name wins, then the account name, then empty", () => {
  assertEquals(guestContactName("g", mapOf(row({ own_name: "Own", account_name: "Acct" }))), "Own");
  assertEquals(guestContactName("g", mapOf(row({ account_name: "Acct" }))), "Acct");
  assertEquals(guestContactName("g", mapOf(row({}))), "");
});

// A minimal fake rpc client.
const fakeRpc = (result: { data: unknown; error: unknown }, calls: unknown[] = []) => ({
  rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return Promise.resolve(result); },
});

Deno.test("fetchGuestContacts: builds the map, de-dups + filters ids, and passes them to the RPC", async () => {
  const calls: unknown[] = [];
  const client = fakeRpc({ data: [row({ own_email: "a@x.com" })].map((r) => ({ ...r, guest_id: "g1" })), error: null }, calls);
  const map = await fetchGuestContacts(client, ["g1", "g1", null, undefined, "g2"]);
  assertEquals(map.get("g1")?.own_email, "a@x.com");
  const call = calls[0] as { name: string; args: { _guest_ids: string[] } };
  assertEquals(call.name, "resolve_guest_member_contacts");
  assertEquals([...call.args._guest_ids].sort(), ["g1", "g2"]); // de-duped + nulls dropped
});
Deno.test("fetchGuestContacts: an empty id list makes NO RPC call", async () => {
  const calls: unknown[] = [];
  const client = fakeRpc({ data: [], error: null }, calls);
  const map = await fetchGuestContacts(client, [null, undefined]);
  assertEquals(map.size, 0);
  assertEquals(calls.length, 0);
});
Deno.test("fetchGuestContacts: FAILS LOUD on an RPC error (never a silent empty map)", async () => {
  const client = fakeRpc({ data: null, error: { message: "boom" } });
  let threw = false;
  try { await fetchGuestContacts(client, ["g1"]); } catch (e) { threw = true; assert(String(e).includes("guest contact resolution failed")); }
  assert(threw, "expected fetchGuestContacts to throw on an RPC error");
});
