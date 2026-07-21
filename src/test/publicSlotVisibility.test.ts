// @vitest-environment node
//
// PUBLIC BOOKING SURFACES SHOW ONLY OPEN, ACTIONABLE SLOTS.
//
// Two ways a slot stops being actionable, and both must remove it from public data rather than
// rely on the server refusing later:
//
//   FULL — the canonical occupying set is confirmed + pending + pending_approval, PLUS a live
//   payment_pending hold, PLUS a court held by a paid rebook group. BookLesson previously
//   counted only ['pending','confirmed'], so a slot that was full server-side still rendered as
//   bookable; the player filled in a form and met a refusal.
//
//   BOOKING CUTOFF — inside the academy/trainer minimum notice.
//
// Everything here is advisory: the database decides. These pins are about not inviting someone
// into a booking that cannot succeed.
import { describe, it, expect } from 'vitest';
import { mapAndGroupPublicSlots } from '@/lib/publicAvailability';
import { CAPACITY_OCCUPYING_STATUSES, occupiesSeatNow, countOccupiedSeatsNow } from '@/lib/lessons';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { effectiveCutoffMinutes, isSlotWithinCutoff } from '@/lib/bookingCutoff';

/** The shared predicate under test — the same one BookLesson's fallback now uses. */
const occupies = occupiesSeatNow;

describe('the canonical occupying predicate', () => {
  it('counts pending_approval — a player awaiting a decision holds the seat', () => {
    // the status BookLesson used to omit
    expect(CAPACITY_OCCUPYING_STATUSES).toContain('pending_approval');
    expect(occupies({ status: 'pending_approval' })).toBe(true);
  });

  it('counts a LIVE payment hold, and not an expired one', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const past = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(occupies({ status: 'payment_pending', hold_expires_at: future })).toBe(true);
    expect(occupies({ status: 'payment_pending', hold_expires_at: past })).toBe(false);
    // a hold with no expiry is not a live hold
    expect(occupies({ status: 'payment_pending', hold_expires_at: null })).toBe(false);
  });

  it('does not count cancelled / rejected / completed', () => {
    for (const status of ['cancelled', 'cancelled_swap', 'rejected', 'completed']) {
      expect(occupies({ status }), `${status} must not hold a seat`).toBe(false);
    }
  });
});

describe('mapAndGroupPublicSlots drops what cannot be booked', () => {
  const raw = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    start_time: '2026-08-01T10:00:00.000Z',
    end_time: '2026-08-01T11:00:00.000Z',
    max_participants: 4,
    allow_single_booking: true,
    split_payment: false,
    trainer_id: 't1',
    academy_profile_id: 'a1',
    is_public: true,
    locations: null,
    ...over,
  });

  const shape = (rows: ReturnType<typeof raw>[], ctx: Partial<Parameters<typeof mapAndGroupPublicSlots>[1]> = {}) =>
    mapAndGroupPublicSlots(rows as never, {
      bookingCounts: {},
      visibleIds: new Set(rows.map((r) => r.id)),
      trainerMap: {},
      nameMap: {},
      ...ctx,
    });

  const idsOf = (groups: ReturnType<typeof mapAndGroupPublicSlots>) =>
    groups.flatMap((g) => g.slots.map((s) => s.id));

  it('keeps an open slot', () => {
    expect(idsOf(shape([raw('open')], { bookingCounts: { open: 1 } }))).toEqual(['open']);
  });

  it('drops a FULL slot', () => {
    expect(idsOf(shape([raw('full')], { bookingCounts: { full: 4 } }))).toEqual([]);
  });

  it('drops a slot inside its BOOKING CUTOFF', () => {
    expect(idsOf(shape([raw('late')], { bookingClosedIds: new Set(['late']) }))).toEqual([]);
  });

  it('drops only the closed one, keeping its neighbours', () => {
    const groups = shape([raw('a'), raw('late'), raw('b')], { bookingClosedIds: new Set(['late']) });
    expect(idsOf(groups).sort()).toEqual(['a', 'b']);
  });

  it('without any cutoff set, nothing extra is dropped', () => {
    // the default must be inert on every existing public page
    expect(idsOf(shape([raw('a'), raw('b')]))).toHaveLength(2);
  });
});

describe('the cutoff a public calendar applies', () => {
  const NOW = new Date('2026-07-21T12:00:00.000Z');
  const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

  it('takes the STRICTER of the slot academy and its trainer', () => {
    // one calendar can span several trainers and academies, so this is per slot
    expect(effectiveCutoffMinutes(2880, 4320)).toBe(4320);
    expect(effectiveCutoffMinutes(2880, 1440)).toBe(2880);
  });

  it('closes a slot inside the window and leaves the rest open', () => {
    const cutoff = effectiveCutoffMinutes(2880, 0);   // academy 48h, trainer unset
    expect(isSlotWithinCutoff(inHours(47), cutoff, NOW)).toBe(true);
    expect(isSlotWithinCutoff(inHours(49), cutoff, NOW)).toBe(false);
  });

  it('is inert when neither tenant sets one', () => {
    const cutoff = effectiveCutoffMinutes(0, 0);
    expect(isSlotWithinCutoff(inHours(0.1), cutoff, NOW)).toBe(false);
  });
});

describe('BookLesson counts capacity the canonical way', () => {
  // BookLesson.tsx has no test harness (large page component), so the PREDICATE is tested
  // directly above and the WIRING is pinned here. The bug being prevented: this page counted
  // only ['pending','confirmed'], so a slot full of pending_approval players — or one where
  // somebody held a live payment — rendered as bookable and the player met a server refusal.
  const src = readFileSync(join(process.cwd(), 'src', 'pages', 'BookLesson.tsx'), 'utf8');

  it('asks the canonical RPC for occupancy', () => {
    // Anchored on the CALL, not any mention: the surrounding comment names the RPC too, and a
    // bare toContain() passed while the call had been renamed away. Second time that exact trap
    // has bitten in this PR.
    expect(src).toMatch(/rpc\(\s*\n?\s*'get_public_slot_occupancy'/);
  });

  it('no longer hardcodes the narrow status pair', () => {
    expect(src).not.toMatch(/\.in\('status', \['pending', 'confirmed'\]\)/);
    expect(src).toContain('CAPACITY_OCCUPYING_STATUSES');
    expect(src).toContain("'payment_pending'");
  });

  it('uses the SHARED predicate wherever it reasons about seats, never a local copy', () => {
    // a second hand-rolled predicate is how the client drifted from the server in the first
    // place; BookLesson still reads bookings for RATINGS, and an expired hold is not a
    // participant whose rating should skew the average
    expect(src).toContain('occupiesSeatNow');
  });

  it('filters and displays from the canonical count', () => {
    expect(src).toContain('canonicalOccupancy[s.id] ?? 0) >= maxP');
    expect(src).toContain('const bookingCount = canonicalOccupancy[s.id] ?? 0;');
  });
});

describe('countOccupiedSeatsNow', () => {
  it('counts statuses AND live holds, ignoring expired ones', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(countOccupiedSeatsNow([
      { status: 'confirmed' },
      { status: 'pending_approval' },
      { status: 'payment_pending', hold_expires_at: future },
      { status: 'payment_pending', hold_expires_at: past },
      { status: 'cancelled' },
    ])).toBe(3);
  });

  it('is empty-safe', () => {
    expect(countOccupiedSeatsNow(null)).toBe(0);
    expect(countOccupiedSeatsNow([])).toBe(0);
  });
});

describe('public surfaces only select columns their source actually exposes', () => {
  // THE BUG THIS EXISTS FOR: BookLesson read player_booking_min_notice_minutes from
  // `trainer_profiles_safe`, a VIEW that does not expose it. PostgREST 400s on that select, so
  // /book/:trainerId failed to load. Typecheck could not catch it because the .from() carries an
  // `as any` cast — the one place the type system was disabled is the place it was needed.
  const types = readFileSync(join(process.cwd(), 'src', 'integrations', 'supabase', 'types.ts'), 'utf8');
  const bookLesson = readFileSync(join(process.cwd(), 'src', 'pages', 'BookLesson.tsx'), 'utf8');
  const publicHook = readFileSync(join(process.cwd(), 'src', 'hooks', 'usePublicAvailability.ts'), 'utf8');

  /** Columns the generated types say a table/view has. */
  const columnsOf = (name: string): string => {
    const i = types.indexOf(`      ${name}: {`);
    expect(i, `${name} missing from generated types`).toBeGreaterThan(-1);
    return types.slice(i, i + 6000);
  };

  it('trainer_profiles_safe does NOT expose the cutoff column', () => {
    // the fact that makes the direct select wrong; asserted so the pin below has teeth
    expect(columnsOf('trainer_profiles_safe')).not.toContain('player_booking_min_notice_minutes');
  });

  it('BookLesson never selects the cutoff column from the safe view', () => {
    const at = bookLesson.indexOf("trainer_profiles_safe");
    expect(at).toBeGreaterThan(-1);
    // the select immediately follows the .from()
    expect(bookLesson.slice(at, at + 400)).not.toContain('player_booking_min_notice_minutes');
  });

  it('neither public surface reads the settings tables directly', () => {
    // anon cannot read either base table, so those selects silently yield 0 for exactly the
    // visitors these pages serve — leaving too-late slots on sale
    for (const [name, src] of [['BookLesson', bookLesson], ['usePublicAvailability', publicHook]] as const) {
      expect(src, `${name} must not read academy_profiles for cutoffs`)
        .not.toMatch(/from\('academy_profiles'\)[\s\S]{0,120}player_booking_min_notice_minutes/);
      expect(src, `${name} must not read trainer_profiles for cutoffs`)
        .not.toMatch(/from\('trainer_profiles'\)[\s\S]{0,120}player_booking_min_notice_minutes/);
    }
  });

  it('both public surfaces use the ONE anon-safe cutoff RPC', () => {
    for (const [name, src] of [['BookLesson', bookLesson], ['usePublicAvailability', publicHook]] as const) {
      expect(src, `${name} must use the shared cutoff RPC`)
        .toMatch(/rpc\(\s*\n?\s*'get_public_slot_booking_cutoff'/);
    }
  });

  it('derives occupancy from ONE place — the RPC — and never from a bookings read', () => {
    // THE TRAP: a correct predicate over an UNREADABLE table. Anonymous visitors have no SELECT
    // on `bookings`, so a direct read returns EMPTY rather than erroring — every slot then looks
    // unoccupied and full sessions go back on sale, silently, to exactly the visitors these
    // surfaces serve. My earlier pin checked the predicate and missed that the data source was
    // unreachable.
    //
    // Asserted as "one assignment site" rather than "never touches bookings": BookLesson still
    // reads bookings legitimately for RATINGS, so a blanket ban would be both wrong and easy to
    // work around. What must hold is that the occupancy MAP is only ever written from the RPC.
    const assignments = (src: string, name: string) =>
      [...src.matchAll(new RegExp(`${name}\\[[^\\]]+\\]\\s*=`, 'g'))].length;

    expect(assignments(bookLesson, 'canonicalOccupancy'),
      'BookLesson must fill canonicalOccupancy from the RPC alone').toBe(1);
    expect(assignments(publicHook, 'bookingCounts'),
      'usePublicAvailability must fill bookingCounts from the RPC alone').toBe(1);
  });

  it('FAILS CLOSED on BOTH unverifiable rules — occupancy and the cutoff', () => {
    // An unverifiable rule is not a passed rule. The cutoff RPC is now the ONLY client source
    // for "is this slot too late", so swallowing its error offers too-late slots and defers the
    // refusal to checkout — the same shape as the occupancy bug, one call over.
    expect(bookLesson, 'BookLesson must surface a retryable error for occupancy')
      .toMatch(/if \(occErr \|\| !occ\)[\s\S]{0,600}throw new Error/);
    expect(bookLesson, 'BookLesson must surface a retryable error for the cutoff')
      .toMatch(/if \(cutoffErr \|\| !cutoffRows\)[\s\S]{0,400}throw new Error/);
    // the hook renders nothing in both cases
    // The GUARDS, not just the bodies. A count of fail-closed blocks passes even when the
    // condition has been neutered to `if (false)` — the body still exists, unreachable. Assert
    // what actually triggers them.
    expect(publicHook, 'hook must fail closed when occupancy errors')
      .toMatch(/if \(!occErr && occ\)|if \(occErr \|\| !occ\)/);
    expect(publicHook, 'hook must fail closed when the cutoff RPC errors')
      .toMatch(/if \(cutoffErr \|\| !cutoffRows\)/);
    expect([...publicHook.matchAll(/setAvailabilityUnverified\(true\)/g)].length,
      'hook must fail closed for occupancy AND cutoff').toBe(2);
    // and each of those sites clears what would otherwise be rendered
    expect(publicHook).toMatch(/setDayGroups\(\[\]\);\s*\n\s*setAvailabilityUnverified\(true\);/);
  });

  it('distinguishes "cannot tell" from "nothing free", and RENDERS that difference', () => {
    // the flag existing is not enough — a consumer that ignores it still tells the visitor a
    // falsehood, and with alwaysShow=false the section vanishes with no explanation at all
    expect(publicHook).toContain('availabilityUnverified: boolean');
    expect(publicHook).toMatch(/return \{ dayGroups, loading, availabilityUnverified \}/);

    const calendar = readFileSync(join(process.cwd(), 'src', 'components', 'booking', 'AvailabilityCalendar.tsx'), 'utf8');
    const picker = readFileSync(join(process.cwd(), 'src', 'components', 'booking', 'AvailabilityPicker.tsx'), 'utf8');
    for (const [name, src] of [['AvailabilityCalendar', calendar], ['AvailabilityPicker', picker]] as const) {
      expect(src, `${name} must consume the flag`).toContain('availabilityUnverified');
      expect(src, `${name} must render a distinct state, before the empty-state branch`)
        .toMatch(/if \(availabilityUnverified\)[\s\S]{0,900}booking\.availabilityUnverified/);
    }
  });
});
