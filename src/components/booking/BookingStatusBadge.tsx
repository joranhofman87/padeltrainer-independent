import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info' | 'muted';

interface BookingStatusConfig {
  variant: BadgeVariant;
  /** i18n key under the `player` namespace. */
  labelKey: string;
  fallback: string;
}

const STATUS_CONFIG: Record<string, BookingStatusConfig> = {
  pending: { variant: 'warning', labelKey: 'bookings.status.pendingPayment', fallback: 'Pending Payment' },
  pending_approval: { variant: 'info', labelKey: 'bookings.status.awaitingApproval', fallback: 'Awaiting Approval' },
  confirmed: { variant: 'success', labelKey: 'bookings.status.confirmed', fallback: 'Confirmed' },
  cancelled: { variant: 'destructive', labelKey: 'bookings.status.cancelled', fallback: 'Cancelled' },
  completed: { variant: 'outline', labelKey: 'bookings.status.completed', fallback: 'Completed' },
};

interface BookingStatusBadgeProps {
  status: string;
}

/**
 * Presentational booking-status badge shared by the player dashboard and bookings
 * page so the same status always renders identically. Maps each booking status to
 * a semantic Badge variant + i18n label.
 *
 * Labels live in the `player` i18n namespace; the wording is role-generic and
 * renders identically for every role that uses this badge.
 */
export function BookingStatusBadge({ status }: BookingStatusBadgeProps) {
  const { t } = useTranslation('player');
  const config = STATUS_CONFIG[status];
  if (!config) {
    return <Badge>{status}</Badge>;
  }
  return <Badge variant={config.variant}>{t(config.labelKey, config.fallback)}</Badge>;
}
