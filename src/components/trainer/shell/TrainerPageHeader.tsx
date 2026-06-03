import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TrainerMoreMenu, type TrainerMoreMenuItem } from '@/components/trainer/shell/TrainerMoreMenu';
import { cn } from '@/lib/utils';

export interface TrainerPageHeaderPrimaryAction {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
  disabled?: boolean;
  loading?: boolean;
}

export interface TrainerPageHeaderProps {
  title: string;
  description?: string;
  countText?: string;
  primaryAction?: TrainerPageHeaderPrimaryAction;
  moreMenuItems?: TrainerMoreMenuItem[];
  /** Extra controls shown beside the primary button (e.g. billing toggle wrapper). */
  trailing?: ReactNode;
  className?: string;
}

export function TrainerPageHeader({
  title,
  description,
  countText,
  primaryAction,
  moreMenuItems,
  trailing,
  className,
}: TrainerPageHeaderProps) {
  const PrimaryIcon = primaryAction?.icon;
  const showActions = primaryAction || (moreMenuItems && moreMenuItems.length > 0) || trailing;

  return (
    <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-[hsl(var(--navy-900))] sm:text-3xl">
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        {countText && (
          <p className="mt-1 text-xs font-medium text-[hsl(var(--navy-600))]">{countText}</p>
        )}
      </div>

      {showActions && (
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
          {trailing}
          {primaryAction && (
            <Button
              className="w-full shrink-0 bg-[hsl(var(--brand-500))] hover:bg-[hsl(var(--brand-600))] sm:w-auto"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled || primaryAction.loading}
            >
              {primaryAction.loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : PrimaryIcon ? (
                <PrimaryIcon className="mr-2 h-4 w-4" />
              ) : null}
              {primaryAction.label}
            </Button>
          )}
          {moreMenuItems && moreMenuItems.length > 0 && (
            <TrainerMoreMenu items={moreMenuItems} className="w-full sm:w-auto" />
          )}
        </div>
      )}
    </header>
  );
}
