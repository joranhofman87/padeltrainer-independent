import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type EmptyStateVariant = 'default' | 'trainer';

export type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: EmptyStateVariant;
  className?: string;
};

/**
 * Centered empty state for list pages. Presentation-only.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = 'default',
  className,
}: EmptyStateProps) {
  const isTrainer = variant === 'trainer';

  return (
    <div className={cn('flex flex-col items-center justify-center px-4 py-10 text-center', className)}>
      <div
        className={cn(
          'mb-3 flex h-11 w-11 items-center justify-center rounded-full',
          isTrainer ? 'bg-[hsl(var(--navy-50))]' : 'bg-muted',
        )}
      >
        <Icon
          className={cn(
            'h-5 w-5',
            isTrainer ? 'text-[hsl(var(--navy-500))]' : 'text-muted-foreground',
          )}
        />
      </div>
      <p
        className={cn(
          'text-sm font-medium',
          isTrainer ? 'text-[hsl(var(--navy-900))]' : 'text-foreground',
        )}
      >
        {title}
      </p>
      {description && <p className="mt-1 max-w-xs text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
