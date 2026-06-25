import type { ReactNode } from 'react';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { ListPageSkeleton } from '@/components/ui/list-page-skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

type AppPageWidth = 'default' | 'narrow' | 'form' | 'wide';

interface ListPageShellProps {
  /** PageHeader title (required). */
  title: ReactNode;
  description?: ReactNode;
  count?: number;
  countLabel?: { one: string; other: string };
  countText?: ReactNode;
  /** Right-aligned header actions (buttons, menus). */
  actions?: ReactNode;
  /**
   * Content rendered immediately under the header, grouped with it (e.g. a hint
   * line) — it stays tight to the title instead of getting the page's larger
   * inter-section gap. It controls its own top margin.
   */
  headerAfter?: ReactNode;
  /** AppPage max-width variant. */
  width?: AppPageWidth;
  /**
   * Full-page loading: render the skeleton INSTEAD of the header + children
   * (the common `<AppPage><ListPageSkeleton/></AppPage>` pattern — the skeleton
   * mocks its own header). For header-stable loading where only the table area
   * loads, leave this off and use `<ListPageState isLoading>` around the body.
   */
  isLoading?: boolean;
  loadingFallback?: ReactNode;
  /** Everything below the header: toolbar, tabs, table, pagination, … */
  children: ReactNode;
  className?: string;
  headerClassName?: string;
}

/**
 * Standard chrome for a list/table page: `AppPage` + `PageHeader` + body.
 * Owns only the page-level boilerplate every list page repeats — the toolbar,
 * table, columns and data-state switching stay in the page (compose them with
 * `ListPageState`). See docs/UI_COMPONENT_STANDARDS.md → "How to build a
 * list/table page".
 */
export function ListPageShell({
  title,
  description,
  count,
  countLabel,
  countText,
  actions,
  headerAfter,
  width,
  isLoading = false,
  loadingFallback,
  children,
  className,
  headerClassName,
}: ListPageShellProps) {
  return (
    <AppPage width={width} className={className}>
      {isLoading ? (
        loadingFallback ?? <ListPageSkeleton />
      ) : (
        <>
          <div>
            <PageHeader
              title={title}
              description={description}
              count={count}
              countLabel={countLabel}
              countText={countText}
              actions={actions}
              className={headerClassName}
            />
            {headerAfter}
          </div>
          {children}
        </>
      )}
    </AppPage>
  );
}

interface ListPageStateProps {
  /** Show the loading fallback (default `ListPageSkeleton`). */
  isLoading?: boolean;
  loadingFallback?: ReactNode;
  /** When truthy, render a standardized error alert instead of content. */
  error?: ReactNode;
  /** Show the empty node instead of content. */
  isEmpty?: boolean;
  /** The empty node — pass an `<EmptyState/>` (or any node) the page owns. */
  empty?: ReactNode;
  /** Ready content (the table + pagination). */
  children: ReactNode;
  className?: string;
}

/**
 * Standardizes the data-state switch for a list body: loading → error → empty →
 * content (in that precedence). Keeps the inconsistent per-page loading/empty/
 * error handling uniform. The `empty` node is page-owned so a migration is
 * pixel-identical; pass the page's existing `<EmptyState/>`.
 *
 * Usable anywhere — including inside a `<TabsContent>` for tabbed list pages.
 */
export function ListPageState({
  isLoading = false,
  loadingFallback,
  error,
  isEmpty = false,
  empty,
  children,
  className,
}: ListPageStateProps) {
  if (isLoading) return <>{loadingFallback ?? <ListPageSkeleton className={className} />}</>;
  if (error) {
    return (
      <Alert variant="destructive" className={cn('my-2', className)}>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (isEmpty) return <>{empty}</>;
  return <>{children}</>;
}
