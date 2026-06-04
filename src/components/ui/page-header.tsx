import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  count?: number;
  countLabel?: { one: string; other: string };
  countText?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/**
 * Standard page header used across list/table screens.
 * Title + optional count on the left, action buttons on the right.
 */
export function PageHeader({
  title,
  description,
  count,
  countLabel,
  countText,
  actions,
  className,
}: PageHeaderProps) {
  const subtitle =
    countText ??
    (typeof count === 'number' && countLabel
      ? `${count} ${count === 1 ? countLabel.one : countLabel.other}`
      : null);

  return (
    <div
      className={cn(
        'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground truncate">
          {title}
        </h1>
        {(subtitle || description) && (
          <p className="mt-1 text-sm text-muted-foreground">
            {subtitle ?? description}
          </p>
        )}
      </div>
      {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}
