import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui/badge';

function waitingListStatusVariant(status: string): BadgeProps['variant'] {
  switch (status) {
    case 'active':
      return 'default';
    case 'contacted':
      return 'secondary';
    case 'archived':
      return 'outline';
    default:
      return undefined;
  }
}

/**
 * Waiting-list entry status badge — shared by the management table (`WaitingListTable`) and the player's
 * "my entries" view (`MyWaitingListEntries`), which had identical variant logic. The i18n label prefix
 * differs per surface (`management.filters` vs `myEntries`), so it's passed in. Renders nothing for an
 * unknown status (preserving the old `default: return null`).
 */
export function WaitingListStatusBadge({ status, labelPrefix }: { status: string; labelPrefix: string }) {
  const { t } = useTranslation('waitingList');
  const variant = waitingListStatusVariant(status);
  if (!variant) return null;
  return <Badge variant={variant}>{t(`${labelPrefix}.${status}`)}</Badge>;
}
