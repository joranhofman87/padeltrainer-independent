import { Badge } from '@/components/ui/badge';

export type PaymentStatusKind =
  | 'paid'
  | 'waived'
  | 'refunded'
  | 'no_charge'
  | 'due_after'
  | 'pending'
  | 'unpaid';

type BadgeVariant = 'success' | 'warning' | 'info' | 'outline';

const KIND_VARIANT: Record<PaymentStatusKind, BadgeVariant> = {
  paid: 'success',
  waived: 'outline',
  refunded: 'outline',
  no_charge: 'outline',
  // Informational, not actionable — "payment expected after the lesson". Also keeps
  // it visually distinct from the actionable pending/unpaid warning chips.
  due_after: 'info',
  pending: 'warning',
  unpaid: 'warning',
};

interface PaymentStatusBadgeProps {
  kind: PaymentStatusKind;
  /** Caller-provided label from the caller's OWN i18n namespace — this component owns color, never wording. */
  label: string;
}

/**
 * Presentational payment-status chip shared across roles so the same payment
 * state always renders with the same semantic Badge variant. Callers keep their
 * own decision logic and pass their own translated label.
 *
 * No icon support: the former trainer paid-chip CreditCard icon was dropped
 * deliberately so paid chips look identical everywhere.
 */
export function PaymentStatusBadge({ kind, label }: PaymentStatusBadgeProps) {
  return <Badge variant={KIND_VARIANT[kind]}>{label}</Badge>;
}
