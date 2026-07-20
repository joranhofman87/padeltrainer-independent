import React from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// NotificationSettings v2 (PR 8). Pins the five things this page must not get wrong:
//  1. required_delivery events get NO control (the resolver overrides them, so a toggle lies),
//  2. no WhatsApp UI before PR 9 provisions Twilio,
//  3. the v1 orphan preferences stay editable (they are still enforced by send-email),
//  4. staff filtering includes TRAINERS, not just the literal `audience` label,
//  5. a failed save must not leave the UI showing a value the database does not have.

let catalog: unknown[] = [];
let v2rows: unknown[] = [];
let v1row: Record<string, string> | null = null;
let upsertResult: { error: { message: string } | null } = { error: null };
const upsertMock = vi.fn();
const legacyUpsertMock = vi.fn();

let authState = { user: { id: 'U1' }, role: 'player', isAcademyManager: false, loading: false };
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => authState }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, def?: string) => def ?? _k }),
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'notification_event_types') {
        return { select: () => Promise.resolve({ data: catalog, error: null }) };
      }
      if (table === 'notification_preferences_v2') {
        return {
          select: () => ({ eq: () => Promise.resolve({ data: v2rows, error: null }) }),
          upsert: (...args: unknown[]) => { upsertMock(...args); return Promise.resolve(upsertResult); },
        };
      }
      if (table === 'notification_preferences') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: v1row, error: null }) }) }),
          upsert: (...args: unknown[]) => { legacyUpsertMock(...args); return Promise.resolve({ error: null }); },
        };
      }
      return {};
    },
  },
}));

import NotificationSettings from '@/pages/NotificationSettings';

const evt = (over: Record<string, unknown>) => ({
  key: 'x', category: 'booking', audience: 'player', required_delivery: false,
  supports_email: true, supports_digest: false, default_email_frequency: 'instant', ...over,
});

beforeEach(() => {
  upsertMock.mockReset();
  legacyUpsertMock.mockReset();
  upsertResult = { error: null };
  v2rows = [];
  v1row = null;
  authState = { user: { id: 'U1' }, role: 'player', isAcademyManager: false, loading: false };
  catalog = [
    evt({ key: 'booking_confirmed_player', required_delivery: true }),
    evt({ key: 'booking_cancelled_player' }),
    evt({ key: 'session_reminder_player', supports_digest: true }),
    evt({ key: 'booking_request_staff', audience: 'academy_manager' }),
    evt({ key: 'review_received_trainer', audience: 'trainer', supports_digest: true }),
  ];
});

// Radix Select needs pointer-capture / ResizeObserver / scrollIntoView, which jsdom lacks.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});

describe('NotificationSettings v2', () => {
  it('required_delivery events are ALWAYS ON with no control', async () => {
    render(<NotificationSettings />);
    expect(await screen.findByTestId('always-on-booking_confirmed_player')).toBeInTheDocument();
    // and crucially: no configurable row (no switch/select) for it
    expect(screen.queryByTestId('pref-row-booking_confirmed_player')).toBeNull();
    expect(screen.queryByRole('switch', { name: /booking_confirmed_player/i })).toBeNull();
  });

  it('renders NO WhatsApp or push controls', async () => {
    const { container } = render(<NotificationSettings />);
    await screen.findByTestId('notification-settings-configurable');
    expect(container.textContent?.toLowerCase()).not.toContain('whatsapp');
    expect(container.textContent?.toLowerCase()).not.toContain('push');
  });

  it('keeps EVERY v1 player preference reachable — including ones send-email still enforces', async () => {
    render(<NotificationSettings />);
    // not just the "no v2 key" orphans: booking_confirmation / booking_reminder / payment_receipt
    // are still gated by live send-email paths (send-digest-emails, BookForPlayerDialog), so
    // dropping them would leave a live setting enforced but unreachable.
    for (const k of ['booking_confirmation', 'booking_reminder', 'open_slots_digest',
                     'upcoming_sessions_digest', 'payment_receipt', 'waitlist_update']) {
      expect(await screen.findByTestId(`pref-row-${k}`)).toBeInTheDocument();
    }
  });

  it('keeps EVERY v1 staff preference reachable for staff', async () => {
    authState = { user: { id: 'U1' }, role: 'trainer', isAcademyManager: false, loading: false };
    render(<NotificationSettings />);
    for (const k of ['new_booking', 'booking_cancelled', 'new_follower', 'new_player',
                     'new_registration', 'new_review', 'upcoming_schedule_digest', 'payment_received']) {
      expect(await screen.findByTestId(`pref-row-${k}`)).toBeInTheDocument();
    }
  });

  it('legacy fallbacks match the COLUMN DEFAULTs (open_slots_digest is weekly, not daily)', async () => {
    v1row = null; // no stored row → fall back to schema defaults
    render(<NotificationSettings />);
    await screen.findByTestId('pref-row-open_slots_digest');
    // the i18n mock echoes the key, so assert the SELECTED frequency via the key suffix
    const freq = (testid: string) =>
      screen.getByTestId(testid).querySelector('[role="combobox"]')?.textContent?.split('.').pop();
    expect(freq('pref-row-open_slots_digest')).toBe('weekly'); // NOT 'daily'
    expect(freq('pref-row-upcoming_sessions_digest')).toBe('daily');
    expect(freq('pref-row-booking_confirmation')).toBe('instant');
  });

  it('STAFF filtering includes trainers — a trainer-only account sees staff events', async () => {
    authState = { user: { id: 'U1' }, role: 'trainer', isAcademyManager: false, loading: false };
    render(<NotificationSettings />);
    // catalogued audience is 'academy_manager', but PR 6b's fan-out also mails trainers
    expect(await screen.findByTestId('pref-row-booking_request_staff')).toBeInTheDocument();
    expect(screen.getByTestId('pref-row-new_follower')).toBeInTheDocument(); // staff legacy group too
  });

  it('a pure player does NOT see staff events', async () => {
    render(<NotificationSettings />);
    await screen.findByTestId('notification-settings-configurable');
    expect(screen.queryByTestId('pref-row-booking_request_staff')).toBeNull();
    expect(screen.queryByTestId('pref-row-new_follower')).toBeNull();
  });

  it('an academy manager also lands in the staff bucket', async () => {
    authState = { user: { id: 'U1' }, role: 'player', isAcademyManager: true, loading: false };
    render(<NotificationSettings />);
    expect(await screen.findByTestId('pref-row-booking_request_staff')).toBeInTheDocument();
  });

  it('writes only on change, upserting the chosen frequency', async () => {
    render(<NotificationSettings />);
    await screen.findByTestId('pref-row-booking_cancelled_player');
    expect(upsertMock).not.toHaveBeenCalled(); // no pre-seeding of rows
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      user_id: 'U1', event_type: 'booking_cancelled_player', email_frequency: 'off',
    });
  });

  it('legacy saves are an ATOMIC upsert on user_id (no select-then-insert race)', async () => {
    render(<NotificationSettings />);
    await screen.findByTestId('pref-row-waitlist_update');
    const row = screen.getByTestId('pref-row-waitlist_update');
    fireEvent.click(row.querySelector('[role="combobox"]')!);
    fireEvent.click(await screen.findByText('notifications.frequency.off'));
    await waitFor(() => expect(legacyUpsertMock).toHaveBeenCalledTimes(1));
    expect(legacyUpsertMock.mock.calls[0][0]).toMatchObject({ user_id: 'U1', waitlist_update: 'off' });
    expect(legacyUpsertMock.mock.calls[0][1]).toMatchObject({ onConflict: 'user_id' });
  });

  it('a FAILED save does not leave the UI lying (pessimistic update)', async () => {
    upsertResult = { error: { message: 'nope' } };
    render(<NotificationSettings />);
    await screen.findByTestId('pref-row-booking_cancelled_player');
    const sw = screen.getByRole('switch');
    expect(sw).toBeChecked(); // default 'instant'
    fireEvent.click(sw);
    await waitFor(() => expect(upsertMock).toHaveBeenCalled());
    // the write failed, so the control must stay where it was
    await waitFor(() => expect(screen.getByRole('switch')).toBeChecked());
  });
});
