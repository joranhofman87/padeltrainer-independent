import React from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// NotificationSettings v2 (PR 8). Pins the five things this page must not get wrong:
//  1. required_delivery events get NO control (the resolver overrides them, so a toggle lies),
//  2. WhatsApp controls appear only for events that support it and stay DISABLED without an
//     opted-in contact (PR 9),
//  3. the v1 orphan preferences stay editable (they are still enforced by send-email),
//  4. staff filtering includes TRAINERS, not just the literal `audience` label,
//  5. a failed save must not leave the UI showing a value the database does not have.

let catalog: unknown[] = [];
let v2rows: unknown[] = [];
let v1row: Record<string, string> | null = null;
let upsertResult: { error: { message: string } | null } = { error: null };
let consentRows: unknown[] = [];
// PostgREST resolves with {data: null, error} instead of rejecting. Hardcoding error:null
// everywhere is what let an unchecked read look like "no preferences stored" for so long.
let v2ReadError: { message: string } | null = null;
const upsertMock = vi.fn();
const legacyUpsertMock = vi.fn();
const rpcMock = vi.fn();
let myCaps: unknown[] = [];
let myCapHistory: unknown[] = [];

let authState = {
  user: { id: 'U1' },
  role: 'player' as string,
  isClubManager: false,
  // The page tests the whole ROLES set, not the primary role: `useAuth` ranks admin above
  // trainer, so a primary-role test would hide every staff event from a trainer who is also an
  // admin. The fixture must carry both fields or the page reads `undefined.includes`.
  roles: ['player'] as string[],
  isAcademyManager: false,
  loading: false,
};
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => authState }));
const navigateMock = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// The mock INTERPOLATES {{vars}} like real i18next — otherwise a value passed into a string
// (the redacted number below) is invisible to assertions and could silently go missing.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const vars = (typeof def === 'string' ? opts : def) ?? {};
      // object form carries defaultValue, exactly as real i18next reads it
      const template = typeof def === 'string'
        ? def
        : String((def as Record<string, unknown> | undefined)?.defaultValue ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars[name] ?? ''));
    },
  }),
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'notification_event_types') {
        return { select: () => Promise.resolve({ data: catalog, error: null }) };
      }
      if (table === 'notification_preferences_v2') {
        return {
          select: () => ({
            eq: () =>
              Promise.resolve(
                v2ReadError ? { data: null, error: v2ReadError } : { data: v2rows, error: null },
              ),
          }),
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
    rpc: (fn: string, ...rest: unknown[]) => {
      rpcMock(fn, ...rest);
      if (fn === 'get_my_whatsapp_consent') return Promise.resolve({ data: consentRows, error: null });
      if (fn === 'get_my_notification_restrictions') return Promise.resolve({ data: myCaps, error: null });
      if (fn === 'get_my_notification_restriction_history') return Promise.resolve({ data: myCapHistory, error: null });
      if (fn === 'revoke_my_whatsapp_consent') return Promise.resolve({ data: 1, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  },
}));

import NotificationSettings from '@/pages/NotificationSettings';

const evt = (over: Record<string, unknown>) => ({
  key: 'x', category: 'booking', audience: 'player', required_delivery: false,
  supports_email: true, supports_whatsapp: false, supports_digest: false,
  default_email_frequency: 'instant', default_whatsapp_frequency: 'off',
  whatsapp_optin_via_booking: false, ...over,
});

beforeEach(() => {
  upsertMock.mockReset();
  legacyUpsertMock.mockReset();
  rpcMock.mockReset();
  consentRows = [{ opted_in: false, destination_redacted: null, consent_at: null }];
  upsertResult = { error: null };
  v2rows = [];
  v1row = null;
  v2ReadError = null;
  myCaps = [];
  myCapHistory = [];
  navigateMock.mockClear();
  // A fresh tab from an email link: React Router's history index is 0, i.e. nothing of ours
  // behind us. Individual tests raise it to model in-app navigation.
  window.history.replaceState({ idx: 0 }, '');
  authState = { user: { id: 'U1' }, role: 'player', roles: ['player'], isClubManager: false, isAcademyManager: false, loading: false };
  catalog = [
    evt({ key: 'booking_confirmed_player', required_delivery: true }),
    evt({ key: 'booking_cancelled_player' }),
    evt({ key: 'session_reminder_player', supports_digest: true, supports_whatsapp: true,
      whatsapp_optin_via_booking: true, default_email_frequency: 'daily' }),
    evt({ key: 'booking_request_staff', audience: 'academy_manager' }),
    evt({ key: 'review_received_trainer', audience: 'trainer', supports_digest: true }),
    // the v2 event that REPLACED the legacy open_slots_digest column in 10c-b D
    evt({ key: 'open_slots_player', supports_digest: true, default_email_frequency: 'weekly' }),
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

  it('renders NO push controls (nothing seeds supports_push)', async () => {
    const { container } = render(<NotificationSettings />);
    await screen.findByTestId('notification-settings-configurable');
    expect(container.textContent?.toLowerCase()).not.toContain('push');
  });

  it('shows a WhatsApp control ONLY for events that support the channel', async () => {
    render(<NotificationSettings />);
    await screen.findByTestId('pref-row-session_reminder_player');
    expect(screen.getByTestId('wa-cell-session_reminder_player')).toBeInTheDocument();
    // booking_cancelled_player has supports_whatsapp false — a toggle there would be a control
    // for a channel the resolver would never use
    expect(screen.queryByTestId('wa-cell-booking_cancelled_player')).toBeNull();
  });

  it('DISABLES the WhatsApp toggle until there is an opted-in contact', async () => {
    render(<NotificationSettings />);
    const cell = await screen.findByTestId('wa-cell-session_reminder_player');
    const sw = cell.querySelector('[role="switch"]')!;
    // the resolver's second gate would refuse anyway; an enabled toggle would promise delivery
    // we cannot make good on
    expect(sw).toBeDisabled();
    expect(sw).not.toBeChecked();
  });

  it('enables the toggle and shows the REDACTED number once consent exists', async () => {
    consentRows = [{ opted_in: true, destination_redacted: '•••5678', consent_at: '2026-07-01T00:00:00Z' }];
    render(<NotificationSettings />);
    const cell = await screen.findByTestId('wa-cell-session_reminder_player');
    expect(cell.querySelector('[role="switch"]')).not.toBeDisabled();
    expect(screen.getByTestId('notification-settings-whatsapp').textContent).toContain('•••5678');
  });

  it('offers revoke only when opted in, and calls the person-scoped RPC', async () => {
    render(<NotificationSettings />);
    await screen.findByTestId('notification-settings-whatsapp');
    expect(screen.queryByTestId('whatsapp-revoke')).toBeNull();   // not opted in

    consentRows = [{ opted_in: true, destination_redacted: '•••5678', consent_at: null }];
    render(<NotificationSettings />);
    const btn = await screen.findByTestId('whatsapp-revoke');
    fireEvent.click(btn);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('revoke_my_whatsapp_consent'));
  });

  it('a WhatsApp toggle writes BOTH columns, preserving the EVENT email default', async () => {
    // the trap: an upsert carrying only whatsapp_frequency inserts a row whose email_frequency
    // takes the COLUMN default ('instant'), silently promoting this event's 'daily' email.
    // Uses an event OUTSIDE the booking opt-in so the switch starts off and this exercises the
    // turning-ON direction (the opt-in events start on — covered separately below).
    consentRows = [{ opted_in: true, destination_redacted: '•••5678', consent_at: null }];
    catalog = [evt({
      key: 'invoice_reminder_player', supports_whatsapp: true,
      whatsapp_optin_via_booking: false, default_email_frequency: 'daily',
    })];
    render(<NotificationSettings />);
    const cell = await screen.findByTestId('wa-cell-invoice_reminder_player');
    fireEvent.click(cell.querySelector('[role="switch"]')!);
    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      event_type: 'invoice_reminder_player',
      whatsapp_frequency: 'instant',
      email_frequency: 'daily',        // the EVENT default, not the column default
    });
  });

  it('keeps EVERY v1 player preference reachable — including ones send-email still enforces', async () => {
    render(<NotificationSettings />);
    // not just the "no v2 key" orphans: booking_confirmation / booking_reminder / payment_receipt
    // are still gated by live send-email paths (send-digest-emails, BookForPlayerDialog), so
    // dropping them would leave a live setting enforced but unreachable.
    for (const k of ['booking_confirmation', 'booking_reminder',
                     'upcoming_sessions_digest', 'payment_receipt', 'waitlist_update']) {
      expect(await screen.findByTestId(`pref-row-${k}`)).toBeInTheDocument();
    }
  });

  it('open_slots_digest is GONE from the v1 bridge — its cadence lives in v2 now', async () => {
    // 10c-b D retired this control deliberately. notify-followers was the only live send-email
    // path that consulted the column; it now calls enqueue_notification('open_slots_player'),
    // whose cadence is notification_preferences_v2 — which slice C backfilled from this very
    // column, preserving off/instant/daily/weekly exactly.
    //
    // The inverted assertion matters: leaving the legacy row visible would let a user edit a
    // column NOTHING reads, silently diverging from the v2 preference that actually governs
    // delivery. That is worse than removing it, which is why this is asserted rather than
    // just deleted from the list above.
    render(<NotificationSettings />);
    await screen.findByTestId('pref-row-booking_confirmation');   // page has rendered
    expect(screen.queryByTestId('pref-row-open_slots_digest')).not.toBeInTheDocument();
    // and the v2 event that replaced it IS reachable
    expect(await screen.findByTestId('pref-row-open_slots_player')).toBeInTheDocument();
  });

  it('keeps EVERY v1 staff preference reachable for staff', async () => {
    authState = { user: { id: 'U1' }, role: 'trainer', roles: ['trainer'], isClubManager: false, isAcademyManager: false, loading: false };
    render(<NotificationSettings />);
    for (const k of ['new_booking', 'booking_cancelled', 'new_follower', 'new_player',
                     'new_registration', 'new_review', 'upcoming_schedule_digest', 'payment_received']) {
      expect(await screen.findByTestId(`pref-row-${k}`)).toBeInTheDocument();
    }
  });

  it('legacy fallbacks match the COLUMN DEFAULTs (upcoming_sessions_digest is daily)', async () => {
    v1row = null; // no stored row → fall back to schema defaults
    render(<NotificationSettings />);
    await screen.findByTestId('pref-row-upcoming_sessions_digest');
    // the i18n mock echoes the key, so assert the SELECTED frequency via the key suffix
    const freq = (testid: string) =>
      screen.getByTestId(testid).querySelector('[role="combobox"]')?.textContent?.split('.').pop();
    // open_slots_digest's weekly default is no longer asserted HERE — the column is off the
    // bridge (see the test above). That default is now enforced where it matters: slice C's
    // realpg suite proves the v1->v2 backfill preserves weekly, and that a user with no legacy
    // row falls back to the catalog's weekly default for open_slots_player.
    expect(freq('pref-row-upcoming_sessions_digest')).toBe('daily');
    expect(freq('pref-row-booking_confirmation')).toBe('instant');
  });

  it('an academy cap renders an ADVISORY marker on the affected row, and only there', async () => {
    myCaps = [{ academy_name: 'Padel Zuid', event_type: 'open_slots_player', channel: 'whatsapp', max_frequency: 'daily' }];
    render(<NotificationSettings />);
    const marker = await screen.findByTestId('cap-marker-open_slots_player');
    expect(marker).toHaveTextContent('Padel Zuid');
    // channel-specific: a WHATSAPP cap must be visible AND name its channel (round-4 finding 4)
    expect(marker).toHaveTextContent(/whatsapp/i);
    expect(screen.queryByTestId('cap-marker-booking_confirmation')).toBeNull();
  });

  it("the academies' change history renders when present — finding 5's player visibility", async () => {
    myCapHistory = [{ academy_name: 'Padel Zuid', event_type: 'open_slots_player',
      old_max_frequency: null, new_max_frequency: 'off', reason: 'tournament week' }];
    render(<NotificationSettings />);
    const entry = await screen.findByTestId('cap-history-entry');
    expect(entry).toHaveTextContent('tournament week');
  });

  describe('the Back control at the neutral email-entry route', () => {
    // An email footer opens a FRESH tab, so navigate(-1) has nothing to go back to. The fallback
    // must be a surface the account can actually ENTER: the first version guessed, and sent a
    // club-only account to /app/player, whose layout guard redirects it to the login form.
    const homes: Array<[string, Partial<typeof authState>, string]> = [
      ['academy manager', { isAcademyManager: true }, '/app/academy'],
      ['admin', { role: 'admin', roles: ['admin'] }, '/app/admin'],
      ['trainer', { role: 'trainer', roles: ['trainer'] }, '/app/trainer'],
      ['club', { role: 'club', roles: ['club'] }, '/app/club'],
      ['club manager without the role', { isClubManager: true }, '/app/club'],
      ['academy staff who is not a manager', { role: 'academy', roles: ['academy'] }, '/app/academy/onboarding'],
      ['player', { role: 'player', roles: ['player'] }, '/app/player'],
    ];

    it.each(homes)('with no in-app history, %s goes to its own home', async (_l, patch, expected) => {
      authState = { ...authState, ...patch };
      render(<NotificationSettings />);
      const back = await screen.findByLabelText('back');
      back.click();
      expect(navigateMock).toHaveBeenCalledWith(expected);
    });

    it('prefers real in-app history when there is any', async () => {
      window.history.replaceState({ idx: 3 }, '');
      render(<NotificationSettings />);
      const back = await screen.findByLabelText('back');
      back.click();
      expect(navigateMock).toHaveBeenCalledWith(-1);
    });
  });

  it('STAFF filtering reads the ROLES set — admin+trainer is staff, though role is admin', async () => {
    // `useAuth` ranks admin above trainer, so this account's PRIMARY role is 'admin'. Testing the
    // primary role hid every staff event and legacy staff setting from a real trainer.
    authState = {
      user: { id: 'U1' },
      role: 'admin',
      roles: ['admin', 'trainer'],
      isClubManager: false,
      isAcademyManager: false,
      loading: false,
    };
    render(<NotificationSettings />);
    expect(await screen.findByTestId('pref-row-booking_request_staff')).toBeInTheDocument();
    expect(await screen.findByTestId('pref-row-new_booking')).toBeInTheDocument();
  });

  it('a FAILED preference read shows a retry, and renders NO control that could overwrite it', async () => {
    // The destructive shape this prevents: an unchecked read leaves `prefs` empty, `effective()`
    // then answers with catalog DEFAULTS, and saveEvent writes BOTH columns — so touching the
    // email control would replace a stored `whatsapp: off` with the default.
    v2ReadError = { message: 'connection reset' };
    render(<NotificationSettings />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByTestId('pref-row-booking_confirmation')).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('STAFF filtering includes trainers — a trainer-only account sees staff events', async () => {
    authState = { user: { id: 'U1' }, role: 'trainer', roles: ['trainer'], isClubManager: false, isAcademyManager: false, loading: false };
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
    authState = { user: { id: 'U1' }, role: 'player', roles: ['player'], isClubManager: false, isAcademyManager: true, loading: false };
    render(<NotificationSettings />);
    expect(await screen.findByTestId('pref-row-booking_request_staff')).toBeInTheDocument();
  });

  it('writes only on change, upserting the chosen frequency', async () => {
    render(<NotificationSettings />);
    await screen.findByTestId('pref-row-booking_cancelled_player');
    expect(upsertMock).not.toHaveBeenCalled(); // no pre-seeding of rows
    const row = screen.getByTestId('pref-row-booking_cancelled_player');
    fireEvent.click(row.querySelector('[role="switch"]')!);
    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      user_id: 'U1', event_type: 'booking_cancelled_player',
      email_frequency: 'off', whatsapp_frequency: 'off',
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
    const row = await screen.findByTestId('pref-row-booking_cancelled_player');
    const sw = row.querySelector('[role="switch"]')!;
    expect(sw).toBeChecked(); // default 'instant'
    fireEvent.click(sw);
    await waitFor(() => expect(upsertMock).toHaveBeenCalled());
    // the write failed, so the control must stay where it was
    await waitFor(() =>
      expect(screen.getByTestId('pref-row-booking_cancelled_player').querySelector('[role="switch"]')).toBeChecked());
  });

  it('shows the WhatsApp switch ON for a booking opt-in with no stored preference', async () => {
    // the resolver treats the opt-in as the cadence for this event, so a page reading only the
    // stored value would show OFF while reminders were actually being delivered
    consentRows = [{ opted_in: true, destination_redacted: '•••5678', consent_at: null }];
    v2rows = [];   // no explicit preference
    render(<NotificationSettings />);
    const cell = await screen.findByTestId('wa-cell-session_reminder_player');
    expect(cell.querySelector('[role="switch"]')).toBeChecked();
  });

  it('clicking that switch writes an explicit off, which the resolver then honours', async () => {
    consentRows = [{ opted_in: true, destination_redacted: '•••5678', consent_at: null }];
    v2rows = [];
    render(<NotificationSettings />);
    const cell = await screen.findByTestId('wa-cell-session_reminder_player');
    fireEvent.click(cell.querySelector('[role="switch"]')!);
    await waitFor(() => expect(upsertMock).toHaveBeenCalledTimes(1));
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      event_type: 'session_reminder_player',
      whatsapp_frequency: 'off',
      email_frequency: 'daily',      // the other channel is preserved, not reset to its column default
    });
  });

  it('an explicit stored preference still wins over the derived opt-in state', async () => {
    consentRows = [{ opted_in: true, destination_redacted: '•••5678', consent_at: null }];
    v2rows = [{ event_type: 'session_reminder_player', email_frequency: 'daily', whatsapp_frequency: 'off' }];
    render(<NotificationSettings />);
    const cell = await screen.findByTestId('wa-cell-session_reminder_player');
    expect(cell.querySelector('[role="switch"]')).not.toBeChecked();
  });

  it('does NOT derive an on-state for an event outside the booking opt-in', async () => {
    consentRows = [{ opted_in: true, destination_redacted: '•••5678', consent_at: null }];
    catalog = [evt({ key: 'invoice_reminder_player', supports_whatsapp: true, whatsapp_optin_via_booking: false })];
    render(<NotificationSettings />);
    const cell = await screen.findByTestId('wa-cell-invoice_reminder_player');
    expect(cell.querySelector('[role="switch"]')).not.toBeChecked();
  });
});
