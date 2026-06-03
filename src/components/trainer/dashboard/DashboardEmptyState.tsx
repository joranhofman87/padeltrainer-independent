import type { LucideIcon } from 'lucide-react';

interface DashboardEmptyStateProps {
  icon: LucideIcon;
  message: string;
  hint?: string;
}

export function DashboardEmptyState({ icon: Icon, message, hint }: DashboardEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[hsl(var(--navy-50))]">
        <Icon className="h-5 w-5 text-[hsl(var(--navy-500))]" />
      </div>
      <p className="text-sm font-medium text-[hsl(var(--navy-900))]">{message}</p>
      {hint && <p className="mt-1 max-w-xs text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
