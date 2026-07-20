// Notification Foundation v2 — PR 9: record a GUEST's WhatsApp opt-in from a self-service
// booking flow.
//
// The guest ticked a box next to the phone number they just typed. The tenant is whatever the
// edge function already derived from the SLOT (or the registration), never anything the client
// sent — the client only ever supplies a boolean.
//
// Lives in one place because four flows need it (slot / cyclus / cart payments, and the cycle
// intake). Four copies of "resolve the person, then call the RPC" is four places for the next
// person-linking change to be half-applied.
//
// NEVER THROWS. A consent write must not be able to fail a booking the guest has paid for:
// getting a session reminder is worth far less than completing the purchase. It returns a
// reason instead, so the caller can log without deciding what to do.

/**
 * Structural, not the SDK's SupabaseClient. A remote `import type` from esm.sh drags this file
 * into the browser tsconfig graph the moment a vitest test imports it, and tsc cannot resolve
 * URL specifiers. Naming only what is used keeps the helper testable from src/test without an
 * `any` — and documents its whole surface: one table read and one RPC.
 *
 * Callers pass `supabase as unknown as ConsentWriteClient`: the real client's builders are
 * generic enough that checking them against this shape trips TS2589 (instantiation too deep).
 * The cast is at the call site rather than hidden here, so the narrowness stays visible.
 */
export interface ConsentWriteClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, value: string): {
        maybeSingle(): Promise<{ data: { person_id?: string | null } | null; error: { message: string } | null }>;
      };
    };
  };
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export type GuestOptInResult =
  | { ok: true; contactId: string }
  | { ok: false; reason: "not_requested" | "no_phone" | "no_person" | "no_tenant" | "rejected" | "error"; detail?: string };

export interface GuestOptInInput {
  /** The checkbox. Absent/false means do nothing at all — never opt in by default. */
  optIn: boolean | undefined;
  /** The number the guest typed, free-text; the RPC normalizes and rejects what it cannot. */
  phone: string | null | undefined;
  /** guest_players.id returned by resolveOrCreateGuestPlayer. */
  guestPlayerId: string;
  /** Derived SERVER-SIDE from the slot / registration. Exactly one is expected to be set. */
  academyProfileId?: string | null;
  trainerId?: string | null;
  /** Provenance recorded on the contact, e.g. 'public_booking'. */
  source: string;
}

export async function recordGuestWhatsAppOptIn(
  supabase: ConsentWriteClient,
  input: GuestOptInInput,
): Promise<GuestOptInResult> {
  // Unchecked box: not merely "skip the write" but never look anything up. An opt-in must be
  // an action the guest took.
  if (input.optIn !== true) return { ok: false, reason: "not_requested" };
  if (!input.phone || !input.phone.trim()) return { ok: false, reason: "no_phone" };
  if (!input.academyProfileId && !input.trainerId) return { ok: false, reason: "no_tenant" };

  try {
    // guest_players rows mint a persons row + person_links row via trigger in the same
    // transaction, so the link exists by the time we get here. Consent is person-keyed because
    // one human can be several guest_players rows across academies.
    const { data: link, error: linkErr } = await supabase
      .from("person_links")
      .select("person_id")
      .eq("guest_player_id", input.guestPlayerId)
      .maybeSingle();
    if (linkErr) return { ok: false, reason: "error", detail: linkErr.message };
    if (!link?.person_id) return { ok: false, reason: "no_person" };

    // service_role, so record_whatsapp_optin skips the relationship check — correct here, since
    // the tenant came off the slot rather than from the caller, and on the pay-first path the
    // booking does not exist yet.
    const { data, error } = await supabase.rpc("record_whatsapp_optin", {
      p_person_id: link.person_id,
      p_phone: input.phone,
      p_academy_profile_id: input.academyProfileId ?? null,
      p_trainer_id: input.trainerId ?? null,
      p_source: input.source,
    });
    if (error) return { ok: false, reason: "error", detail: error.message };
    // NULL means the RPC refused — an unnormalizable number, most likely. It fails closed by
    // design rather than guessing at a number, so this is a normal outcome, not an error.
    if (!data) return { ok: false, reason: "rejected" };

    return { ok: true, contactId: data as string };
  } catch (e) {
    return { ok: false, reason: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}
