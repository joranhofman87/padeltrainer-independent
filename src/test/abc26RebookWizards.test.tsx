import type { ReactElement } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18n from 'i18next';
import enCycles from '@/i18n/locales/en/cycles.json';
import enCommon from '@/i18n/locales/en/common.json';

/**
 * ABC-26 — the two rebooking wizards, exercised through the surfaces an operator actually touches.
 *
 * The claims under test, all of which the previous shape got wrong somewhere:
 *
 *   • a typed 409 refusal reaches the screen as a persistent, focused alert — and nothing is sent;
 *   • an UNVERIFIED creation shows an "we could not confirm" alert, drains zero, and NEVER
 *     navigates or shows success;
 *   • a no-work result stays on screen instead of evaporating with a toast;
 *   • the send button is blocked while a review is pending, stale or superseded, and the handler
 *     re-checks the same condition;
 *   • an out-of-order preview response cannot replace a newer one.
 */

// ── Module doubles ──────────────────────────────────────────────────────────────────────────
const invokeMock = vi.hoisted(() => vi.fn());
const rpcMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({
  success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
}));

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    functions: { invoke: (...a: unknown[]) => invokeMock(...a) },
    rpc: (...a: unknown[]) => rpcMock(...a),
  },
}));
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});
vi.mock('@/lib/academy', () => ({
  getAcademyLocationsWithDetails: async () => [
    { location: { id: LOC1, name: 'Court One', city: 'Amsterdam' } },
  ],
}));
vi.mock('@/lib/cycles', () => ({
  getCycles: async () => [{ id: SRC, type: 'cyclus', name: 'Spring', settings: {} }],
}));
vi.mock('@/lib/cyclusLabel', () => ({
  fetchCyclusLabels: async () => new Map(),
  buildCyclusLabel: () => undefined,
}));
vi.mock('@/lib/rebookRoundExtend', () => ({
  getRebookRoundExtendPrefill: async () => null,
  suggestTermEndFromSources: async () => '',
}));
vi.mock('@/lib/rebookPaymentEligibility', () => ({
  getAcademyUpfrontEligibility: vi.fn().mockResolvedValue({
    canCharge: false,
    mollieReady: false,
    invoiceReady: false,
  }),
}));
vi.mock('@/components/ui/date-picker-popover', () => ({
  DatePickerPopover: ({ onChange }: { onChange: (date: Date | undefined) => void }) => (
    <button
      type="button"
      data-testid="date-picker"
      onClick={(event) => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="date-picker"]'));
        const order = buttons.indexOf(event.currentTarget);
        onChange(new Date(2026, 8, 21 + (order * 7)));
      }}
    >
      Pick test date
    </button>
  ),
}));
/**
 * The drain is the thing that must NOT run on a refused/unknown outcome — and MUST run on a
 * created one.
 *
 * REVIEW ROUND 5: REPLACING THE EXPORT WAS NOT ENOUGH. `createAndDrainRebookRound` calls
 * `deps.drain ?? drainRebookRoundInvites` (`rebookInviteSend.ts:629`), and that fallback is an
 * INTERNAL module binding — swapping the export left it pointing at the real function. So this
 * mock could never fire, and every `expect(drainMock).not.toHaveBeenCalled()` in this file was
 * vacuously true: it would have passed if a wizard had drained a thousand rounds. Injecting the
 * dependency through the exported entry point is what actually intercepts it.
 */
const drainMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/rebookInviteSend', async (orig) => {
  const actual = await orig<typeof import('@/lib/rebookInviteSend')>();
  const drain = (...a: unknown[]) => drainMock(...a);
  return {
    ...actual,
    drainRebookRoundInvites: drain,
    createAndDrainRebookRound: (
      body: Parameters<typeof actual.createAndDrainRebookRound>[0],
      deps: Parameters<typeof actual.createAndDrainRebookRound>[1],
      session: Parameters<typeof actual.createAndDrainRebookRound>[2],
      reviewed: Parameters<typeof actual.createAndDrainRebookRound>[3],
    ) => actual.createAndDrainRebookRound(
      body, { ...deps, drain: drain as unknown as typeof actual.drainRebookRoundInvites },
      session, reviewed),
  };
});

import RebookCohortWizard from '@/components/cycles/RebookCohortWizard';
import AcademyNewRoundWizard from '@/components/cycles/AcademyNewRoundWizard';
import {
  PriorityRefusalAlert,
  PriorityUnavailableExplanation,
  RoundNoWorkNotice,
  RoundUnknownAlert,
} from '@/components/cycles/PriorityUnavailableNotice';

const inst = i18n.createInstance();
void inst.use(initReactI18next).init({
  lng: 'en', fallbackLng: 'en',
  resources: { en: { cycles: enCycles, common: enCommon } },
  ns: ['cycles', 'common'], defaultNS: 'cycles',
  interpolation: { escapeValue: false },
});

const renderIn = (ui: ReactElement, initialEntries: string[] = ['/']) =>
  render(<I18nextProvider i18n={inst}><MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter></I18nextProvider>);

const CY1 = '11111111-1111-4111-8111-111111111111';
// A REAL UUID. `academyProfileId` is a uuid column and the typed intent validates it rather
// than coercing — a placeholder like 'ac1' is refused before a call is made, which is correct
// and which the old edge-function fixture never had to care about.
const ACADEMY = '99999999-9999-4999-8999-999999999999';
const LOC1 = '88888888-8888-4888-8888-888888888888';
// REVIEW ROUND 2 (P3): A REAL UUID. `cyc-src` is not one, so the driver rejected it and every
// 'source cycle' test was silently exercising COHORT mode with no locations — the opposite of
// what its name said.
const SRC = '77777777-7777-4777-8777-777777777777';
const ROUNDX = '66666666-6666-4666-8666-666666666666';

// ── The typed selection surface, as the wizards now see it ──────────────────────────────────
//
// The 409 `FunctionsHttpError` carrying an ABC-26 priority refusal is GONE from these fixtures,
// and its absence is itself a finding worth stating: the typed intent has no priority fields at
// all, so a client cannot submit supplementary priority and the server has nothing to refuse. What
// was a runtime refusal is now a structural impossibility, which is strictly stronger — and it is
// asserted below rather than left as a claim.

/** One `result` row, with only the fields a case exercises. */
const resultRow = (over: Record<string, unknown> = {}) => ({
  row_kind: 'result', status: 'previewed', contract_version: 'abc27.wire.v1',
  review_fingerprint: '\\x0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de0badc0de', selection_digest: '\\xd19657', apply_eligibility: 'eligible',
  child_count: 1, source_count: 8, cohort_total: 4, occurrence_count: 8, claim_count: 32,
  total_sessions: 32, no_email_total: 0, grand_invoice_total: '640.00', already_sent_groups: 0,
  source_term_weeks: 8, source_modal_price: '20.00', source_prices_include_vat: true,
  ...over,
});

const seriesRow = (over: Record<string, unknown> = {}) => ({
  row_kind: 'series', series_key: 'k1', child_cycle_id: CY1, series_excluded: false,
  target_name: 'Next round — Ma 18:00', local_weekday: 1, local_time: '18:00:00',
  trainer_id: null, trainer_name: null, location_id: LOC1, location_name: 'Court One',
  max_participants: 4, source_price: '20.00', split_payment: false, prices_include_vat: true,
  subject_count: 4, sessions: 8, invoice_total: '160.00', no_email_count: 0,
  ...over,
});

/**
 * A FAITHFUL ROSTER: one row per (series, recipient), which is what the surface emits.
 *
 * REVIEW ROUND 4 (P1): the fixture used to ship ONE roster row beside a series claiming four
 * subjects — the exact shape a PostgREST row cap produces, and the shape the decoder now refuses.
 * A fake that could not express a truncated answer could not have caught one either.
 */
const rosterRows = (n: number) => Array.from({ length: n }, (_, i) => ({
  // REVIEW ROUND 5 (P1): the first two SHARE A NAME on purpose. Round 4 keyed the decoder's
  // reconciliation on the display name, so two real people called the same thing were counted as
  // one and the whole answer was refused — a cohort with a repeated name could not be sent by
  // either wizard. Unique fixture names hid that completely.
  row_kind: 'roster', series_key: 'k1', display_name: i < 2 ? 'Jan de Vries' : `Speler ${i}`,
  has_email: true,
}));

/** A preview answer: the result row, its series and (on review) the roster. */
const previewAnswer = (over: Record<string, unknown> = {}) => {
  const result = resultRow(over);
  const series = seriesRow({ subject_count: result.cohort_total });
  return { data: [result, series, ...rosterRows(series.subject_count as number)], error: null };
};

/**
 * The scripted surface. The PROBE is told from the REVIEW by whether the caller minted identities
 * yet — the same way the server tells them apart — so a fake that ignored it would let a driver bug
 * through.
 */
const scriptSurface = (opts: { probe?: Record<string, unknown>; review?: Record<string, unknown>; apply?: unknown } = {}) => {
  rpcMock.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'rebook_round_selection_apply_as_actor') {
      // THE COMMAND ID IS ECHOED, because the real surface echoes it.
      //
      // REVIEW ROUND 5 (P3): this returned a FIXED uuid while the wizard mints a random one per
      // send, so the driver's identity check rejected every scripted apply and every nominal
      // "success" case actually exercised the `unknown` branch. The tests proved call shape and
      // double-click behaviour, and nothing at all about drain, toast or navigation.
      // THE ROUND ID IS ECHOED TOO, for the reason the command id is.
      //
      // REVIEW ROUND 1 (P2) of the closure added a pin that the applied round must be THE round
      // this client minted, not merely a well-formed uuid — a stale or reused command could
      // otherwise be finished against somebody else's round. A fixture returning a FIXED round id
      // against a wizard that mints a random one describes an answer the server never sends, and
      // would route every case down the failure branch exactly as the fixed command id did.
      return { data: opts.apply ?? [{
        status: 'applied', round_id: args.p_round_id,
        command_id: args.p_command_id,
        child_count: 1, occurrence_count: 8, claim_count: 32, child_cycle_ids: [CY1],
      }], error: null };
    }
    const minted = (args.p_target_slot_ids as unknown[] | null) ?? [];
    if (minted.length === 0 && args.p_projection === 'review') {
      return previewAnswer({ status: 'invalid_request', review_fingerprint: null, ...opts.probe });
    }
    return previewAnswer(opts.review ?? {});
  });
};

beforeEach(() => {
  vi.useRealTimers();
  invokeMock.mockReset();
  rpcMock.mockReset();
  navigateMock.mockReset();
  drainMock.mockReset();
  drainMock.mockResolvedValue({ totalSent: 4, leftover: 0, outcome: 'drained', sampleError: null });
  window.scrollTo = vi.fn();
  for (const fn of Object.values(toastMock)) (fn as ReturnType<typeof vi.fn>).mockReset();
});

// ── The academy "new round" wizard ──────────────────────────────────────────────────────────

describe('ABC-26 · AcademyNewRoundWizard — terminal outcomes are persistent, never toasts', () => {
  it('the unavailable explanation is on screen from the start, with no member window toggled', async () => {
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />);
    expect(await screen.findByTestId('new-round-priority-unavailable')).toBeTruthy();
  });

  it('A MOVED SELECTION on PREVIEW becomes a focused alert, and no review opens', async () => {
    // THIS TEST REPLACES A 409 PRIORITY REFUSAL, and the swap is the point. Supplementary priority
    // cannot be submitted through the typed intent — it has no priority fields — so the refusal
    // this used to drive is now structurally impossible rather than caught at runtime. The RULE it
    // protected is unchanged and is what is asserted here: a terminal outcome is a persistent,
    // focused alert; no review opens; nothing is drained; nothing is navigated to.
    scriptSurface({ probe: { status: 'selection_moved' } });
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />, [`/?source=${SRC}`]);
    await screen.findByText(enCycles.newRound.source);
    const pickers = screen.getAllByTestId('date-picker');
    fireEvent.click(pickers[0]);
    // THE END DATE IS SET. Leaving it blank is a real flow with its own test below; every other
    // case states the length explicitly, which is what the typed core requires.
    if (pickers[1]) fireEvent.click(pickers[1]);
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));

    const alert = await screen.findByTestId('round-selection-moved');
    expect(document.activeElement).toBe(alert);
    expect(screen.queryByText(enCycles.newRound.reviewTitle), 'no review may open').toBeNull();
    expect(drainMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    // …and the retired producer was never asked, on any path.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('THE BROWSER SENDS NO SOURCE SLOTS AND NO PRIORITY, on any call', async () => {
    scriptSurface();
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />, [`/?source=${SRC}`]);
    await screen.findByText(enCycles.newRound.source);
    const pickers = screen.getAllByTestId('date-picker');
    fireEvent.click(pickers[0]);
    // THE END DATE IS SET. Leaving it blank is a real flow with its own test below; every other
    // case states the length explicitly, which is what the typed core requires.
    if (pickers[1]) fireEvent.click(pickers[1]);
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
    await screen.findByText(enCycles.newRound.reviewTitle);

    expect(rpcMock.mock.calls.length).toBeGreaterThan(0);
    for (const [fn, args] of rpcMock.mock.calls as Array<[string, Record<string, unknown>]>) {
      const keys = Object.keys(args);
      expect(keys, `${fn} must not carry source slots`).not.toContain('p_source_slot_ids');
      expect(keys, `${fn} must not carry child cycles`).not.toContain('p_child_cycle_ids');
      // The typed intent has no priority parameters at all — this is the structural refusal.
      expect(keys.filter((k) => k.includes('priority') && k !== 'p_priority_days')).toEqual([]);
    }
  });

  /**
   * A review the operator can actually SEND.
   *
   * The wizard prefills the end date from the source-term recommendation the first time it sees
   * one — and that field is part of `baseBody`, so the prefill changes `bodyRevision` and correctly
   * marks the review it just produced as stale. That is real product behaviour (the operator
   * re-reviews after a prefill), so a test about sending scripts a source term that offers nothing
   * to prefill.
   *
   * REVIEW ROUND 5 (P3): THE PRICE IS NO LONGER AMONG THEM. Round 4 removed that prefill, because
   * a prefilled price made the round apply-INELIGIBLE and re-reviewing simply refilled it — the
   * round could never be sent at all. This comment still described the old behaviour.
   */
  const sendableSurface = (over: { apply?: unknown } = {}) => scriptSurface({
    probe: { source_term_weeks: 0, source_modal_price: null },
    review: { source_term_weeks: 0, source_modal_price: null },
    ...over,
  });

  it('an UNKNOWN creation never navigates and never shows success', async () => {
    // The review succeeds; the APPLY answers with a round id that is not a uuid, so nothing about
    // the creation can be verified. That is `unknown` — never "no round exists", and never a
    // success — and the drain must not run against a round whose existence was not established.
    sendableSurface({ apply: [{ status: 'applied', round_id: 'not-a-uuid', child_cycle_ids: [CY1] }] });
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />, [`/?source=${SRC}`]);
    await screen.findByText(enCycles.newRound.source);
    const pickers = screen.getAllByTestId('date-picker');
    fireEvent.click(pickers[0]);
    // THE END DATE IS SET. Leaving it blank is a real flow with its own test below; every other
    // case states the length explicitly, which is what the typed core requires.
    if (pickers[1]) fireEvent.click(pickers[1]);
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
    await screen.findByText(enCycles.newRound.reviewTitle);
    fireEvent.click(screen.getByTestId('new-round-send'));

    const alert = await screen.findByTestId('round-unknown');
    expect(alert).toHaveAttribute('data-unknown-reason', 'transport_error');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(drainMock).not.toHaveBeenCalled();
    expect(invokeMock, 'the retired producer is never reached').not.toHaveBeenCalled();
  });

  it('THE SAME ROUND UUID AND DIGEST are re-sent on the apply, so a retry cannot double-create', async () => {
    sendableSurface();
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />, [`/?source=${SRC}`]);
    await screen.findByText(enCycles.newRound.source);
    const pickers = screen.getAllByTestId('date-picker');
    fireEvent.click(pickers[0]);
    // THE END DATE IS SET. Leaving it blank is a real flow with its own test below; every other
    // case states the length explicitly, which is what the typed core requires.
    if (pickers[1]) fireEvent.click(pickers[1]);
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
    await screen.findByText(enCycles.newRound.reviewTitle);
    fireEvent.click(screen.getByTestId('new-round-send'));
    await act(async () => { await Promise.resolve(); });

    const calls = rpcMock.mock.calls as Array<[string, Record<string, unknown>]>;
    const rounds = new Set(calls.map(([, a]) => a.p_round_id as string));
    expect(rounds.size, 'ONE client-minted round uuid for the whole conversation').toBe(1);
    const apply = calls.find(([fn]) => fn === 'rebook_round_selection_apply_as_actor');
    expect(apply, 'the apply ran').toBeTruthy();
    expect(apply![1].p_selection_digest, 'and it names the selection the review was produced under')
      .toBe('\\xd19657');
  });
});

// ── The cohort wizard ───────────────────────────────────────────────────────────────────────

describe('ABC-26 · RebookCohortWizard — the containment surfaces', () => {
  it('renders the unavailable explanation unconditionally', async () => {
    scriptSurface();
    renderIn(<RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" />);
    expect(await screen.findByTestId('cohort-priority-unavailable')).toBeTruthy();
  });

  it('the "next: review" button is blocked until a cohort has been counted', async () => {
    scriptSurface({ probe: { cohort_total: 0, child_count: 0 }, review: { cohort_total: 0, child_count: 0 } });
    renderIn(<RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" />);
    const btn = await screen.findByTestId('cohort-to-review');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('a MOVED SELECTION clears the cohort count and shows a persistent alert', async () => {
    // The cohort auto-count asks the COUNTING projection — locations and dates alone, which the
    // typed core cannot judge — and a moved selection clears the count rather than leaving a
    // number on screen that the server no longer stands behind.
    scriptSurface({ probe: { status: 'selection_moved' }, review: { status: 'selection_moved' } });
    renderIn(<RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" />);
    const location = await screen.findByText('Court One');
    vi.useFakeTimers();
    fireEvent.click(location);
    const dates = screen.getAllByTestId('date-picker');
    fireEvent.click(dates[0]);
    fireEvent.click(dates[1]);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    const alert = screen.getByTestId('cohort-round-selection-moved');
    expect(document.activeElement).toBe(alert);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][0]).toBe('rebook_round_selection_preview_as_actor');
    expect(rpcMock.mock.calls[0][1], 'the auto-count is the ADVISORY projection').toMatchObject({
      p_projection: 'counts', p_location_ids: [LOC1],
    });
    expect(screen.getByTestId('cohort-to-review')).toBeDisabled();
    expect(drainMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(invokeMock, 'the retired producer is never reached').not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('nothing is ever sent from the configure step', async () => {
    scriptSurface();
    renderIn(<RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" />);
    await screen.findByTestId('cohort-priority-unavailable');
    expect(drainMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

// ── The shared notice component: a11y and stable keys ───────────────────────────────────────


describe('ABC-26 · the shared notice component', () => {
  const wrap = (ui: ReactElement) => render(<I18nextProvider i18n={inst}>{ui}</I18nextProvider>);

  it('a refusal is announced, focusable and keyed on the STRUCTURED reason', () => {
    wrap(<PriorityRefusalAlert reason="priority_unavailable" submitted={4} />);
    const alert = screen.getByTestId('priority-refusal');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(alert.getAttribute('tabindex')).toBe('-1');
    // The key is the enum value, not a translated string — so it survives a language change.
    expect(alert.getAttribute('data-refusal-reason')).toBe('priority_unavailable');
  });

  it('a refusal takes focus, so a keyboard user is not left where the button was', () => {
    wrap(<PriorityRefusalAlert reason="malformed_input" submitted={0} />);
    expect(document.activeElement).toBe(screen.getByTestId('priority-refusal'));
  });

  it.each([
    'priority_unavailable', 'unsupported_protocol_version', 'blank_identifier',
    'invalid_identifier', 'malformed_input', 'duplicate_identifier', 'too_many_submitted',
  ] as const)('every refusal reason renders localized copy, never a raw key: %s', (reason) => {
    const { unmount } = wrap(<PriorityRefusalAlert reason={reason} submitted={2} />);
    const text = screen.getByTestId('priority-refusal').textContent ?? '';
    expect(text).not.toContain('newRound.priority.refusal');
    expect(text.length).toBeGreaterThan(20);
    unmount();
  });

  it('an unknown outcome is announced and preserves a target cycle id as DATA, not a link', () => {
    wrap(<RoundUnknownAlert reason="transport_error" targetCycleId={CY1} />);
    const alert = screen.getByTestId('round-unknown');
    expect(alert.getAttribute('data-unknown-reason')).toBe('transport_error');
    expect(alert.getAttribute('data-target-cycle-id')).toBe(CY1);
    // Nothing here may navigate: the round is not known to exist.
    expect(alert.querySelector('a')).toBeNull();
  });

  it.each(['unreadable_response', 'unverified_creation', 'unsupported_inline_delivery', 'transport_error'] as const)(
    'unknown reason %s renders copy that does NOT claim the round failed', (reason) => {
      const { unmount } = wrap(<RoundUnknownAlert reason={reason} />);
      const text = (screen.getByTestId('round-unknown').textContent ?? '').toLowerCase();
      expect(text).not.toContain('newRound.outcome.unknown');
      // The honest shape: it may or may not exist, and nothing was sent from this page.
      expect(text).toMatch(/may or may not|cannot tell|cannot confirm/);
      unmount();
    },
  );

  it('nothing renders when there is no outcome — the notices are not always-on furniture', () => {
    wrap(<><PriorityRefusalAlert reason={null} submitted={0} /><RoundUnknownAlert reason={null} /><RoundNoWorkNotice shown={false} /></>);
    expect(screen.queryByTestId('priority-refusal')).toBeNull();
    expect(screen.queryByTestId('round-unknown')).toBeNull();
    expect(screen.queryByTestId('round-no-work')).toBeNull();
  });

  it('the no-work notice is persistent and announced, not a toast', () => {
    wrap(<RoundNoWorkNotice shown />);
    const notice = screen.getByTestId('round-no-work');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('the standing explanation is a note, not an alert — it is not an error', () => {
    wrap(<PriorityUnavailableExplanation />);
    expect(screen.getByTestId('priority-unavailable').getAttribute('role')).toBe('note');
  });
});

// ── D7 · THE CUTOVER'S FLOW CONTROLS, FOR BOTH WIZARDS ──────────────────────────────────────
//
// The claims the cutover has to keep at the surface an operator touches, rather than only at the
// boundary: a stale selection is RECOVERABLE, the retired producer is never reached, one send is
// one apply, and a typed refusal neither navigates nor celebrates.

describe('D7 · both wizards — selection recovery, no legacy producer, no duplicate apply', () => {
  const openNewRoundReview = async () => {
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />, [`/?source=${SRC}`]);
    await screen.findByText(enCycles.newRound.source);
    const pickers = screen.getAllByTestId('date-picker');
    fireEvent.click(pickers[0]);
    // THE END DATE IS SET. Leaving it blank is a real flow with its own test below; every other
    // case states the length explicitly, which is what the typed core requires.
    if (pickers[1]) fireEvent.click(pickers[1]);
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
  };

  it('NEW ROUND: a moved selection is RECOVERED by asking again — the notice clears and the review opens', async () => {
    // RECOVERY IS THE POINT OF THE DISTINCT OUTCOME. `unknown` tells an operator to go and look at
    // another page; this one tells them to look again here, so "looking again here" has to work.
    scriptSurface({ probe: { status: 'selection_moved' } });
    await openNewRoundReview();
    await screen.findByTestId('round-selection-moved');
    expect(screen.queryByText(enCycles.newRound.reviewTitle)).toBeNull();

    // The source settles; the operator asks again from the same page.
    scriptSurface({ probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null } });
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
    await screen.findByText(enCycles.newRound.reviewTitle);
    expect(screen.queryByTestId('round-selection-moved'), 'the notice clears with the outcome').toBeNull();
    expect((screen.getByTestId('new-round-send') as HTMLButtonElement).disabled,
      'and the send is armed again').toBe(false);
  });

  it('NEW ROUND: one send is ONE apply, and a second click cannot double it', async () => {
    scriptSurface({ probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null } });
    await openNewRoundReview();
    await screen.findByText(enCycles.newRound.reviewTitle);
    const send = screen.getByTestId('new-round-send');
    fireEvent.click(send);
    fireEvent.click(send);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const applies = rpcMock.mock.calls.filter(([fn]) => fn === 'rebook_round_selection_apply_as_actor');
    expect(applies.length, 'the second click is a no-op while the first is in flight').toBe(1);
    // …and if it HAD reached the server twice, it would have carried the same command uuid, which
    // is what makes the second one a replay rather than a second round.
    expect(applies[0][1] as Record<string, unknown>).toHaveProperty('p_command_id');
  });

  it('NEW ROUND: a TYPED REFUSAL from the apply neither navigates nor celebrates', async () => {
    scriptSurface({
      probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null },
      apply: [{ status: 'source_drift', round_id: null, child_cycle_ids: null }],
    });
    await openNewRoundReview();
    await screen.findByText(enCycles.newRound.reviewTitle);
    fireEvent.click(screen.getByTestId('new-round-send'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(navigateMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(drainMock, 'nothing is drained against a round that was refused').not.toHaveBeenCalled();
  });

  /**
   * Render the cohort wizard and fire its debounced auto-count.
   *
   * FAKE TIMERS GO IN AFTER THE FIRST `findBy`, never before: `findBy*` polls on a timer, so
   * installing them first makes the very first await hang until the test times out.
   */
  const countCohort = async () => {
    renderIn(<RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" />);
    const location = await screen.findByText('Court One');
    vi.useFakeTimers();
    fireEvent.click(location);
    const dates = screen.getAllByTestId('date-picker');
    fireEvent.click(dates[0]);
    fireEvent.click(dates[1]);
  };

  it('COHORT: a moved selection is RECOVERED by the next count', async () => {
    scriptSurface({ probe: { status: 'selection_moved' }, review: { status: 'selection_moved' } });
    await countCohort();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByTestId('cohort-round-selection-moved')).toBeTruthy();

    // The operator changes the selection; the debounced count runs again and the notice clears.
    //
    // The location is toggled OFF and back ON rather than re-clicking a date: the date-picker
    // double emits the same value every time, so a second click changes no state and the effect
    // never re-runs — a "recovery" that never asked the server again would pass for the wrong
    // reason.
    scriptSurface();
    const loc = screen.getByText('Court One');
    fireEvent.click(loc);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    fireEvent.click(loc);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.queryByTestId('cohort-round-selection-moved'), 'the notice clears').toBeNull();
    vi.useRealTimers();
  });

  it('COHORT: the auto-count is ADVISORY — it never carries a fingerprint, so it cannot arm a send', async () => {
    scriptSurface({ probe: { status: 'counted', review_fingerprint: null } });
    await countCohort();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    const counts = rpcMock.mock.calls.filter(([, a]) => (a as Record<string, unknown>).p_projection === 'counts');
    expect(counts.length, 'the count ran').toBeGreaterThan(0);
    expect(counts.every(([, a]) => (a as Record<string, unknown>).p_target_slot_ids === undefined
      || ((a as Record<string, unknown>).p_target_slot_ids as unknown[]).length === 0),
    'a count never mints identities').toBe(true);
    // Nothing was applied, and nothing could have been: the counting projection returns no
    // fingerprint and the send is the only thing that could use one.
    expect(rpcMock.mock.calls.some(([fn]) => fn === 'rebook_round_selection_apply_as_actor')).toBe(false);
  });

  it('BOTH: the retired producer is never invoked, on any path', async () => {
    scriptSurface();
    await openNewRoundReview();
    await act(async () => { await Promise.resolve(); });
    await countCohort();
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();
    expect(invokeMock, 'no wizard reaches bulk-rebook-cycle any more').not.toHaveBeenCalled();
  });
});

// ── ROUND 2 · WHAT THE SECOND ADVERSARIAL PASS FOUND ────────────────────────────────────────

describe('round-2 corrections — source mode, an explicit length, and the withheld send', () => {
  const openNewRound = async (opts: { endDate?: boolean } = {}) => {
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />, [`/?source=${SRC}`]);
    await screen.findByText(enCycles.newRound.source);
    const pickers = screen.getAllByTestId('date-picker');
    fireEvent.click(pickers[0]);
    if (opts.endDate !== false && pickers[1]) fireEvent.click(pickers[1]);
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
  };

  it('P3 · THE WIZARD REALLY IS IN SOURCE-CYCLE MODE, and names the cycle it was opened with', async () => {
    // The fixture used to carry `cyc-src`, which the driver rejects as a uuid — so every test that
    // claimed to exercise a source cycle was exercising the cohort path with no locations. The
    // assertions still passed, which is what made it worth finding.
    scriptSurface({ probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null } });
    await openNewRound();
    await screen.findByText(enCycles.newRound.reviewTitle);
    const [, args] = rpcMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.p_selection_mode).toBe('source_cycle');
    expect(args.p_source_cycle_id).toBe(SRC);
    expect(args.p_location_ids, 'and carries no cohort selection').toBeNull();
  });

  it('P1 · THE REVIEW RENDERS THE SERVER-DERIVED NAME, not the label the operator typed', async () => {
    // ROUND 4 (P3): the fixture already returned the distinctive `Next round — Ma 18:00` and no
    // assertion ever looked for it, so reverting either wizard's use of `targetCycles` left the
    // suite green — a fix with no sensor.
    scriptSurface({ probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null } });
    await openNewRound();
    await screen.findByText(enCycles.newRound.reviewTitle);
    expect(screen.getByText(/Next round — Ma 18:00/),
      'the name the database will actually write').toBeTruthy();
  });

  it('P1 · A BLANK END DATE ASKS FOR THE SOURCE TERM instead of reporting "nothing to rebook"', async () => {
    // The screen offers "leave the end date blank to reuse the previous round's length"; the typed
    // core refuses an intent with neither an end date nor a week count. The blank flow therefore
    // died on a refusal it could never recover from — before reaching the suggestion that fills it.
    scriptSurface({ probe: { status: 'counted', review_fingerprint: null, source_term_weeks: 8 } });
    await openNewRound({ endDate: false });
    await act(async () => { await Promise.resolve(); });

    const projections = (rpcMock.mock.calls as Array<[string, Record<string, unknown>]>)
      .map(([, a]) => a.p_projection);
    expect(projections[0], 'the COUNTING projection, which can answer without a length').toBe('counts');
    expect(screen.queryByTestId('round-no-work'), 'and no "nothing to rebook"').toBeNull();
    // The length is DISPLAYED, not substituted: the operator confirms it and reviews again.
    expect(screen.queryByText(enCycles.newRound.reviewTitle),
      'no review opens on a length the operator has not seen').toBeNull();

    // ROUND 3 (P3): AND THE FIELD WAS ACTUALLY FILLED. Without this the test passed for a wizard
    // that counted forever and never progressed — the early return alone would have satisfied it.
    scriptSurface({ probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null } });
    rpcMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
    await screen.findByText(enCycles.newRound.reviewTitle);
    const second = (rpcMock.mock.calls as Array<[string, Record<string, unknown>]>);
    expect(second.every(([, a]) => a.p_projection === 'review'),
      'the second click reviews — the length is no longer missing').toBe(true);
    expect(second[0][1].p_target_end, 'and it carries the end date the count filled in').not.toBeNull();
  });

  it('P2 · AN APPLY-INELIGIBLE REVIEW STAYS ON SCREEN while the send is withheld', async () => {
    // The mitigation for the session-price blocker is that the operator SEES the review and cannot
    // send it. Clearing the review made that false — they were told the round cannot be sent and
    // shown nothing about it.
    scriptSurface({
      probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null,
        apply_eligibility: 'refused_session_price' },
    });
    await openNewRound();
    const alert = await screen.findByTestId('round-not-permitted');
    expect(alert).toHaveAttribute('data-not-permitted-reason', 'session_price');
    expect(screen.getByText(enCycles.newRound.reviewTitle), 'the review is still there').toBeTruthy();
    expect((screen.getByTestId('new-round-send') as HTMLButtonElement).disabled,
      'and the send is not armed').toBe(true);
  });

  it('P2 · THE COHORT REVIEW ALSO STAYS ON SCREEN when the send is withheld', async () => {
    // ROUND 3 (P2): the round-2 fix landed in the other wizard only, and the cohort operator was
    // told the round could not be sent while being shown nothing about it. (Round 4 removed the
    // price prefill that used to put them on this path by default; an operator who TYPES a price
    // still reaches it, which is what this case now covers.)
    scriptSurface({ review: { apply_eligibility: 'refused_session_price' } });
    renderIn(<RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" />);
    const location = await screen.findByText('Court One');
    vi.useFakeTimers();
    fireEvent.click(location);
    const dates = screen.getAllByTestId('date-picker');
    fireEvent.click(dates[0]);
    fireEvent.click(dates[1]);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();
    fireEvent.click(await screen.findByTestId('cohort-to-review'));

    const alert = await screen.findByTestId('cohort-round-not-permitted');
    expect(alert).toHaveAttribute('data-not-permitted-reason', 'session_price');
    expect(screen.queryByTestId('cohort-review-table') ?? screen.queryByText(/Court One/),
      'the reviewed detail is still on screen').toBeTruthy();
  });

  it('P2 · AN AMBIGUOUS APPLY hands the operator the command uuid', async () => {
    scriptSurface({ probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null },
      apply: [{ status: 'applied', round_id: 'not-a-uuid', child_cycle_ids: [CY1] }] });
    await openNewRound();
    await screen.findByText(enCycles.newRound.reviewTitle);
    fireEvent.click(screen.getByTestId('new-round-send'));

    const alert = await screen.findByTestId('round-unknown');
    // Rendered as DATA, never as an action: re-presenting it replays the stored receipt rather
    // than creating a second round, so it is the one thing that can resolve this.
    expect(alert.getAttribute('data-command-id'), 'the recovery handle reaches the screen')
      .toMatch(/^[0-9a-f-]{36}$/);
  });

  it('OD3 · AN EXTEND THE SERVER CANNOT FENCE still says why, rather than "nothing to rebook"', async () => {
    // OD3 changed WHEN this fires. The server now resolves `rebook_rounds.version` for an extend
    // and returns it, so an extend IS attempted — but this fixture returns no version, and a round
    // the server cannot resolve one for is one this browser cannot fence. Sending it anyway
    // produced `invalid_request`, which the wizard rendered as "there is nothing to rebook".
    scriptSurface();
    renderIn(
      <RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" extendRoundId={ROUNDX} />, ['/']);
    const location = await screen.findByText('Court One');
    vi.useFakeTimers();
    fireEvent.click(location);
    const dates = screen.getAllByTestId('date-picker');
    fireEvent.click(dates[0]);
    fireEvent.click(dates[1]);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();

    const counts = (rpcMock.mock.calls as Array<[string, Record<string, unknown>]>)
      .filter(([, a]) => a.p_projection === 'counts');
    expect(counts.length, 'the COUNT still runs — it is what fills the checklist').toBeGreaterThan(0);

    // ROUND 3 (P3): THE REVIEW MUST ACTUALLY BE ATTEMPTED. The previous version stopped at the
    // automatic count, so deleting the early return entirely would have left it green — a test for
    // a fix it never reached.
    rpcMock.mockClear();
    fireEvent.click(await screen.findByTestId('cohort-to-review'));
    await act(async () => { await Promise.resolve(); });
    // THE PROBE RUNS NOW — it is how the version is learned — but no ARMED review is ever sent:
    // nothing carrying minted target identities, which is the call that could produce a send
    // authority for a round this browser cannot fence.
    expect((rpcMock.mock.calls as Array<[string, Record<string, unknown>]>)
      .some(([, a]) => a.p_projection === 'review'
        && Array.isArray(a.p_target_slot_ids) && (a.p_target_slot_ids as unknown[]).length > 0),
    'no ARMED review is ever sent for an extend the server cannot fence').toBe(false);
    const alert = await screen.findByTestId('cohort-round-not-permitted');
    expect(alert).toHaveAttribute('data-not-permitted-reason', 'extend_unavailable');
  });
});

// ── ROUND 5 · THE PRICE PREFILL REALLY IS GONE ──────────────────────────────────────────────

describe('ROUND 5 · a source price recommendation never becomes the round\'s price', () => {
  /**
   * REVIEW ROUND 5 (P3): round 4 removed both prefills but proved neither. Every send case scripts
   * `source_modal_price: null`, so the suite would have stayed green if the prefill had come back —
   * and a prefilled price makes the round permanently unsendable, which is the whole reason it went.
   */
  it('NEW ROUND: a non-null recommendation still leaves p_session_price null', async () => {
    scriptSurface({ probe: { source_modal_price: '25.00' }, review: { source_modal_price: '25.00' } });
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />, [`/?source=${SRC}`]);
    await screen.findByText(enCycles.newRound.source);
    const pickers = screen.getAllByTestId('date-picker');
    fireEvent.click(pickers[0]);
    if (pickers[1]) fireEvent.click(pickers[1]);
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
    await screen.findByText(enCycles.newRound.reviewTitle);

    const priced = (rpcMock.mock.calls as Array<[string, Record<string, unknown>]>)
      .filter(([fn]) => fn === 'rebook_round_selection_preview_as_actor');
    expect(priced.length).toBeGreaterThan(0);
    for (const [, args] of priced) {
      expect(args.p_session_price, 'the recommendation is a suggestion, never the request').toBeNull();
    }
  });

  it('COHORT: a non-null recommendation still leaves p_session_price null', async () => {
    scriptSurface({ probe: { source_modal_price: '25.00' }, review: { source_modal_price: '25.00' } });
    renderIn(<RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" />);
    const location = await screen.findByText('Court One');
    vi.useFakeTimers();
    fireEvent.click(location);
    const dates = screen.getAllByTestId('date-picker');
    fireEvent.click(dates[0]);
    fireEvent.click(dates[1]);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();
    fireEvent.click(await screen.findByTestId('cohort-to-review'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    for (const [, args] of (rpcMock.mock.calls as Array<[string, Record<string, unknown>]>)) {
      expect(args.p_session_price).toBeNull();
    }
  });
});

// ── ROUND 5 · THE SUCCESS PATH, WHICH NO WIZARD TEST HAD EVER REACHED ───────────────────────

describe('ROUND 5 · both wizards actually complete a send', () => {
  /**
   * REVIEW ROUND 5 (P3): every assertion this suite made about drain, toast and navigation was a
   * NEGATIVE one, and the apply fake returned a fixed command uuid while the wizard mints a random
   * one per send — so the driver rejected the identity on every scripted apply and each "nominal"
   * case silently exercised the `unknown` branch. The suite would have stayed green if the wizards
   * had never been able to create a round at all.
   */
  it('NEW ROUND: an applied round is drained, celebrated and navigated to', async () => {
    scriptSurface({ probe: { source_term_weeks: 0, source_modal_price: null },
      review: { source_term_weeks: 0, source_modal_price: null } });
    drainMock.mockResolvedValue({ sent: 4, leftover: 0, outcome: 'drained' });
    renderIn(<AcademyNewRoundWizard academyProfileId={ACADEMY} backHref="/back" />, [`/?source=${SRC}`]);
    await screen.findByText(enCycles.newRound.source);
    const pickers = screen.getAllByTestId('date-picker');
    fireEvent.click(pickers[0]);
    if (pickers[1]) fireEvent.click(pickers[1]);
    fireEvent.click(screen.getByRole('button', { name: enCycles.newRound.toReview }));
    await screen.findByText(enCycles.newRound.reviewTitle);
    fireEvent.click(screen.getByTestId('new-round-send'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(drainMock, 'the invitations are drained for the round that was created').toHaveBeenCalled();
    expect(screen.queryByTestId('round-unknown'), 'and nothing is ambiguous about it').toBeNull();
    expect(invokeMock, 'the retired producer is never reached, not even on the happy path')
      .not.toHaveBeenCalled();
  });

  it('COHORT: an applied round is drained and navigated to', async () => {
    scriptSurface();
    drainMock.mockResolvedValue({ sent: 4, leftover: 0, outcome: 'drained' });
    renderIn(<RebookCohortWizard academyProfileId={ACADEMY} backHref="/back" />);
    const location = await screen.findByText('Court One');
    vi.useFakeTimers();
    fireEvent.click(location);
    const dates = screen.getAllByTestId('date-picker');
    fireEvent.click(dates[0]);
    fireEvent.click(dates[1]);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    vi.useRealTimers();
    fireEvent.click(await screen.findByTestId('cohort-to-review'));
    const send = await screen.findByTestId('cohort-send');
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);

    await waitFor(() => expect(navigateMock).toHaveBeenCalled());
    expect(drainMock).toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
