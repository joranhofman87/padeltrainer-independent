import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TrainerIconWellProps {
  icon: LucideIcon;
  className?: string;
}

export function TrainerIconWell({ icon: Icon, className }: TrainerIconWellProps) {
  return (
    <div
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[hsl(var(--navy-50))]',
        className,
      )}
    >
      <Icon className="h-4 w-4 text-[hsl(var(--navy-600))]" />
    </div>
  );
}
