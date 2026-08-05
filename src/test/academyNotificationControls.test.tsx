import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * N3 M6 — the academy manager's cap surface.
 *
 * What must not regress (contract findings 4, 11, 12 + review-round-2 wording):
 *  1. only CAPPABLE events render controls — a trainer-only or legacy event here is a switch
 *     wired to nothing;
 *  2. every change goes through the reason dialog, and the RPC receives a uuid request_id
 *     (that is what makes a network retry replay instead of double-audit);
 *  3. the timing honesty copy is present ("next delivery pass", "newly created");
 *  4. a failed load renders retry, never defaults-as-state;
 *  5. impact is COUNTS; outcomes carry only redacted projections.
 */

const rpcMock = vi.fn();
let rpcFails = false;

vi.mock('@/components/academy/AcademyLayout', () => ({
  useAcademyContext: () => ({ activeAcademy: { id: 'acad-1', name: 'Padel Zuid' } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const vars = (typeof def === 'string' ? opts : def) ?? {};
      const template = typeof def === 'string'
        ? def
        : String((def as Record<string, unknown> | undefined)?.defaultValue ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(vars[name] ?? ''));
    },
  }),
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: (fn: string, args?: Record<string, unknown>) => {
      rpcMock(fn, args);
      if (rpcFails) return Promise.resolve({ data: null, error: { message: 'boom' } });
      if (fn === 'get_academy_notification_restrictions') {
        return Promise.resolve({ data: [{ event_type: 'booking_confirmed_staff', channel: 'email', max_frequency: 'off' }], error: null });
      }
      if (fn === 'get_academy_restriction_impact') {
        return Promise.resolve({ data: [{ event_type: 'booking_confirmed_staff', channel: 'email', day: '2026-08-04', restricted_count: 3 }], error: null });
      }
      if (fn === 'get_academy_notification_outcomes') {
        return Promise.resolve({ data: [{ event_type: 'booking_request_staff', channel: 'email', status: 'sent', skip_reason: null, destination_redacted: 'm***@a.nl', public_summary: {}, created_at: new Date().toISOString() }], error: null });
      }
      if (fn === 'set_academy_notification_restriction') return Promise.resolve({ data: 'set', error: null });
      return Promise.resolve({ data: [], error: null });
    },
  },
}));

import AcademyNotificationControls from '@/pages/academy/AcademyNotificationControls';
import { CAPPABLE_EVENTS } from '@/lib/academyNotificationCappable';

beforeEach(() => {
  vi.clearAllMocks();
  rpcFails = false;
});

describe('AcademyNotificationControls', () => {
  it('renders exactly the CAPPABLE rows — never trainer-only, legacy or required events', async () => {
    render(<AcademyNotificationControls />);
    await screen.findByTestId('academy-notification-controls');
    for (const { event, channels } of CAPPABLE_EVENTS) {
      for (const ch of channels) {
        expect(screen.getByTestId(`cap-row-${event}:${ch}`)).toBeInTheDocument();
      }
    }
    expect(screen.queryByTestId('cap-row-open_slots_player:email')).toBeNull();
    expect(screen.queryByTestId('cap-row-booking_confirmed_player:email')).toBeNull();
  });

  it('carries the honesty copy: cap-not-floor, next-pass timing, scope note, private-outcomes note', async () => {
    render(<AcademyNotificationControls />);
    await screen.findByTestId('academy-notification-controls');
    expect(screen.getByText(/own choice to receive less always wins/)).toBeInTheDocument();
    expect(screen.getByText(/next delivery pass — not instantly/)).toBeInTheDocument();
    expect(screen.getByText(/outside an academy’s reach/)).toBeInTheDocument();
    expect(screen.getByText(/private and not shown here/)).toBeInTheDocument();
  });

  it('shows current caps and the impact count', async () => {
    render(<AcademyNotificationControls />);
    await screen.findByTestId('academy-notification-controls');
    expect(screen.getByText(/3 stopped in the last 30 days/)).toBeInTheDocument();
  });

  it('a change demands a reason (≥3 chars) and sends a uuid request_id — via the extracted dialog', async () => {
    // Radix Select items cannot be operated under jsdom (no layout APIs), so the submission
    // contract is tested on CapChangeDialog directly; the page's one-line select→dialog wiring
    // is source-pinned below.
    const { CapChangeDialog } = await import('@/components/academy/CapChangeDialog');
    render(
      <CapChangeDialog
        pending={{ event: 'booking_request_staff', channel: 'email', next: 'off' }}
        academyId="acad-1"
        eventLabel={(k) => k}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    const confirm = await screen.findByTestId('cap-confirm');
    expect(confirm).toBeDisabled(); // no reason yet
    fireEvent.change(screen.getByTestId('cap-reason-input'), { target: { value: 'tournament week' } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    await waitFor(() => {
      const call = rpcMock.mock.calls.find((c) => c[0] === 'set_academy_notification_restriction');
      expect(call).toBeTruthy();
      expect(call![1].p_reason).toBe('tournament week');
      expect(String(call![1].p_request_id)).toMatch(/^[0-9a-f-]{36}$/);
      expect(call![1].p_max_frequency).toBe('off');
      expect(call![1].p_academy_profile_id).toBe('acad-1');
    });
  });

  it('a failed submit RETAINS the request id — the retry replays server-side instead of double-auditing', async () => {
    const { CapChangeDialog } = await import('@/components/academy/CapChangeDialog');
    rpcFails = true;
    render(
      <CapChangeDialog
        pending={{ event: 'booking_request_staff', channel: 'email', next: 'off' }}
        academyId="acad-1"
        eventLabel={(k) => k}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    fireEvent.change(await screen.findByTestId('cap-reason-input'), { target: { value: 'retry case' } });
    fireEvent.click(screen.getByTestId('cap-confirm'));
    await waitFor(() => expect(rpcMock.mock.calls.filter((c) => c[0] === 'set_academy_notification_restriction')).toHaveLength(1));
    rpcFails = false;
    fireEvent.click(screen.getByTestId('cap-confirm'));
    await waitFor(() => expect(rpcMock.mock.calls.filter((c) => c[0] === 'set_academy_notification_restriction')).toHaveLength(2));
    const [first, second] = rpcMock.mock.calls.filter((c) => c[0] === 'set_academy_notification_restriction');
    expect(first[1].p_request_id).toBe(second[1].p_request_id);
    expect(String(first[1].p_request_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the page wires every select change INTO the dialog — nothing saves without it', () => {
    const src = readFileSync(resolve(__dirname, '..', 'pages', 'academy', 'AcademyNotificationControls.tsx'), 'utf8');
    expect(src).toContain("onValueChange={(v) => setPending({ event, channel, next: v as CapValue })}");
    expect(src).toContain('<CapChangeDialog');
    // the page itself must have NO direct write path
    expect(src).not.toContain("supabase.rpc('set_academy_notification_restriction'");
  });

  it('a failed load renders RETRY — a manager acting on stale "inherit" is the failure mode', async () => {
    rpcFails = true;
    render(<AcademyNotificationControls />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('academy-notification-controls')).toBeNull();
  });
});
