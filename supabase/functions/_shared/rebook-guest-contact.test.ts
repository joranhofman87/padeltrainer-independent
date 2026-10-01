// The guest contact helper shared by all three manual rebook senders.
//
// Pass B §2: a guest is reached at their OWN email, or not at all. The account arm is gone — the
// RPC still returns the account_* columns (its shape is unchanged, and they are always null now)
// and this helper must NOT consult them even if a value appears there, which is what these
// assertions pin down.
import { assert, assertEquals } from "https://deno.land/std@0.190.0/testing/asserts.ts";
import {
  fetchGuestContacts, guestContactEmail, guestContactName, type GuestContactMap,
} from "./rebook-guest-contact.ts";

const row = (over: Partial<{ own_name: string | null; own_email: string | null; account_name: string | null; account_email: string | null; has_account: boolean }>) =>
  ({ guest_id: "g", own_name: null, own_email: null, account_name: null, account_email: null, has_account: false, ...over });
const mapOf = (r: ReturnType<typeof row>): GuestContactMap => new Map([["g", { ...r, guest_id: "g" }]]);

Deno.test("guestContactEmail: the guest's OWN email is used", () => {
  assertEquals(guestContactEmail("g", mapOf(row({ own_email: "own@x.com", account_email: "acc@x.com" }))), "own@x.com");
});
Deno.test("guestContactEmail: an account email is NEVER used, even if one is present", () => {
  // the exact misrouting this closes: a claim token addressed to whoever once shared the address
  assertEquals(guestContactEmail("g", mapOf(row({ account_email: "acc@x.com", has_account: true }))), null);
});
Deno.test("guestContactEmail: no own email → null (skip; never the raw player_id, never an account)", () => {
  assertEquals(guestContactEmail("g", mapOf(row({}))), null);
  assertEquals(guestContactEmail("unknown", mapOf(row({ own_email: "own@x.com" }))), null);
  assertEquals(guestContactEmail(null, new Map()), null);
});
Deno.test("guestContactName: own name only — a blank name is not filled in from an account", () => {
  assertEquals(guestContactName("g", mapOf(row({ own_name: "Own", account_name: "Acct" }))), "Own");
  assertEquals(guestContactName("g", mapOf(row({ account_name: "Acct" }))), "");
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
