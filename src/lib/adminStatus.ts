import type { BadgeProps } from '@/components/ui/badge';

/**
 * Subscription status → Badge variant. Shared by the admin academies / clubs / trainers lists, which
 * each previously copied this exact switch. The `<Badge>` + label stay at the call site.
 */
export function subscriptionStatusVariant(status: string): BadgeProps['variant'] {
  switch (status) {
    case 'active':
      return 'default';
    case 'trial':
      return 'secondary';
    case 'expired':
      return 'destructive';
    default:
      return 'outline';
  }
}
