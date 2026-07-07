// Academy-employed trainers are VIEW-ONLY: they view their schedule/players,
// mark attendance and write coaching notes, but cannot create/edit/delete
// sessions, cycles, bookings, payments or players. Independent trainers keep
// full editing. Enforcement is UI-level (route guards + useTrainerCanEdit gates).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const readSrc = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('useTrainerCanEdit', () => {
  beforeEach(() => vi.resetModules());

  async function load(query: { data: boolean; isLoading: boolean }) {
    vi.doMock('@tanstack/react-query', () => ({ useQuery: () => query }));
    vi.doMock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
    vi.doMock('@/lib/academy', () => ({ getTrainerAcademy: vi.fn() }));
    vi.doMock('@/lib/supabaseClient', () => ({ supabase: {} }));
    return (await import('@/hooks/useTrainerHasAcademy')).useTrainerCanEdit();
  }

  it('independent trainer (no academy, resolved) can edit', async () => {
    expect(await load({ data: false, isLoading: false })).toEqual({ canEdit: true, isLoading: false });
  });

  it('academy trainer cannot edit', async () => {
    expect(await load({ data: true, isLoading: false })).toEqual({ canEdit: false, isLoading: false });
  });

  it('fails closed while membership is still loading', async () => {
    // canEdit must be false until we KNOW the trainer has no academy — an academy
    // trainer must never flash an editing control on a cold cache.
    expect(await load({ data: false, isLoading: true })).toEqual({ canEdit: false, isLoading: true });
  });
});

describe('academy trainer view-only wiring', () => {
  it('route guard blocks CREATE surfaces, Sessions hub, invoices, legacy cyclus + terms (but not slot detail)', () => {
    const layout = readSrc('components/trainer/TrainerLayout.tsx');
    for (const path of [
      '/app/trainer/slot/new',
      '/app/trainer/slot/generate',
      '/app/trainer/sessions',
      '/app/trainer/invoices',
      '/app/trainer/cyclus',
      '/app/trainer/terms',
    ]) {
      expect(layout).toContain(`'${path}'`);
    }
    // Slot DETAIL must stay reachable (attendance + coaching notes live there).
    expect(layout).not.toContain("'/app/trainer/slot',");
  });

  it('player detail keeps a READ-ONLY tags + internal-notes display for academy trainers', () => {
    const detail = readSrc('pages/trainer/TrainerPlayerDetail.tsx');
    // Static tag chips when !canEdit (still SEE the tags, cannot edit).
    expect(detail).toContain('trainerId && !canEdit && tags.some');
    // Read-only internal-note display when the editable card is hidden.
    expect(detail).toContain('trainer-player-notes-readonly');
    expect(detail).toContain('!canEdit && detailsValues?.notes');
  });

  it('the General Terms card is hidden for academy trainers (academy owns terms)', () => {
    const settings = readSrc('pages/TrainerSettings.tsx');
    expect(settings).toMatch(/showIndependentCards \? \[\{\s*title: t\('terms\.title'/);
  });

  it('the marketplace-visibility (is_public) toggle is hidden for academy trainers', () => {
    const settings = readSrc('pages/TrainerSettings.tsx');
    // The whole visibility card is gated — academy trainers cannot flip is_public.
    expect(settings).toMatch(/\{showIndependentCards && \(\s*<div className="max-w-4xl">\s*<Card className="border-border\/80/);
  });

  it('the Sessions hub link is removed from the academy-trainer sidebar', () => {
    const sidebar = readSrc('components/trainer/TrainerSidebar.tsx');
    // The academy branch no longer renders the sessions nav item.
    expect(sidebar).not.toContain('data-testid="nav-trainer-sessions"');
  });

  it('the calendar gates its create/edit/delete/book handlers on canEdit', () => {
    const cal = readSrc('pages/TrainerCalendar.tsx');
    expect(cal).toContain('useTrainerCanEdit');
    expect(cal).toContain('onCellClick={canEdit ? handleCellClick : undefined}');
    expect(cal).toContain('onDeleteSlot={canEdit ? handleDeleteSlot : undefined}');
    expect(cal).toContain('onBookForPlayer={canEdit ? handleBookForPlayer : undefined}');
    expect(cal).toContain('onToggleMarkedFull={canEdit ? handleToggleMarkedFull : undefined}');
    // Viewing slot detail stays available.
    expect(cal).toContain('onEditBooking={handleEditBooking}');
  });

  it('slot detail is read-only for academy trainers but keeps attendance + coaching notes', () => {
    const detail = readSrc('pages/trainer/TrainerSlotDetail.tsx');
    expect(detail).toContain('useTrainerCanEdit');
    // No auto-open edit form; edit/delete/add-player/booking-edit/invoices gated.
    expect(detail).toContain('detail && canEdit && !autoEditTriggered.current');
    expect(detail).toContain('canEdit && editingBookingId === player.bookingId && editingBookingData');
    expect(detail).toContain('canEdit && showBookPlayer');
    expect(detail).toContain('detail && canEdit && <PriorityClaimsSection');
    // Coaching notes stay reachable (not gated on canEdit).
    expect(detail).toContain('editingBookingId === player.bookingId && user?.id');
    // Attendance WRITE form must be reachable (the must-keep capability).
    expect(detail).toContain('TrainerAttendanceForm');
    expect(detail).toContain('isPast(new Date(detail.end_time))');
  });

  it('players + player detail gate create/edit/remove/merge/tags/notes/campaign on canEdit', () => {
    const players = readSrc('pages/TrainerPlayers.tsx');
    expect(players).toContain('useTrainerCanEdit');
    expect(players).toContain('primaryAction={canEdit ?');
    expect(players).toContain('moreMenuItems={canEdit ?');
    // Inline tag/notes editors render read-only for academy trainers.
    expect(players).toContain('readOnly={!canEdit}');
    // Email-campaign tab (outbound blast) gated.
    expect(players).toMatch(/\{canEdit && \(\s*<TabsContent value="email-campaign"/);

    const detail = readSrc('pages/trainer/TrainerPlayerDetail.tsx');
    expect(detail).toContain('useTrainerCanEdit');
    expect(detail).toContain('canEdit && detailsValues && trainerId');
    expect(detail).toContain('canEdit && trainerId && player && parsed.kind');
    // TagPicker + invoices card gated.
    expect(detail).toContain('trainerId && canEdit && (');
  });

  it('EditProfile hides public-visibility + banner for academy trainers (academy owns them)', () => {
    const profile = readSrc('pages/EditProfile.tsx');
    expect(profile).toContain('useTrainerCanEdit');
    expect(profile).toContain("role === 'trainer' && canEdit &&");
    expect(profile).toContain("role === 'trainer' && trainerProfileId && canEdit &&");
  });
});
