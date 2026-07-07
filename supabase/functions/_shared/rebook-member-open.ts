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

const keyOf = (r: { player_id: string | null; guest_player_id: string | null }): string | null =>
  r.player_id ?? (r.guest_player_id ? `g:${r.guest_player_id}` : null);

export function computeMemberOpenAudience(
  claims: MemberOpenClaim[],
  priorityProfileIds: string[],
  opts: { excludeDecliners?: boolean } = {},
): MemberOpenRecipient[] {
  const excludeDecliners = opts.excludeDecliners ?? true;

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
    out.set(k, v.ref);
  }

  // Priority list — registered profiles. Dedupe against the cohort (same key); skip
  // anyone who already rebooked. A declined priority person is still invited (they're
  // explicitly promised priority on the freed seats).
  for (const pid of priorityProfileIds) {
    if (!pid) continue;
    if (byKey.get(pid)?.hasClaimed) continue;
    if (!out.has(pid)) out.set(pid, { player_id: pid, guest_player_id: null });
  }

  return [...out.values()];
}
