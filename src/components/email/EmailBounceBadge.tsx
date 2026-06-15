import { Badge } from '@/components/ui/badge';
import { MailWarning } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * "Email bouncing" indicator — shown wherever a player's resolved email is
 * undeliverable (hard bounce / complaint). Mirrors the has_overdue_payment
 * destructive Badge. `compact` matches the dense player-list row styling.
 */
export function EmailBounceBadge({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { t } = useTranslation('common');
  return (
    <Badge
      variant="destructive"
      className={cn('shrink-0 gap-1', compact ? 'h-5 px-1.5 text-[11px]' : '', className)}
      title={t('emailBounce.tooltip', "We can't deliver emails to this address — reminders aren't reaching them.")}
    >
      <MailWarning className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
      {t('emailBounce.badge', 'Email bouncing')}
    </Badge>
  );
}
