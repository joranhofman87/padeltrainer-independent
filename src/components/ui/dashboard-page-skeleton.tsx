import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type DashboardPageSkeletonProps = {
  className?: string;
};

/** Loading placeholder for dashboard pages: header, stat tiles, activity cards. */
export function DashboardPageSkeleton({ className }: DashboardPageSkeletonProps) {
  return (
    <div className={cn('space-y-6', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[72px] rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    </div>
  );
}
