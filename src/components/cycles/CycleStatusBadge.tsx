import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Cycle status (draft / open / closed / archived) → semantic `ui/badge` variant. */
function cycleStatusVariant(status: string): BadgeProps['variant'] {
  switch (status) {
    case 'open':
      return 'success';
    case 'closed':
      return 'warning';
    case 'archived':
      return 'muted';
    default:
      return 'secondary'; // draft + unknown
  }
}

/**
 * Shared cycle status badge — one palette for the whole app. The cycle card, the cycles/registrations
 * list, the academy cycle-detail page and the cycle-detail centerpiece each previously rendered the same
 * `cycle.status` enum differently (raw `bg-green-500/10` / `bg-orange-500/10` literals, or no colour at
 * all). This standardises on the semantic `ui/badge` variants. Label comes from the shared `status.*`
 * i18n keys in the `cycles` namespace.
 */
export function CycleStatusBadge({ status, className }: { status: string; className?: string }) {
  const { t } = useTranslation('cycles');
  return (
    <Badge variant={cycleStatusVariant(status)} className={cn('text-xs', className)}>
      {t(`status.${status}`)}
    </Badge>
  );
}
