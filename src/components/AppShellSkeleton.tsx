import { Skeleton } from '@/components/ui/skeleton';

/** Full-page shell placeholder while auth / role context is resolving. */
export function AppShellSkeleton() {
  return (
    <div className="min-h-screen bg-background" data-testid="app-shell-skeleton">
      <div className="flex min-h-screen w-full">
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-slate-50 p-4 md:block">
          <div className="mb-6 flex items-center gap-2">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-4 w-28" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-9 w-3/4 rounded-lg" />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 items-center gap-3 border-b border-slate-200 px-4 md:hidden">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-4 w-32" />
          </div>
          <main className="flex-1 p-4 md:p-6">
            <div className="mx-auto max-w-6xl space-y-4">
              <Skeleton className="h-8 w-48" />
              <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                <Skeleton className="h-32 rounded-xl" />
                <Skeleton className="h-32 rounded-xl" />
                <Skeleton className="h-32 rounded-xl" />
              </div>
              <Skeleton className="h-64 rounded-xl" />
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

/** Content-area placeholder; sidebar/header from the layout stay mounted. */
export function PageContentSkeleton() {
  return (
    <div className="space-y-4" data-testid="page-content-skeleton" aria-busy="true" aria-live="polite">
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
