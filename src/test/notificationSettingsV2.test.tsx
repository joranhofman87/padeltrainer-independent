import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          insert: () => Promise.resolve({ error: null }),
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

  it('keeps the v1 orphan preferences editable (still enforced by send-email)', async () => {
    render(<NotificationSettings />);
    expect(await screen.findByTestId('pref-row-open_slots_digest')).toBeInTheDocument();
    expect(screen.getByTestId('pref-row-upcoming_sessions_digest')).toBeInTheDocument();
    expect(screen.getByTestId('pref-row-waitlist_update')).toBeInTheDocument();
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
