import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { cn } from '@/lib/utils';

interface ListPaginationProps {
  page: number;
  pageCount: number;
  /** Called with the target page; the component clamps to [0, pageCount-1] before invoking. */
  onPageChange: (page: number) => void;
  /** Extra classes for the <Pagination> wrapper (e.g. "mt-4"). */
  className?: string;
}

/**
 * Domain-neutral windowed pager for the server-paginated list pages (invoices, players, …). Renders
 * nothing for a single page. Shows first/last + a ±2 window around the current page with '…' gaps,
 * and clamps every navigation internally so callers can pass a bare `setPage`.
 */
export function ListPagination({ page, pageCount, onPageChange, className }: ListPaginationProps) {
  if (pageCount <= 1) return null;

  const go = (p: number) => onPageChange(Math.min(pageCount - 1, Math.max(0, p)));

  return (
    <Pagination className={cn(className)}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            aria-disabled={page === 0}
            className={page === 0 ? 'pointer-events-none opacity-50' : ''}
            onClick={(e) => {
              e.preventDefault();
              go(page - 1);
            }}
          />
        </PaginationItem>
        {Array.from({ length: pageCount }, (_, i) => i)
          .filter((i) => i === 0 || i === pageCount - 1 || Math.abs(i - page) <= 2)
          .map((i, idx, arr) => (
            <PaginationItem key={i}>
              {idx > 0 && arr[idx - 1] !== i - 1 ? (
                <span className="px-2 text-muted-foreground">…</span>
              ) : null}
              <PaginationLink
                href="#"
                isActive={i === page}
                onClick={(e) => {
                  e.preventDefault();
                  go(i);
                }}
              >
                {i + 1}
              </PaginationLink>
            </PaginationItem>
          ))}
        <PaginationItem>
          <PaginationNext
            href="#"
            aria-disabled={page >= pageCount - 1}
            className={page >= pageCount - 1 ? 'pointer-events-none opacity-50' : ''}
            onClick={(e) => {
              e.preventDefault();
              go(page + 1);
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
