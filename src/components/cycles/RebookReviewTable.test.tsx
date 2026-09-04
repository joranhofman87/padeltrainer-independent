import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RebookReviewTable, type RebookGroupDetail } from './RebookReviewTable';

// Interpolating t so the assertions can check rendered numbers/text.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, d?: string, opts?: Record<string, unknown>) => {
      let s = d ?? _k;
      if (opts) for (const [k, v] of Object.entries(opts)) s = s.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
      return s;
    },
  }),
}));

const groups: RebookGroupDetail[] = [
  { sourceSeriesKey: 'k1', trainerId: 't1', trainerName: 'Alice', weekday: 'maandag', time: '18:00', players: 4, sessions: 10, roster: [{ name: 'A', hasEmail: true }] },
  { sourceSeriesKey: 'k2', trainerId: 't2', trainerName: 'Bob', weekday: 'woensdag', time: '20:00', players: 3, sessions: 10, roster: [{ name: 'B', hasEmail: true }] },
];

const base = { ackNoEmail: false, onAckChange: vi.fn() };

describe('RebookReviewTable (interactive)', () => {
  it('renders trainer names and one keep toggle per series', () => {
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} onToggleExcluded={vi.fn()} />);
    expect(screen.getByText(/Alice/)).toBeTruthy();
    expect(screen.getByText(/Bob/)).toBeTruthy();
    expect(screen.getAllByLabelText('Mee')).toHaveLength(2);
  });

  it('toggling keep calls onToggleExcluded with the series key', () => {
    const onToggle = vi.fn();
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} onToggleExcluded={onToggle} />);
    fireEvent.click(screen.getAllByLabelText('Mee')[0]);
    expect(onToggle).toHaveBeenCalledWith('k1');
  });

  it('uses the server summary for the headline, not a client re-sum', () => {
    // Client sum of players would be 7 (4+3); the distinct server count is 5.
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} onToggleExcluded={vi.fn()} summary={{ groups: 2, players: 5, participantSessions: 20 }} />);
    expect(screen.getByText(/5 spelers/)).toBeTruthy();
    expect(screen.queryByText(/7 spelers/)).toBeNull();
  });

  it('read-only mode (no callbacks) renders no keep toggles', () => {
    render(<RebookReviewTable {...base} groups={groups} />);
    expect(screen.queryAllByLabelText('Mee')).toHaveLength(0);
  });
});

// ── ABC-26 ────────────────────────────────────────────────────────────────────
//
// These replace the previous positive test, which asserted that excluding a series revealed a
// "these players may book other freed seats" toggle. That control offered supplementary priority,
// which is unavailable for every class, so the assertion is not merely obsolete — it asserted
// exactly the promise containment withdraws. What is asserted now is its absence, plus the
// standing explanation that took its place.
describe('RebookReviewTable — supplementary priority is unavailable (ABC-26)', () => {
  it('an excluded series offers NO second-bucket toggle', () => {
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set(['k2'])} onToggleExcluded={vi.fn()} />);
    // The old affirmative copy, in either language, and any second checkbox on the excluded row.
    expect(screen.queryByText(/andere vrijgekomen plekken/)).toBeNull();
    expect(screen.queryByText(/other freed seats/i)).toBeNull();
    // Exactly one checkbox per series (the keep toggle) — no per-removal extra.
    expect(screen.getAllByLabelText('Mee')).toHaveLength(2);
  });

  it('excluding a series still works — exclusion-only survives', () => {
    const onToggle = vi.fn();
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set(['k2'])} onToggleExcluded={onToggle} />);
    const toggles = screen.getAllByLabelText('Mee') as HTMLInputElement[];
    // k2 is excluded ⇒ its keep box is unchecked; clicking it re-includes.
    fireEvent.click(toggles[1]);
    expect(onToggle).toHaveBeenCalledWith('k2');
  });

  it('shows the unavailable explanation PERSISTENTLY in interactive mode — with nothing excluded', () => {
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} onToggleExcluded={vi.fn()} />);
    expect(screen.getByTestId('review-table-priority-unavailable')).toBeTruthy();
  });

  it('the explanation does not appear or disappear with the exclusion set', () => {
    const { rerender } = render(
      <RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} onToggleExcluded={vi.fn()} />,
    );
    expect(screen.getByTestId('review-table-priority-unavailable')).toBeTruthy();
    rerender(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set(['k1', 'k2'])} onToggleExcluded={vi.fn()} />);
    expect(screen.getByTestId('review-table-priority-unavailable')).toBeTruthy();
    rerender(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} onToggleExcluded={vi.fn()} />);
    expect(screen.getByTestId('review-table-priority-unavailable')).toBeTruthy();
  });

  it('read-only mode renders no explanation (nothing can be excluded there)', () => {
    render(<RebookReviewTable {...base} groups={groups} />);
    expect(screen.queryByTestId('review-table-priority-unavailable')).toBeNull();
  });
});

describe('RebookReviewTable (per-group price breakdown by payment mode)', () => {
  const priced: RebookGroupDetail[] = [
    { sourceSeriesKey: 'k1', weekday: 'maandag', time: '18:00', players: 4, sessions: 8, pricePerSession: 20, splitPayment: false, invoiceTotal: 160, roster: [{ name: 'A', hasEmail: true }] },
  ];

  it('upfront: breakdown reads "(hele groep)" — the court paid once, never × headcount', () => {
    render(<RebookReviewTable {...base} groups={priced} paymentMode="upfront" grandInvoiceTotal={160} />);
    expect(screen.getByText(/hele groep/)).toBeTruthy();
    // The per-seat "× 4" multiplier must NOT appear for a single-payer upfront round.
    expect(screen.queryByText(/× 4/)).toBeNull();
  });

  it('deferred (split or not): shares the court "(gedeeld)" — never a per-seat × N', () => {
    // The deferred cron splits the cycle total by group headcount regardless of split_payment, so
    // the group pays P×S once (each committer (P×S)/N). No × headcount multiplier is ever shown.
    render(<RebookReviewTable {...base} groups={priced} paymentMode="deferred_split" grandInvoiceTotal={160} />);
    expect(screen.getByText(/gedeeld/)).toBeTruthy();
    expect(screen.queryByText(/× 4/)).toBeNull();
    expect(screen.queryByText(/hele groep/)).toBeNull();
  });
});
