import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentStatusBadge, type PaymentStatusKind } from './PaymentStatusBadge';

const SUCCESS_CLASS = 'bg-[hsl(var(--success-soft))]';
const WARNING_CLASS = 'bg-[hsl(var(--warning-soft))]';
const INFO_CLASS = 'bg-[hsl(var(--info-soft))]';
const OUTLINE_CLASS = 'text-foreground';

const EXPECTED_CLASS: Record<PaymentStatusKind, string> = {
  paid: SUCCESS_CLASS,
  waived: OUTLINE_CLASS,
  refunded: OUTLINE_CLASS,
  no_charge: OUTLINE_CLASS,
  // Informational (not actionable) — and visually distinct from pending/unpaid.
  due_after: INFO_CLASS,
  pending: WARNING_CLASS,
  unpaid: WARNING_CLASS,
};

describe('PaymentStatusBadge', () => {
  (Object.keys(EXPECTED_CLASS) as PaymentStatusKind[]).forEach((kind) => {
    it(`maps kind "${kind}" to its semantic variant`, () => {
      render(<PaymentStatusBadge kind={kind} label={`label-${kind}`} />);
      const badge = screen.getByText(`label-${kind}`);
      expect(badge.className).toContain(EXPECTED_CLASS[kind]);
    });
  });

  it('outline kinds do not get a filled semantic background', () => {
    render(<PaymentStatusBadge kind="waived" label="Waived" />);
    const badge = screen.getByText('Waived');
    expect(badge.className).not.toContain(SUCCESS_CLASS);
    expect(badge.className).not.toContain(WARNING_CLASS);
  });

  it('renders the caller-provided label verbatim', () => {
    render(<PaymentStatusBadge kind="paid" label="Betaald" />);
    expect(screen.getByText('Betaald')).toBeInTheDocument();
  });
});
