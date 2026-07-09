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
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} secondBucketKeys={new Set()} onToggleExcluded={vi.fn()} onToggleSecondBucket={vi.fn()} />);
    expect(screen.getByText(/Alice/)).toBeTruthy();
    expect(screen.getByText(/Bob/)).toBeTruthy();
    expect(screen.getAllByLabelText('Mee')).toHaveLength(2);
  });

  it('toggling keep calls onToggleExcluded with the series key', () => {
    const onToggle = vi.fn();
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} secondBucketKeys={new Set()} onToggleExcluded={onToggle} onToggleSecondBucket={vi.fn()} />);
    fireEvent.click(screen.getAllByLabelText('Mee')[0]);
    expect(onToggle).toHaveBeenCalledWith('k1');
  });

  it('an excluded series shows the "move to second bucket" toggle', () => {
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set(['k2'])} secondBucketKeys={new Set(['k2'])} onToggleExcluded={vi.fn()} onToggleSecondBucket={vi.fn()} />);
    expect(screen.getByText(/andere vrijgekomen plekken/)).toBeTruthy();
  });

  it('uses the server summary for the headline, not a client re-sum', () => {
    // Client sum of players would be 7 (4+3); the distinct server count is 5.
    render(<RebookReviewTable {...base} groups={groups} interactive excludedKeys={new Set()} secondBucketKeys={new Set()} onToggleExcluded={vi.fn()} onToggleSecondBucket={vi.fn()} summary={{ groups: 2, players: 5, sessions: 20 }} />);
    expect(screen.getByText(/5 spelers/)).toBeTruthy();
    expect(screen.queryByText(/7 spelers/)).toBeNull();
  });

  it('read-only mode (no callbacks) renders no keep toggles', () => {
    render(<RebookReviewTable {...base} groups={groups} />);
    expect(screen.queryAllByLabelText('Mee')).toHaveLength(0);
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

  it('deferred without split: keeps the per-seat "× N" breakdown', () => {
    render(<RebookReviewTable {...base} groups={priced} paymentMode="deferred_split" grandInvoiceTotal={640} />);
    expect(screen.getByText(/× 4/)).toBeTruthy();
    expect(screen.queryByText(/hele groep/)).toBeNull();
  });
});
