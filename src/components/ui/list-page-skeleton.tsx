import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export type ListPageSkeletonProps = {
  className?: string;
};

/**
 * Loading placeholder for list/table pages: header, toolbar, and table region.
 */
export function ListPageSkeleton({ className }: ListPageSkeletonProps) {
  return (
    <div className={cn('space-y-4', className)}>
      <Skeleton className="h-10 w-48" />
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-10 w-full max-w-sm" />
        <Skeleton className="h-10 w-[160px]" />
        <Skeleton className="h-10 w-[160px]" />
        <Skeleton className="h-10 w-[170px]" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
