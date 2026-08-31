// Invitation metadata assembly for send-priority-claim-invitation, extracted so the read-error and
// pagination paths are unit-testable with a fake db (the handler calls serve() and has no harness).
// Codex round-6 #1/#3: EVERY metadata read (slots, academies, cycles, group-claims) fails LOUD, and
// the group-claims read is PAGINATED so a >1000-row round can't silently truncate the session counts.

import { fetchAllInChunks } from "./paginate.ts";

export interface SlotRow {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  price_per_session: number | null;
  priority_window_ends_at: string | null;
  academy_profile_id: string | null;
}

export interface GroupInfo {
  sessions: number;
  firstStart: string;
  lastStart: string;
}

export interface InvitationMetadata {
  slotMap: Map<string, SlotRow>;
  tzByAcademy: Map<string, string>;
  nameByAcademy: Map<string, string>;
  replyToByAcademy: Map<string, string>;
  upfrontCycleIds: Set<string>;
  startDateByCycle: Map<string, string>;
  groupInfo: Map<string, GroupInfo>; // key: `${rebook_group_id}|${personKey}`
}

type ReadResult = { data: unknown; error: { message?: string } | null };
interface FilterQuery extends PromiseLike<ReadResult> {
  eq(col: string, val: unknown): FilterQuery;
  range(from: number, to: number): FilterQuery;
  // Keyset pagination for the mutable `status='pending'` group read: `.gt` on the key, a stable
  // `.order`, and a bounded `.limit`. Offsets are unsafe for a filter rows can leave mid-read.
  gt(col: string, val: unknown): FilterQuery;
  order(col: string): FilterQuery;
  limit(n: number): FilterQuery;
}
export interface InvitationDb {
  from(table: string): { select(cols: string): { in(col: string, vals: readonly unknown[]): FilterQuery } };
}

/**
 * The series key: the group plus the EXACT identity pair, which is what `respond_to_priority_claim`
 * books. Nulls are part of the key — `(P, NULL)`, `(NULL, G)` and `(P, G)` are three different
 * series, exactly as `IS NOT DISTINCT FROM` treats them.
 */
export function groupSeriesKey(
  row: { rebook_group_id: string | null; player_id: string | null; guest_player_id: string | null },
): string {
  return `${row.rebook_group_id}|p:${row.player_id ?? ""}|g:${row.guest_player_id ?? ""}`;
}

const isPlausibleEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function throwOnError(label: string, error: { message?: string } | null): void {
  if (error) throw new Error(`${label} read failed: ${error.message ?? String(error)}`);
}

/**
 * Read + assemble every piece of metadata the invitation email needs, keyed for guest-first identity.
 * Throws (→ the handler's catch → 500 + Slack) on ANY read error, so a transient failure can never
 * silently mark every invite "skipped" (slots), send the wrong deferred-payment copy (cycles), or
 * describe a series as a single session (group-claims).
 */
export async function loadInvitationMetadata(
  db: InvitationDb,
  slotIds: string[],
  groupIds: string[],
): Promise<InvitationMetadata> {
  const slotMap = new Map<string, SlotRow>();
  const tzByAcademy = new Map<string, string>();
  const nameByAcademy = new Map<string, string>();
  const replyToByAcademy = new Map<string, string>();
  const upfrontCycleIds = new Set<string>();
  const startDateByCycle = new Map<string, string>();
  const groupInfo = new Map<string, GroupInfo>();

  if (slotIds.length > 0) {
    const { data: slots, error: slotErr } = await db
      .from("availability_slots")
      .select("id, start_time, end_time, cyclus_id, cyclus_name, price_per_session, priority_window_ends_at, academy_profile_id")
      .in("id", slotIds);
    throwOnError("slot", slotErr);
    for (const s of (slots ?? []) as SlotRow[]) slotMap.set(s.id, s);
  }

  const acadIds = [...new Set([...slotMap.values()].map((s) => s.academy_profile_id).filter((id): id is string => !!id))];
  if (acadIds.length > 0) {
    const { data: acads, error: acadErr } = await db
      .from("academy_profiles")
      .select("id, timezone, name, business_name, contact_email, invoice_reply_to_email")
      .in("id", acadIds);
    throwOnError("academy metadata", acadErr);
    for (const a of (acads ?? []) as Array<{ id: string; timezone: string | null; name: string | null; business_name: string | null; contact_email: string | null; invoice_reply_to_email: string | null }>) {
      tzByAcademy.set(a.id, a.timezone || "Europe/Amsterdam");
      const display = (a.business_name || a.name || "").trim();
      if (display) nameByAcademy.set(a.id, display);
      const replyTo = (a.invoice_reply_to_email || a.contact_email || "").trim();
      if (isPlausibleEmail(replyTo)) replyToByAcademy.set(a.id, replyTo);
    }
  }

  const cyclusIds = [...new Set([...slotMap.values()].map((s) => s.cyclus_id).filter((id): id is string => !!id))];
  if (cyclusIds.length > 0) {
    const { data: cycleRows, error: cycleErr } = await db
      .from("cycles")
      .select("id, settings, start_date")
      .in("id", cyclusIds);
    throwOnError("cycle metadata", cycleErr);
    for (const row of (cycleRows ?? []) as Array<{ id: string; settings: Record<string, unknown> | null; start_date: string | null }>) {
      if ((row.settings || {}).rebook_payment_mode === "upfront") upfrontCycleIds.add(row.id);
      if (row.start_date) startDateByCycle.set(row.id, row.start_date);
    }
  }

  if (groupIds.length > 0) {
    // PAGINATED (Codex round-6 #3): a big round's group fans out to all members × all weeks of pending
    // claims — an un-paginated read caps at ~1000 and undercounts sessions / shortens the date range.
    //
    // KEYSET, not offsets. This filter is `status='pending'`, which is exactly the mutable kind
    // `fetchAllRows` documents itself as unsafe for: a sibling answering between two pages shifts
    // every later offset and silently skips a row. The series sentence would then describe a
    // different set than the one the server aggregates in a single statement, and the enqueue would
    // refuse the invitation. `fetchAllInChunks` is the shared implementation the other discovery
    // reads already use — it bounds the `.in()` list and keysets each batch by `id`.
    const { rows: groupClaims, error: gcErr } = await fetchAllInChunks<{ id: string; rebook_group_id: string | null; player_id: string | null; guest_player_id: string | null; availability_slots: { start_time: string } | null }>(
      groupIds,
      (chunkIds, after, limit) => {
        let q = db
          .from("slot_priority_claims")
          .select("id, rebook_group_id, player_id, guest_player_id, status, availability_slots:slot_id(start_time)")
          .in("rebook_group_id", chunkIds)
          .eq("status", "pending");
        if (after) q = q.gt("id", after);
        return q.order("id").limit(limit);
      },
      (row) => row.id,
    );
    throwOnError("group-claims", gcErr);
    for (const gc of groupClaims) {
      if (!gc.rebook_group_id || !gc.availability_slots) continue;
      // PAIR-EXACT, because that is the set the ACCEPT books
      // (`OWNER_DECISION_D7_RUNTIME_PRIORITY_INVITE_SEMANTICS_V1`).
      //
      // This used to be `personKeyOf`, which is guest-first: a dual-keyed row `(P, G)` and a
      // guest-only row `(NULL, G)` both key on `G` and aggregated together. But
      // `respond_to_priority_claim` selects siblings with `player_id IS NOT DISTINCT FROM` AND
      // `guest_player_id IS NOT DISTINCT FROM`, so it books only the rows whose PAIR matches — and
      // the mail was promising a series one click could not deliver. `personKeyOf` still governs
      // dedup and display elsewhere in this sender; only the SERIES key is pair-exact.
      const key = groupSeriesKey(gc);
      const start = gc.availability_slots.start_time;
      const cur = groupInfo.get(key);
      if (!cur) groupInfo.set(key, { sessions: 1, firstStart: start, lastStart: start });
      else {
        cur.sessions++;
        if (start < cur.firstStart) cur.firstStart = start;
        if (start > cur.lastStart) cur.lastStart = start;
      }
    }
  }

  return { slotMap, tzByAcademy, nameByAcademy, replyToByAcademy, upfrontCycleIds, startDateByCycle, groupInfo };
}
