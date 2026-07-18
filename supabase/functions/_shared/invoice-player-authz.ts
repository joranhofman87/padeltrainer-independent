// Phase 3.5a: the PLAYER-side invoice access decision for generate-invoice,
// extracted so the exact arm set is unit-testable (the adversarial pass caught
// three real bugs in the inline version: the player arm bypassed the split-
// pending freeze, the reader's bridge arm had no counterpart, and the freeze
// lookup failed open).
//
// ARM SET — mirrors get_my_invoices() (migration 20260903100000), with the
// split-pending FREEZE applied OUTSIDE all arms:
//   0. freeze: invoice has a guest with a pending twin-split/email-move review
//      → NO player-side arm grants (the guest may be a DIFFERENT human; a
//      both-keyed invoice's player_id came from the email linker). Fails
//      CLOSED: a lookup error counts as frozen.
//   1. player arm: invoice.player_id equals the caller's auth id or profile id.
//   2. person arm: the guest's person_links person == the caller profile's.
//   3. twin/linked bridge: guest.twin_of_profile_id = caller profile, or (no
//      twin stamp AND guest.linked_profile_id = caller profile) — verbatim the
//      reader's bridge.
//   4. legacy email fallback: guest email == caller email. DELIBERATE EXCEPTION
//      to the "same arms as the reader" doctrine — the reader does NOT have an
//      email arm. Kept for the guest-paid-then-signed-up window before the
//      linker runs (their invoice isn't LISTED yet, but their payment-link PDF
//      keeps working). Freeze-gated like everything else.

/** Minimal query surface (the service-role supabase client satisfies it). */
export interface AuthzClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): AuthzFilter;
    };
  };
}
interface AuthzFilter {
  eq(col: string, val: string): AuthzFilter;
  in(col: string, vals: string[]): AuthzFilter;
  limit(n: number): AuthzFilter;
  single(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
  maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: unknown }>;
}

export interface InvoiceRefs {
  player_id: string | null;
  guest_player_id: string | null;
}

export interface CallerIdentity {
  id: string | null;
  email: string | null;
}

/** True when the caller may access this invoice AS THE PLAYER. */
export async function resolveInvoicePlayerAccess(
  invoice: InvoiceRefs,
  user: CallerIdentity,
  supabase: AuthzClient,
): Promise<boolean> {
  // 0. Freeze OUTSIDE the arms — fail CLOSED on lookup error.
  if (invoice.guest_player_id) {
    const { data: frozen, error: frozenErr } = await supabase
      .from('person_merge_review')
      .select('id')
      .eq('guest_player_id', invoice.guest_player_id)
      .eq('status', 'pending')
      .in('kind', ['twin_detached_needs_split', 'merged_guest_email_moved'])
      .limit(1)
      .maybeSingle();
    if (frozen || frozenErr) return false;
  }

  // 1. player arm.
  if (invoice.player_id && user.id && invoice.player_id === user.id) return true;
  if (invoice.player_id && user.id) {
    const { data: playerProfile } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('id', invoice.player_id)
      .single();
    if (playerProfile?.user_id === user.id) return true;
  }

  if (!invoice.guest_player_id || !user.id) {
    // No guest side (or anonymous caller): only the player arm could grant.
    return false;
  }

  const { data: callerProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  const { data: guestRow } = await supabase
    .from('guest_players')
    .select('email, twin_of_profile_id, linked_profile_id')
    .eq('id', invoice.guest_player_id)
    .maybeSingle();

  // 2. person arm — service-role client reads the RLS-locked person_links.
  if (callerProfile?.id) {
    const { data: guestLink } = await supabase
      .from('person_links')
      .select('person_id')
      .eq('guest_player_id', invoice.guest_player_id)
      .maybeSingle();
    if (guestLink?.person_id) {
      const { data: profileLink } = await supabase
        .from('person_links')
        .select('person_id')
        .eq('profile_id', callerProfile.id as string)
        .maybeSingle();
      if (profileLink?.person_id === guestLink.person_id) return true;
    }
  }

  // 3. twin/linked bridge (verbatim the reader's bridge arm).
  if (callerProfile?.id && guestRow) {
    if (
      guestRow.twin_of_profile_id === callerProfile.id ||
      (guestRow.twin_of_profile_id === null && guestRow.linked_profile_id === callerProfile.id)
    ) {
      return true;
    }
  }

  // 4. legacy email fallback (deliberate exception — see header).
  if (
    user.email && guestRow?.email &&
    String(guestRow.email).toLowerCase() === user.email.toLowerCase()
  ) {
    return true;
  }

  return false;
}
