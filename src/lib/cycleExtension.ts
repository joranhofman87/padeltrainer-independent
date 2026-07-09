import { localWallTimeToUtc, MAX_PLANNED_SLOTS, SlotPlanError } from '@/lib/slotPlan';
import { supabase } from '@/lib/supabaseClient';
import { insertAvailabilitySlots } from '@/lib/slots';
import { insertBookings } from '@/lib/bookings';
import { updateCycle } from '@/lib/cycles';
import { deleteUnbookedSlots } from '@/lib/cycleWrites';
import { cancelBookingsAndDeleteSlots } from '@/lib/slotDeleteGuard';
import { CAPACITY_OCCUPYING_STATUSES } from '@/lib/lessons';
import { syncInvoicesAfterAddPlayer, type AddPlayerBookingRow } from '@/lib/invoiceAfterAddPlayer';

/**
 * Pure planner for EXTENDING an existing cycle to a later end date by replicating its weekly
 * pattern. The rebooking cohort picker keys off a cycle's LAST session date, so an academy needs to
 * lengthen a cycle that "ends a week too early" by generating real sessions — not just editing a
 * date field. This takes the cycle's existing slots + a target end date and returns the new slots to
 * create: every slot in the cycle's final week projected forward week-by-week, on the same weekday +
 * local wall-clock time, copying the template slot's attributes (the caller fills those in). DST is
 * handled via slotPlan's localWallTimeToUtc so a session keeps its local time across the Oct/Mar
 * switch. Dates that already have a slot at that exact instant are skipped (safe to re-run).
 *
 * Scope: weekly cadence only (cycles are weekly); no holiday-skipping on the generated weeks (the
 * owner can trim a holiday week afterwards). Shortening a cycle is the existing trim path, not here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The minimal slot shape the date math needs; the caller carries the full row by `id`. */
export interface ExtensionSlotInput {
  id: string;
  /** UTC ISO start. */
  start_time: string;
  /** UTC ISO end. */
  end_time: string;
}

export interface PlannedExtensionSlot {
  start_time: string;
  end_time: string;
  /** The existing slot whose attributes the new slot should copy. */
  templateId: string;
}

interface LocalParts {
  y: number;
  mo: number; // 0-based
  d: number;
  h: number;
  mi: number;
}

/** UTC instant → its local calendar/clock parts in `tz` (inverse of localWallTimeToUtc). */
function utcToLocalParts(iso: string, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(iso))) p[part.type] = part.value;
  return {
    y: Number(p.year),
    mo: Number(p.month) - 1,
    d: Number(p.day),
    h: Number(p.hour === '24' ? '0' : p.hour), // Intl can emit '24' for midnight
    mi: Number(p.minute),
  };
}

/** Local calendar date → an integer day number (UTC-midnight based, tz-independent). */
function dayNumber(y: number, mo: number, d: number): number {
  return Math.round(Date.UTC(y, mo, d) / DAY_MS);
}

/** Integer day number → local calendar date (y, 0-based month, d). */
function fromDayNumber(n: number): { y: number; mo: number; d: number } {
  const dt = new Date(n * DAY_MS);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate() };
}

/**
 * Plan the slots to ADD so the cycle runs through `newEndDate` (yyyy-mm-dd, inclusive, local `tz`).
 * Returns [] when there's nothing to extend (no slots, or the target isn't after the current last
 * session). Throws SlotPlanError on a malformed end date or if the result would exceed the cap.
 */
export function planCycleExtension(
  existing: ExtensionSlotInput[],
  newEndDate: string,
  timezone: string,
): PlannedExtensionSlot[] {
  if (!timezone) throw new SlotPlanError('timezone is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newEndDate ?? '')) {
    throw new SlotPlanError(`newEndDate must be yyyy-mm-dd (got ${JSON.stringify(newEndDate)})`);
  }
  if (existing.length === 0) return [];

  const [ey, emo, ed] = newEndDate.split('-').map(Number);
  const endDayNum = dayNumber(ey, emo - 1, ed);

  // Local parts + day number + duration for every existing slot, and the cycle's last session day.
  const meta = existing.map((s) => {
    const lp = utcToLocalParts(s.start_time, timezone);
    return {
      slot: s,
      lp,
      dayNum: dayNumber(lp.y, lp.mo, lp.d),
      durationMs: new Date(s.end_time).getTime() - new Date(s.start_time).getTime(),
      startMs: new Date(s.start_time).getTime(),
    };
  });
  const lastDayNum = Math.max(...meta.map((m) => m.dayNum));

  // Nothing to add if the target isn't strictly after the current last session (shorten ≠ extend).
  if (endDayNum <= lastDayNum) return [];

  // Template = the cycle's FINAL week (its last 7 days). Replicating this multiset forward
  // reproduces every weekday + parallel court the cycle ends with.
  const template = meta.filter((m) => m.dayNum >= lastDayNum - 6);

  // Dedup: never create a second slot at an instant that already exists.
  const existingStartMs = new Set(meta.map((m) => m.startMs));

  const out: PlannedExtensionSlot[] = [];
  for (const m of template) {
    for (let k = 1; ; k++) {
      const targetDayNum = m.dayNum + 7 * k;
      if (targetDayNum > endDayNum) break;
      const { y, mo, d } = fromDayNumber(targetDayNum);
      const start = localWallTimeToUtc(y, mo, d, m.lp.h, m.lp.mi, timezone);
      if (existingStartMs.has(start.getTime())) continue; // already there
      const end = new Date(start.getTime() + m.durationMs);
      out.push({ start_time: start.toISOString(), end_time: end.toISOString(), templateId: m.slot.id });
      if (out.length > MAX_PLANNED_SLOTS) {
        throw new SlotPlanError(`Extension would create more than ${MAX_PLANNED_SLOTS} sessions — shorten the end date.`);
      }
    }
  }

  out.sort((a, b) => a.start_time.localeCompare(b.start_time));
  return out;
}

/**
 * Columns never copied onto a generated slot. Identity/audit (id/created_at/updated_at) PLUS the
 * rebooking PRIORITY/MEMBER/RELEASE markers: when the cycle being extended was itself born from a
 * rebook cohort copy (`bulkCopySlotsToCycle`), every slot carries priority/member windows, a
 * `source_cycle_id`, and a `public_release_status` of `'held'`/`'pending_admin_review'`. Replicating
 * those onto the new weeks would silently HIDE them (member-window + source_cycle visibility gating)
 * or make them UNBOOKABLE (the slot-tier trigger raises `slot_not_released` for self-service bookings
 * on a non-released slot). Omitting them resets each to its column default — NULL for the
 * windows/source, `'auto_release_scheduled'` for `public_release_status` — i.e. a plain,
 * immediately-bookable public session, identical to a freshly generated slot. For a normal
 * (non-rebook) cycle these are already NULL/default, so omitting is a no-op there. `lesson_id` is a
 * dead/legacy column no current write path sets; reset it too for safety. (Note: `is_public` IS still
 * copied — a private cycle's new weeks stay private — visibility-tier gating is a separate layer.)
 */
const COPY_OMIT = new Set([
  'id', 'created_at', 'updated_at',
  'priority_source_slot_id', 'priority_window_starts_at', 'priority_window_ends_at',
  'member_window_starts_at', 'member_window_ends_at',
  'source_cycle_id', 'public_release_status',
  'lesson_id',
]);

type SlotRow = Record<string, unknown> & { id: string; start_time: string; end_time: string };

/** The academy/trainer timezone for a cycle's owner (defaults Europe/Amsterdam — NEVER browser tz). */
async function getCycleTimezone(ownerType: string, ownerId: string): Promise<string> {
  const table = ownerType === 'academy' ? 'academy_profiles' : 'trainer_profiles';
  const { data } = await supabase.from(table).select('timezone').eq('id', ownerId).maybeSingle();
  return (data as { timezone?: string } | null)?.timezone || 'Europe/Amsterdam';
}

/** Load the cycle's slots + its owner timezone — the context the planner needs. Null = no cycle. */
async function loadExtensionContext(cycleId: string): Promise<{ slots: SlotRow[]; tz: string } | null> {
  const { data: cyc } = await supabase
    .from('cycles')
    .select('owner_type, owner_id')
    .eq('id', cycleId)
    .maybeSingle();
  if (!cyc) return null;
  const tz = await getCycleTimezone((cyc as { owner_type: string }).owner_type, (cyc as { owner_id: string }).owner_id);
  const { data, error } = await supabase.from('availability_slots').select('*').eq('cyclus_id', cycleId);
  if (error) throw error;
  return { slots: (data ?? []) as SlotRow[], tz };
}

export interface CycleExtensionPreview {
  /** How many new sessions extending to the target end date would create. */
  count: number;
  /** UTC ISO of the first/last new session (null when count === 0). */
  firstStart: string | null;
  lastStart: string | null;
}

/** Preview (client-side, pure planner) how many sessions an extension to `newEndDate` would add. */
export async function previewCycleExtension(cycleId: string, newEndDate: string): Promise<CycleExtensionPreview> {
  const ctx = await loadExtensionContext(cycleId);
  if (!ctx || ctx.slots.length === 0) return { count: 0, firstStart: null, lastStart: null };
  const planned = planCycleExtension(
    ctx.slots.map((s) => ({ id: s.id, start_time: s.start_time, end_time: s.end_time })),
    newEndDate,
    ctx.tz,
  );
  return {
    count: planned.length,
    firstStart: planned[0]?.start_time ?? null,
    lastStart: planned[planned.length - 1]?.start_time ?? null,
  };
}

export interface ExtendCycleResult {
  /** Number of new sessions generated. */
  added: number;
}

/** A roster booking on a template slot — the subset we copy forward onto a new session. */
export interface TemplateRosterBooking {
  player_id: string | null;
  guest_player_id: string | null;
  payment_amount: number | null;
  original_amount: number | null;
  discount_amount: number | null;
  discount_reason: string | null;
  notes: string | null;
  status: string;
}

/**
 * Build the booking rows that attach a template slot's roster to a NEW session. Pure (exported for
 * tests). Each new booking keeps the person (player_id XOR guest_player_id), their enrolment status,
 * and their exact per-slot amount + discount (an identical slot with the identical roster owes the
 * same). The owner chooses the new sessions' payment status:
 *  - default (paid: false) → 'pending' (openstaand): billed by the invoice sync.
 *  - paid: true → 'paid' + paid_externally + paid_at (settled outside — no invoice), matching the
 *    app's canonical mark-paid (bookings.ts).
 * The template's own paid state is never inherited — the choice is explicit.
 */
export function buildRosterCopyRows(
  newSlotId: string,
  templateBookings: TemplateRosterBooking[],
  opts: { paid?: boolean; paidAtIso?: string | null } = {},
): Record<string, unknown>[] {
  const paid = opts.paid === true;
  return templateBookings.map((b) => ({
    slot_id: newSlotId,
    player_id: b.player_id ?? null,
    guest_player_id: b.guest_player_id ?? null,
    status: b.status,
    payment_status: paid ? 'paid' : 'pending',
    paid_at: paid ? (opts.paidAtIso ?? null) : null,
    paid_externally: paid,
    payment_amount: b.payment_amount ?? null,
    original_amount: b.original_amount ?? null,
    discount_amount: b.discount_amount ?? 0,
    discount_reason: b.discount_reason ?? null,
    notes: b.notes ?? null,
  }));
}

/** Stable key matching a NEW slot back to the TEMPLATE it was projected from — trainer + the exact
 *  instant (epoch, so a Postgres timestamptz round-trip format change can't break the match). */
const rosterMatchKey = (trainerId: unknown, startTime: string): string =>
  `${String(trainerId ?? '')}|${new Date(startTime).getTime()}`;

/**
 * Attach each new slot's roster: copy its template slot's live (capacity-occupying) bookings —
 * registered players AND guests — onto the new session (via buildRosterCopyRows), then sync invoices
 * so the newly-attached players are billed for the new sessions (unless skipInvoices).
 */
async function attachTemplateRosterToNewSlots(
  cycleId: string,
  insertedSlots: Array<{ id: string; trainer_id: unknown; start_time: string }>,
  keyToTemplateId: Map<string, string>,
  splitPayment: boolean,
  skipInvoices: boolean,
  newSessionPaid: boolean,
): Promise<void> {
  const pairs = insertedSlots
    .map((s) => ({ newSlotId: s.id, templateId: keyToTemplateId.get(rosterMatchKey(s.trainer_id, s.start_time)) }))
    .filter((x): x is { newSlotId: string; templateId: string } => !!x.templateId);
  const templateIds = [...new Set(pairs.map((p) => p.templateId))];
  if (templateIds.length === 0) return;

  const { data: tmplBookings, error: readErr } = await supabase
    .from('bookings')
    .select('slot_id, player_id, guest_player_id, payment_amount, original_amount, discount_amount, discount_reason, notes, status')
    .in('slot_id', templateIds)
    .in('status', CAPACITY_OCCUPYING_STATUSES as unknown as string[]);
  if (readErr) throw readErr;

  const rosterByTemplate = new Map<string, TemplateRosterBooking[]>();
  for (const b of (tmplBookings ?? []) as Array<TemplateRosterBooking & { slot_id: string }>) {
    const list = rosterByTemplate.get(b.slot_id) ?? [];
    list.push(b);
    rosterByTemplate.set(b.slot_id, list);
  }

  const paidAtIso = newSessionPaid ? new Date().toISOString() : null;
  const rows: Record<string, unknown>[] = [];
  for (const { newSlotId, templateId } of pairs) {
    rows.push(...buildRosterCopyRows(newSlotId, rosterByTemplate.get(templateId) ?? [], { paid: newSessionPaid, paidAtIso }));
  }
  if (rows.length === 0) return;

  const { data: inserted, error: insErr } = await insertBookings(
    rows, supabase, 'id, slot_id, player_id, guest_player_id, payment_amount, payment_status, paid_externally',
  );
  if (insErr) throw insErr;

  await syncInvoicesAfterAddPlayer({
    newBookings: (inserted ?? []) as AddPlayerBookingRow[],
    splitPayment,
    slotIds: insertedSlots.map((s) => s.id),
    cyclusId: cycleId,
    // Paid sessions are settled externally → no invoice at all (they're non-chargeable anyway).
    skipInvoices: skipInvoices || newSessionPaid,
  });
}

/**
 * Lengthen a cycle so it runs through `newEndDate`: generate the missing weekly sessions (every
 * series in the cycle's final week, projected forward) and bump the cycle's end_date. Each new slot
 * copies its template slot's attributes (price, capacity, court, public/private, rating, extra_costs,
 * split_payment, …) so the new weeks match the existing ones — but the rebooking priority/member/
 * release markers are RESET (see COPY_OMIT), so generated sessions are plainly bookable rather than
 * inheriting a stale cohort hold from a rebook-born cycle. Invoice-safe:
 * it only inserts new (booking-free) slots and updates one date field; it never touches existing
 * bookings, invoices, or the cycle's total_price (per-session price is carried on each slot). When
 * the target isn't after the current last session it just records the end_date (use the trim path to
 * shorten). The timezone is resolved from the cycle's owner (academy/trainer), never the browser.
 */
export async function extendCycleToEndDate(
  cycleId: string,
  newEndDate: string,
  opts: { skipInvoices?: boolean; newSessionStatus?: 'paid' | 'pending' } = {},
): Promise<ExtendCycleResult> {
  const ctx = await loadExtensionContext(cycleId);
  if (!ctx || ctx.slots.length === 0) return { added: 0 };

  const planned = planCycleExtension(
    ctx.slots.map((s) => ({ id: s.id, start_time: s.start_time, end_time: s.end_time })),
    newEndDate,
    ctx.tz,
  );

  // Always record the new end date (even when no sessions are added — e.g. it already reaches it).
  await updateCycle(cycleId, { end_date: newEndDate });
  if (planned.length === 0) return { added: 0 };

  const byId = new Map(ctx.slots.map((s) => [s.id, s]));
  // Match each new slot back to its template by (trainer, instant) — insertAvailabilitySlots sorts
  // the rows, so we can't rely on the returned order to line up with `planned`.
  const keyToTemplateId = new Map<string, string>();
  const rows = planned.map((p) => {
    const tmpl = byId.get(p.templateId)!;
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tmpl)) if (!COPY_OMIT.has(k)) row[k] = v;
    row.start_time = p.start_time;
    row.end_time = p.end_time;
    keyToTemplateId.set(rosterMatchKey(row.trainer_id, p.start_time), p.templateId);
    return row;
  });

  const { data: insertedData, error: insErr } = await insertAvailabilitySlots(rows, supabase, 'id, trainer_id, start_time');
  if (insErr) throw insErr;

  // Attach each new session's roster (the players on the template it was copied from), so an
  // extended cycle's new weeks aren't empty. split_payment is per-slot but uniform within a cycle.
  const insertedSlots = (insertedData ?? []) as Array<{ id: string; trainer_id: unknown; start_time: string }>;
  const splitPayment = ctx.slots.some((s) => (s as { split_payment?: boolean }).split_payment === true);
  await attachTemplateRosterToNewSlots(
    cycleId, insertedSlots, keyToTemplateId, splitPayment, opts.skipInvoices ?? false, opts.newSessionStatus === 'paid',
  );

  return { added: rows.length };
}

export interface ApplyCycleEndDateResult {
  /** New sessions generated (extend). */
  added: number;
  /** Out-of-range empty sessions removed (trim). */
  removed: number;
}

/**
 * Apply a new cycle end date in ONE call: extend (generate the missing weekly sessions) when the date
 * is later, and optionally trim the now-out-of-range EMPTY sessions when it's earlier. The caller
 * supplies the removable (booking-free) ids it already previewed via `findSlotsAfterDate` — booked
 * sessions are never in that list, so they're always kept. Both the standalone end-date dialog and the
 * consolidated cycle editor route through here so the extend/trim behaviour can't diverge. Invoice-safe
 * (extend adds booking-free slots; trim only deletes empty ones).
 */
export async function applyCycleEndDate(
  cycleId: string,
  newEndDate: string,
  opts: {
    removableIds?: string[];
    removeUnbooked?: boolean;
    /** Booked out-of-range sessions to ALSO remove — cancels their bookings first (explicit opt-in). */
    bookedIdsToRemove?: string[];
    /** Threads the "Don't update invoices" toggle through the booked-session removal. */
    skipInvoices?: boolean;
    /** Status for the roster attached to NEW sessions: 'paid' (settled externally, no invoice) or
     *  'pending' (openstaand, billed). Default 'pending'. */
    newSessionStatus?: 'paid' | 'pending';
  } = {},
): Promise<ApplyCycleEndDateResult> {
  const { added } = await extendCycleToEndDate(cycleId, newEndDate, {
    skipInvoices: opts.skipInvoices,
    newSessionStatus: opts.newSessionStatus,
  });
  let removed = 0;
  if (opts.removeUnbooked && opts.removableIds && opts.removableIds.length > 0) {
    removed += await deleteUnbookedSlots(opts.removableIds);
  }
  if (opts.bookedIdsToRemove && opts.bookedIdsToRemove.length > 0) {
    const res = await cancelBookingsAndDeleteSlots(cycleId, opts.bookedIdsToRemove, {
      skipInvoices: opts.skipInvoices,
    });
    removed += res.deletedCount;
  }
  return { added, removed };
}
