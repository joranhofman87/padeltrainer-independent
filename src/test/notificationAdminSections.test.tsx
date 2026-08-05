import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

/**
 * N4 M7 — the extracted admin section components, tested directly for the states the page-level
 * suite cannot reach cheaply: LOADING, EMPTY, POPULATED, PAGINATION, LONG TEXT (truncation +
 * hover title), and the MOBILE/desktop rendering contract of the DataTable engine.
 */

const rpcMock = vi.fn();
vi.mock('@/lib/supabaseClient', () => ({
  supabase: { rpc: (fn: string, args?: Record<string, unknown>) => rpcMock(fn, args) },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, def?: string | Record<string, unknown>, opts?: Record<string, unknown>) => {
      const vars = (typeof def === 'string' ? opts : def) ?? {};
      const template = typeof def === 'string'
        ? def
        : String((def as Record<string, unknown> | undefined)?.defaultValue ?? key);
      return template.replace(/\{\{(\w+)\}\}/g, (_m, name) => String((vars as Record<string, unknown>)[name] ?? ''));
    },
  }),
}));

import { WorkerRunsSection } from '@/components/notifications/admin/WorkerRunsSection';
import { OrphanQueueSection } from '@/components/notifications/admin/OrphanQueueSection';
import { ReadinessPanel } from '@/components/notifications/admin/ReadinessPanel';
import { InvocationsSection } from '@/components/notifications/admin/InvocationsSection';

const TS = '2026-08-05T15:15:01.899123+00:00';
const LONG = 'a-very-long-event-key-that-must-truncate-'.repeat(4);

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockImplementation(() => Promise.resolve({ data: [], error: null }));
});

describe('OpsSection states (via WorkerRunsSection)', () => {
  it('starts UNLOADED with a Load button — an admin page must not fire six cross-tenant reads on mount', () => {
    render(<WorkerRunsSection />);
    expect(screen.getByTestId('runs-load')).toBeInTheDocument();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('EMPTY: a loaded-but-empty list renders the canonical EmptyState, not a bare table', async () => {
    render(<WorkerRunsSection />);
    fireEvent.click(screen.getByTestId('runs-load'));
    await screen.findByTestId('runs-empty');
    expect(screen.getByText('No worker runs in this window')).toBeInTheDocument();
    expect(screen.queryByTestId('runs-more')).toBeNull();   // nothing to page through
  });

  it('ERROR: renders an alert with a retry that re-issues the read', async () => {
    rpcMock.mockImplementation(() => Promise.resolve({ data: null, error: { message: 'boom' } }));
    render(<WorkerRunsSection />);
    fireEvent.click(screen.getByTestId('runs-load'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    rpcMock.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    fireEvent.click(screen.getByTestId('runs-retry'));
    await screen.findByTestId('runs-empty');
  });

  it('POPULATED + PAGINATION: a full page offers more; a short page is exhausted', async () => {
    const full = Array.from({ length: 25 }, (_, i) => ({
      run_id: `r${i}`, worker: 'w', channel: 'email', phase: 'dispatch', status: 'succeeded',
      started_at: TS, ended_at: TS,
    }));
    rpcMock.mockImplementationOnce(() => Promise.resolve({ data: full, error: null }));
    render(<WorkerRunsSection />);
    fireEvent.click(screen.getByTestId('runs-load'));
    await screen.findByTestId('runs-list');
    expect(screen.getByTestId('runs-more')).toBeInTheDocument();
    rpcMock.mockImplementationOnce(() => Promise.resolve({ data: [full[0]], error: null }));
    fireEvent.click(screen.getByTestId('runs-more'));
    await waitFor(() => expect(screen.queryByTestId('runs-more')).toBeNull());   // exhausted
    // the cursor is the LAST row's raw strings, verbatim
    const second = rpcMock.mock.calls.filter((c) => c[0] === 'admin_list_worker_runs')[1];
    expect(second[1].p_before_started_at).toBe(TS);
    expect(second[1].p_before_run_id).toBe('r24');
  });
});

describe('DataTable adoption: density, truncation and the mobile contract', () => {
  it('LONG TEXT truncates with a hover title, and the table renders on MOBILE (not desktop-only)', async () => {
    rpcMock.mockImplementationOnce(() => Promise.resolve({
      data: [{
        resend_event_id: LONG, channel: 'email', digest_group_id: 'g1', attempts: 3,
        last_error_code: 'tagged_mismatch', quarantined: true, next_eligible_at: TS, updated_at: TS,
      }],
      error: null,
    }));
    render(<OrphanQueueSection onAct={() => {}} />);
    fireEvent.click(screen.getByTestId('orphans-load'));
    await screen.findByTestId('orphans-list');
    const cell = screen.getByText(LONG);
    expect(cell.className).toContain('truncate');                     // the text element itself
    expect(cell.closest('td')?.getAttribute('title')).toBe(LONG);     // hover shows the full value
    // the engine's card frame must NOT be desktop-only for these compact operational tables
    const card = document.querySelector('[data-testid="orphans-list"] .hidden.md\\:block');
    expect(card).toBeNull();
  });

  it('actions render only where the server would accept them (quarantined rows)', async () => {
    rpcMock.mockImplementationOnce(() => Promise.resolve({
      data: [
        { resend_event_id: 'q1', channel: 'email', digest_group_id: 'g', attempts: 1, last_error_code: 'x', quarantined: true, next_eligible_at: TS, updated_at: TS },
        { resend_event_id: 'live', channel: 'email', digest_group_id: 'g', attempts: 1, last_error_code: 'x', quarantined: false, next_eligible_at: TS, updated_at: TS },
      ],
      error: null,
    }));
    render(<OrphanQueueSection onAct={() => {}} />);
    fireEvent.click(screen.getByTestId('orphans-load'));
    await screen.findByTestId('orphans-list');
    expect(screen.getByTestId('orphan-resolve-q1')).toBeInTheDocument();
    expect(screen.queryByTestId('orphan-resolve-live')).toBeNull();
  });
});

describe('Panels: loading and honest checks', () => {
  it('ReadinessPanel LOADING renders the skeleton, not defaults', () => {
    const { container } = render(
      <ReadinessPanel envelope={undefined} isLoading isError={false} onRetry={() => {}} />,
    );
    expect(screen.queryByTestId('readiness-envelope')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('ReadinessPanel renders every check verbatim, including not_provable', () => {
    render(
      <ReadinessPanel
        envelope={{
          schema_version: 1, as_of: TS, readiness: 'not_provable',
          checks: [{ id: 'durable_activation_boundary', status: 'not_provable', detail: 'N5 not shipped' }],
        }}
        isLoading={false} isError={false} onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId('check-durable_activation_boundary').textContent).toContain('N5 not shipped');
    // both the overall verdict and the check carry the badge — the panel never invents a pass
    expect(screen.getAllByTestId('status-not_provable').length).toBe(2);
  });

  it('InvocationsSection LOADING shows a skeleton; empty shows the engine empty text', () => {
    const { rerender, container } = render(
      <InvocationsSection rows={undefined} isLoading isError={false} onRetry={() => {}} />,
    );
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
    rerender(<InvocationsSection rows={[]} isLoading={false} isError={false} onRetry={() => {}} />);
    expect(screen.getByText('No deliberate invocations recorded')).toBeInTheDocument();
  });
});

/**
 * The FILTERED sections and the refresh seam. Radix Select internals cannot be operated under
 * jsdom (no layout APIs — the documented repo lesson), so the Select primitive is replaced with
 * a NATIVE test adapter: real option elements, real change events, and the section's own
 * onValueChange wiring under test. That covers filter → reset → RPC-argument behaviour without
 * pretending a Radix listbox opened.
 */
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)} data-testid="native-select">{children}</select>
  ),
  SelectTrigger: ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => <optgroup {...rest} label="trigger">{children}</optgroup>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => <option value={value}>{children}</option>,
}));

describe('filtered sections: filter → reset → RPC arguments, and the refresh seam', () => {
  it('changing a filter RESETS the list and re-issues the read with the new argument', async () => {
    const { DigestGroupsSection } = await import('@/components/notifications/admin/DigestGroupsSection');
    rpcMock.mockImplementation(() => Promise.resolve({
      data: [{
        id: 'g1', created_at: TS, event_type: 'ev', channel: 'email', state: 'request_ready',
        terminal_reason: null, item_count: 1, provider_attempts_started: 0, provider_message_id: null,
        first_send_at: null, uncertain_since: null, provider_status: null, delivery_budget_used: 0,
        digest_boundary_at: TS, available_at: TS, locked_by: null, worker_run_id: null, updated_at: TS,
      }],
      error: null,
    }));
    render(<DigestGroupsSection onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId('groups-load'));
    await screen.findByTestId('groups-list');
    // the filter is a NATIVE select here: changing it must clear the list AND scope the next read
    fireEvent.change(screen.getAllByTestId('native-select')[0], { target: { value: 'sent' } });
    await waitFor(() => expect(screen.getByTestId('groups-load')).toBeInTheDocument());   // reset to unloaded
    fireEvent.click(screen.getByTestId('groups-load'));
    await waitFor(() => {
      const last = rpcMock.mock.calls.filter((c) => c[0] === 'admin_list_digest_groups').at(-1)!;
      expect(last[1].p_state).toBe('sent');
      expect(last[1].p_before_created_at).toBeUndefined();   // the cursor reset with the scope
    });
  });

  it('the section publishes a RELOAD handle so a successful decision refreshes the list', async () => {
    const { OrphanQueueSection } = await import('@/components/notifications/admin/OrphanQueueSection');
    rpcMock.mockImplementation(() => Promise.resolve({ data: [], error: null }));
    let reload: (() => void) | null = null;
    render(<OrphanQueueSection onAct={() => {}} onReady={(r) => { reload = r; }} />);
    fireEvent.click(screen.getByTestId('orphans-load'));
    await screen.findByTestId('orphans-empty');
    const before = rpcMock.mock.calls.filter((c) => c[0] === 'admin_list_notification_orphans').length;
    expect(reload).toBeTruthy();
    reload!();
    await waitFor(() => {
      expect(rpcMock.mock.calls.filter((c) => c[0] === 'admin_list_notification_orphans').length).toBe(before + 1);
    });
  });

  it('a MISSING gauge row reads UNKNOWN and offers no kill button — fail-closed, never "live"', async () => {
    const { ChannelKillPanel } = await import('@/components/notifications/admin/ChannelKillPanel');
    render(<ChannelKillPanel gauges={[]} isLoading={false} isError={false} onRetry={() => {}} onKill={() => {}} />);
    expect(screen.getByTestId('kill-email').getAttribute('data-killed')).toBe('unknown');
    expect(screen.queryByTestId('kill-btn-email')).toBeNull();
    expect(screen.getByTestId('kill-email').textContent).toContain('UNKNOWN');
  });
});

describe('the repaired races are REGRESSION-LOCKED (each fails against the old behaviour)', () => {
  it('reload SUPERSEDES a pending load-more — the old load(false) handle would be swallowed by the lock', async () => {
    const { OrphanQueueSection } = await import('@/components/notifications/admin/OrphanQueueSection');
    const row = (id: string) => ({
      resend_event_id: id, channel: 'email', digest_group_id: 'g', attempts: 1,
      last_error_code: 'x', quarantined: true, next_eligible_at: TS, updated_at: TS,
    });
    // page 1 is FULL so "load more" is offered
    rpcMock.mockImplementationOnce(() => Promise.resolve({ data: Array.from({ length: 25 }, (_, i) => row(`p${i}`)), error: null }));
    let reload: (() => void) | null = null;
    render(<OrphanQueueSection onAct={() => {}} onReady={(r) => { reload = r; }} />);
    fireEvent.click(screen.getByTestId('orphans-load'));
    await screen.findByTestId('orphans-list');

    // a LOAD MORE is now pending (held open) — this is the state where the old handle died
    let releaseStale: ((v: { data: unknown; error: null }) => void) | null = null;
    rpcMock.mockImplementationOnce(() => new Promise((res) => { releaseStale = res; }));
    fireEvent.click(screen.getByTestId('orphans-more'));
    await new Promise((r) => setTimeout(r, 10));
    const callsBefore = rpcMock.mock.calls.filter((c) => c[0] === 'admin_list_notification_orphans').length;

    // the decision settles and demands a refresh: it MUST issue immediately, not be dropped
    rpcMock.mockImplementationOnce(() => Promise.resolve({ data: [row('fresh')], error: null }));
    reload!();
    await waitFor(() => {
      const calls = rpcMock.mock.calls.filter((c) => c[0] === 'admin_list_notification_orphans');
      expect(calls.length).toBe(callsBefore + 1);
      expect(calls.at(-1)![1].p_before_updated_at).toBeUndefined();   // an UNCURSORED first page
    });
    await screen.findByTestId('orphan-resolve-fresh');

    // the superseded page now returns — it must be DISCARDED, not appended
    releaseStale!({ data: [row('stale')], error: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('orphan-resolve-stale')).toBeNull();
    expect(screen.getByTestId('orphan-resolve-fresh')).toBeInTheDocument();
  });

  it('a filter change DURING an unresolved preview clears busy — the old code span forever', async () => {
    const { RecipientPreviewSection } = await import('@/components/notifications/admin/RecipientPreviewSection');
    let release: ((v: { data: unknown; error: null }) => void) | null = null;
    rpcMock.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    const { container } = render(<RecipientPreviewSection eventKeys={['ev_test']} />);
    // choose the event through the native adapter, then start the preview
    fireEvent.change(screen.getAllByTestId('native-select')[0], { target: { value: 'ev_test' } });
    fireEvent.click(screen.getByTestId('preview-load'));
    await waitFor(() => expect(container.querySelector('.animate-pulse')).toBeTruthy());   // loading
    // …now change the CHANNEL mid-flight: the scope reset must clear busy as well
    fireEvent.change(screen.getAllByTestId('native-select')[1], { target: { value: 'whatsapp' } });
    release!({ data: [], error: null });                     // the superseded response returns
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.animate-pulse')).toBeNull();   // NOT stuck loading
  });

  it('the busy label renders while a decision is in flight', async () => {
    const { OpsDecisionDialog } = await import('@/components/notifications/admin/OpsDecisionDialog');
    const props = {
      open: true, title: 'T', description: 'D', reason: 'a reason', onReasonChange: () => {},
      frozen: true, confirmLabel: 'Kill channel', busyLabel: 'Killing…', cancelLabel: 'Cancel',
      frozenNote: 'locked', testId: 'kill', onCancel: () => {}, onConfirm: () => {},
    };
    const { rerender } = render(<OpsDecisionDialog {...props} busy={false} />);
    expect(screen.getByTestId('kill-confirm').textContent).toBe('Kill channel');
    rerender(<OpsDecisionDialog {...props} busy />);
    expect(screen.getByTestId('kill-confirm').textContent).toBe('Killing…');
  });
});

describe('M7 round-2: provenance drill-down, history paging', () => {
  const DECISION = {
    event_type: 'ev_test', channel: 'email', catalog_supported: true, catalog_default: 'instant',
    required_delivery: false, explicit_preference: 'weekly', whatsapp_optin_arm: false,
    academy_cap: 'off', cap_applied: true, required_override_applied: false,
    final_frequency: 'off', contact_found: true, destination_masked: 'p***@x.nl',
    contact_source: 'contact',
    suppressed: false, kill_state: 'live', circuit_state: 'closed', final_decision: 'skip:frequency_off',
  };
  const openProvenanceWith = async (decision: Record<string, unknown>) => {
    const { RecipientPreviewSection } = await import('@/components/notifications/admin/RecipientPreviewSection');
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'admin_preview_notification_recipients') {
        return Promise.resolve({ data: [{ user_id: 'u1', final_frequency: null, final_decision: String(decision.final_decision), destination_masked: null, candidates_partial: false, next_cursor: 'u1' }], error: null });
      }
      if (fn === 'admin_preview_notification_decision') return Promise.resolve({ data: [decision], error: null });
      return Promise.resolve({ data: [], error: null });
    });
    render(<RecipientPreviewSection eventKeys={['ev_test']} />);
    fireEvent.change(screen.getAllByTestId('native-select')[0], { target: { value: 'ev_test' } });
    fireEvent.click(screen.getByTestId('preview-load'));
    await screen.findByTestId('preview-list');
    fireEvent.click(screen.getByTestId('provenance-btn-u1'));
    await screen.findByTestId('provenance-list');
    return screen.getByTestId('provenance-list').textContent ?? '';
  };

  it('SEAM round 2: the drill-down names WHICH source resolved the destination — a contact row or the account-email fallback', async () => {
    const text = await openProvenanceWith({
      ...DECISION, contact_source: 'account_email', destination_masked: 'f***@x.nl',
      final_frequency: 'instant', final_decision: 'deliver:instant',
    });
    expect(text).toContain('f***@x.nl');
    expect(text).toContain('account email — no contact row');   // the distinction reaches the operator
    expect(text).not.toContain('(contact row)');                // …and is not mislabelled as one
  });

  it('SEAM round 2: an UNSUPPORTED channel renders the ABSENCE of a resolution, not an empty gap', async () => {
    const text = await openProvenanceWith({
      ...DECISION, catalog_supported: false, explicit_preference: null, academy_cap: null,
      cap_applied: false, final_frequency: null, contact_found: false, contact_source: 'none',
      destination_masked: null, final_decision: 'skip:channel_unsupported',
    });
    expect(text).toContain('unsupported');
    expect(text).toContain('skip:channel_unsupported');
    expect(text).toContain('— → skip:channel_unsupported');   // final_frequency NULL, rendered
    expect(text).not.toContain('APPLIED');
  });

  it('the preview exposes EVERY contributing source per user, scoped to the academy context', async () => {
    const { RecipientPreviewSection } = await import('@/components/notifications/admin/RecipientPreviewSection');
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'admin_preview_notification_recipients') {
        return Promise.resolve({ data: [{ user_id: 'u1', final_frequency: 'off', final_decision: 'skip:frequency_off', destination_masked: 'p***@x.nl', candidates_partial: false, next_cursor: 'u1' }], error: null });
      }
      if (fn === 'admin_preview_notification_decision') return Promise.resolve({ data: [DECISION], error: null });
      return Promise.resolve({ data: [], error: null });
    });
    render(<RecipientPreviewSection eventKeys={['ev_test']} />);
    fireEvent.change(screen.getAllByTestId('native-select')[0], { target: { value: 'ev_test' } });
    fireEvent.change(screen.getByTestId('preview-academy'), { target: { value: 'acad-1' } });
    fireEvent.click(screen.getByTestId('preview-load'));
    await screen.findByTestId('preview-list');
    // the academy context reaches the LIST read (tenant caps are tenant-specific)
    expect(rpcMock.mock.calls.find((c) => c[0] === 'admin_preview_notification_recipients')![1].p_tenant_academy_profile_id).toBe('acad-1');
    fireEvent.click(screen.getByTestId('provenance-btn-u1'));
    await screen.findByTestId('provenance-list');
    const call = rpcMock.mock.calls.find((c) => c[0] === 'admin_preview_notification_decision')!;
    expect(call[1]).toMatchObject({ p_user_id: 'u1', p_event_key: 'ev_test', p_channel: 'email', p_tenant_academy_profile_id: 'acad-1' });
    const text = screen.getByTestId('provenance-list').textContent ?? '';
    for (const expected of ['catalog', 'explicit preference', 'academy cap', 'required override',
      'contact', 'suppressed', 'kill / circuit', 'final']) {
      expect(text).toContain(expected);
    }
    expect(text).toContain('weekly');       // the explicit preference source
    expect(text).toContain('APPLIED');      // the cap that actually decided it
    expect(text).toContain('skip:frequency_off');
  });

  it('a failed provenance read is FAIL-CLOSED with a retry — never a blank panel', async () => {
    const { RecipientPreviewSection } = await import('@/components/notifications/admin/RecipientPreviewSection');
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'admin_preview_notification_recipients') {
        return Promise.resolve({ data: [{ user_id: 'u1', final_frequency: 'off', final_decision: 'skip:frequency_off', destination_masked: 'x', candidates_partial: false, next_cursor: 'u1' }], error: null });
      }
      if (fn === 'admin_preview_notification_decision') return Promise.resolve({ data: null, error: { message: 'boom' } });
      return Promise.resolve({ data: [], error: null });
    });
    render(<RecipientPreviewSection eventKeys={['ev_test']} />);
    fireEvent.change(screen.getAllByTestId('native-select')[0], { target: { value: 'ev_test' } });
    fireEvent.click(screen.getByTestId('preview-load'));
    await screen.findByTestId('preview-list');
    fireEvent.click(screen.getByTestId('provenance-btn-u1'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByTestId('provenance-list')).toBeNull();
  });
});
