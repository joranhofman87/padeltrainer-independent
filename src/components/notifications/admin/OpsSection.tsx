import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageState } from '@/components/ui/list-page-shell';
import { Inbox } from 'lucide-react';
import type { CursorList } from './useCursorList';

/**
 * One cursor-paginated operational section: heading + toolbar slot + the canonical
 * loading/error/empty/content switch (`ListPageState`) + a "load more" affordance.
 *
 * The N4 sections load ON DEMAND (an admin page must not fire six cross-tenant reads on mount),
 * so "not yet loaded" is its own state with a Load button — distinct from "loaded and empty",
 * which renders the standard `EmptyState`.
 */
export function OpsSection<T extends Record<string, unknown>>({
  title,
  description,
  list,
  toolbar,
  labels,
  testId,
  children,
}: {
  title: string;
  description?: ReactNode;
  list: CursorList<T>;
  toolbar?: ReactNode;
  labels: { load: string; more: string; empty: string; emptyDescription: string; errorText: string };
  testId: string;
  children: (rows: T[]) => ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={`section-${testId}`}>
      <h2 className="font-medium">{title}</h2>
      {description}
      {toolbar}
      {list.rows === null && !list.error ? (
        <Button size="sm" variant="outline" onClick={() => void list.load(false)} disabled={list.busy} data-testid={`${testId}-load`}>
          {labels.load}
        </Button>
      ) : (
        <ListPageState
          error={list.error ? labels.errorText : undefined}
          isEmpty={(list.rows?.length ?? 0) === 0}
          empty={
            <div data-testid={`${testId}-empty`}>
              <EmptyState icon={Inbox} title={labels.empty} description={labels.emptyDescription} />
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void list.load(false)} disabled={list.busy} data-testid={`${testId}-reload`}>
                {labels.load}
              </Button>
            </div>
          }
        >
          <div data-testid={`${testId}-list`}>
            {children(list.rows ?? [])}
            {!list.exhausted && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void list.load(true)} disabled={list.busy} data-testid={`${testId}-more`}>
                {labels.more}
              </Button>
            )}
          </div>
        </ListPageState>
      )}
      {list.error && (
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void list.load(false)} data-testid={`${testId}-retry`}>
          {labels.load}
        </Button>
      )}
    </section>
  );
}
