/**
 * Audience for the "sessions have opened — you can book now" email fired when a
 * rebook round's MEMBER window opens (the second bucket). Pure + Deno-tested; the
 * notify-rebook-member-open edge function resolves names/emails and drops recipients
 * with no email.
 *
 * The audience is:
 *   • ORIGINAL-COHORT NON-REBOOKERS — people with a priority claim in the round who
 *     did NOT rebook (no 'claimed' claim). They have no seat yet, so we invite them
 *     to grab a freed one. By default explicit DECLINERS are excluded (they said no).
 *   • THE PRIORITY LIST — registered profile ids the academy promised priority, even
 *     if they declined an old slot (the promise is about the freed seats). Excluded
 *     only if they somehow already rebooked.
 * People who already rebooked are never emailed — they already have a seat.
 */

export interface MemberOpenClaim {
  player_id: string | null;
  guest_player_id: string | null;
  status: string; // pending | claimed | declined | expired | released
  response_intent?: string | null; // accept | decline | null
}

export interface MemberOpenRecipient {
  player_id: string | null;
  guest_player_id: string | null;
}

/** Stable per-person key, GUEST-FIRST (FAM-02 Level 1): a dual-key row belongs to the GUEST, so a
 *  child (guest_player_id) keys `g:<id>` — never the linked parent's player_id. A pure profile keys
 *  by its bare id, a pure guest as `g:<id>` — both UNCHANGED from before, so the RB03 already-notified
 *  keys persisted in cycles.settings stay byte-for-byte compatible; only a dual-key child's key moves
 *  from the parent's id to its own `g:<id>` (so a previously-collapsed child gets its one correct
 *  catch-up notification, then dedupes on retries). The notifier uses this for grouping, the
 *  name/email lookup, AND the persisted already-emailed set — one canonical key for all three. */
export const recipientKey = (r: { player_id: string | null; guest_player_id: string | null }): string | null =>
  r.guest_player_id ? `g:${r.guest_player_id}` : (r.player_id ?? null);

const keyOf = recipientKey;

/** Contact lookups for member-open recipients, keyed by RAW id (profileId / guestId). */
export interface MemberOpenContactMaps {
  profileName: Map<string, string>;      // profileId -> name
  profileEmail: Map<string, string>;     // profileId -> email
  guestName: Map<string, string>;        // guestId -> name
  guestOwnEmail: Map<string, string>;    // guestId -> the guest's OWN email
  guestLinkedEmail: Map<string, string>; // guestId -> the guest's linked_profile email
  guestLinked: Set<string>;              // guestIds that have a linked account (linked_profile_id)
}

/**
 * Resolve a member-open recipient's contact, GUEST-FIRST (FAM-02), with the repo's canonical guest
 * contact fallback and the correct CTA signal.
 *
 * name  — the guest's OWN name wins; the linked parent's name is the blank-name fallback.
 * email — the guest's OWN address, then their linked-profile address (an account), then the linked
 *         parent (via a dual-key ref's player_id). Matches effectiveGuestEmail / personContactEmail:
 *         a guest-only priority person with no personal email but a linked account is STILL delivered.
 * needsSignup — true ONLY for a genuinely accountless guest (a guest with no linked account and no
 *         linked parent). An account-backed recipient (a profile, a dual-key child, or a linked
 *         guest) must NOT get a "create an account" CTA sent to an address that already has one.
 *
 * Returns null when no deliverable email exists (the caller drops the recipient). Pure — unit-tested.
 */
export function resolveMemberOpenContact(
  ref: MemberOpenRecipient,
  maps: MemberOpenContactMaps,
): { name: string; email: string; needsSignup: boolean } | null {
  const gid = ref.guest_player_id ?? null;
  const pid = ref.player_id ?? null; // on a dual-key ref this is the LINKED PARENT profile id
  const name = (gid ? maps.guestName.get(gid) : undefined) || (pid ? maps.profileName.get(pid) : undefined) || "";
  const email =
    (gid ? maps.guestOwnEmail.get(gid) : undefined) ||
    (gid ? maps.guestLinkedEmail.get(gid) : undefined) ||
    (pid ? maps.profileEmail.get(pid) : undefined) ||
    null;
  if (!email) return null;
  const accountBacked = !!pid || (!!gid && maps.guestLinked.has(gid));
  return { name, email, needsSignup: !!gid && !accountBacked };
}

/**
 * Crash-recovery contract for ONE already-claimed member-open cycle: run `notify`, and RELEASE the
 * idempotency claim whenever the cycle could not be fully notified — a partial send (failed > 0) OR
 * a thrown DB read error — so a hiccup can never leave a cycle permanently claimed with its audience
 * unsent. Successes are recorded per-recipient (RB03), so a retry re-sends only the failures. An
 * unclaim failure is surfaced in `error` (released=false) so the caller can alert. Kept here
 * (Resend-free) so it is unit-testable without importing the edge entrypoint. `notify` throwing is
 * the load-bearing case: every recipient-discovery read in the real notifyCycle fails loud, and any
 * such throw lands here and releases the claim.
 */
export async function runClaimedCycle(
  // Minimal RPC surface — `unknown` return so the real SupabaseClient (a PostgrestFilterBuilder) and
  // a test fake both satisfy it; the awaited result is narrowed at the call below.
  supabase: { rpc: (name: string, args: Record<string, unknown>) => unknown },
  cycleId: string,
  notify: (cycleId: string) => Promise<{ sent: number; failed: number }>,
): Promise<{ sent: number; failed: number; released: boolean; error: string | null }> {
  const release = async (): Promise<string | null> => {
    const { error } = await (supabase.rpc("unclaim_rebook_member_open_notice", { _cycle_id: cycleId }) as Promise<{ error: unknown }>);
    return error ? `unclaim failed: ${(error as { message?: string })?.message ?? error}` : null;
  };
  try {
    const { sent, failed } = await notify(cycleId);
    if (failed > 0) {
      const relErr = await release();
      return { sent, failed, released: !relErr, error: relErr };
    }
    return { sent, failed, released: false, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const relErr = await release();
    return { sent: 0, failed: 0, released: !relErr, error: relErr ? `${msg}; ${relErr}` : msg };
  }
}

export function computeMemberOpenAudience(
  claims: MemberOpenClaim[],
  priorityProfileIds: string[],
  priorityGuestIds: string[] = [],
  opts: { excludeDecliners?: boolean; alreadyNotifiedKeys?: string[] } = {},
): MemberOpenRecipient[] {
  const excludeDecliners = opts.excludeDecliners ?? true;
  // RB03: recipients already emailed in a prior (partial) run are skipped, so a retry
  // only re-sends to the ones that failed — never a duplicate, never a silent drop.
  const alreadyNotified = new Set(opts.alreadyNotifiedKeys ?? []);

  // Collapse each cohort person to their round-level state.
  const byKey = new Map<string, { ref: MemberOpenRecipient; hasClaimed: boolean; hasDeclined: boolean }>();
  for (const c of claims) {
    const k = keyOf(c);
    if (!k) continue;
    const cur = byKey.get(k) ?? {
      ref: { player_id: c.player_id, guest_player_id: c.guest_player_id },
      hasClaimed: false,
      hasDeclined: false,
    };
    if (c.status === "claimed") cur.hasClaimed = true;
    if (c.status === "declined" || c.response_intent === "decline") cur.hasDeclined = true;
    byKey.set(k, cur);
  }

  const out = new Map<string, MemberOpenRecipient>();

  // Cohort non-rebookers (optionally excluding those who explicitly declined).
  for (const [k, v] of byKey) {
    if (v.hasClaimed) continue; // already has a seat
    if (excludeDecliners && v.hasDeclined) continue; // said no
    if (alreadyNotified.has(k)) continue; // RB03: emailed in a prior run
    out.set(k, v.ref);
  }

  // Priority list — registered profiles. Dedupe against the cohort (same key); skip
  // anyone who already rebooked. A declined priority person is still invited (they're
  // explicitly promised priority on the freed seats).
  for (const pid of priorityProfileIds) {
    if (!pid) continue;
    if (byKey.get(pid)?.hasClaimed) continue;
    if (alreadyNotified.has(pid)) continue; // RB03: emailed in a prior run
    if (!out.has(pid)) out.set(pid, { player_id: pid, guest_player_id: null });
  }

  // Priority list — accountless GUESTS (guest_players.id). Keyed g:<id> like a guest claim, so it
  // dedupes against a guest already in the cohort and against a prior run; a guest who already
  // rebooked is skipped. They get the same "create account & book" member-open email.
  for (const gid of priorityGuestIds) {
    if (!gid) continue;
    const k = `g:${gid}`;
    if (byKey.get(k)?.hasClaimed) continue;
    if (alreadyNotified.has(k)) continue; // RB03: emailed in a prior run
    if (!out.has(k)) out.set(k, { player_id: null, guest_player_id: gid });
  }

  return [...out.values()];
}
