import { useTranslation } from 'react-i18next';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ListPageState } from '@/components/ui/list-page-shell';
import { PlayCircle } from 'lucide-react';
import type { InvocationRow } from './types';

/** Deliberate worker invocations (Stage-3.5 AC-6 health): stale = age, actionable = a verb exists. */
export function InvocationsSection({
  rows, isLoading, isError, onRetry,
}: { rows?: InvocationRow[]; isLoading: boolean; isError: boolean; onRetry: () => void }) {
  const { t } = useTranslation('admin');
  const columns: ColumnDef<InvocationRow>[] = [
    {
      key: 'purpose', header: t('notifOps.purpose', 'Purpose'), className: 'max-w-[240px]',
      cellTitle: (r) => `${r.purpose} · ${r.source}`,
      renderCell: (r) => <span className="block truncate">{r.purpose} · {r.source}</span>,
    },
    { key: 'status', header: t('notifOps.status', 'Status'), className: 'whitespace-nowrap', renderCell: (r) => r.status },
    { key: 'age', header: t('notifOps.age', 'Age (s)'), className: 'whitespace-nowrap', renderCell: (r) => String(r.age_seconds) },
    { key: 'stale', header: t('notifOps.stale', 'Stale'), className: 'whitespace-nowrap', renderCell: (r) => (r.stale ? '⚠︎' : '—') },
    { key: 'actionable', header: t('notifOps.actionable', 'Actionable'), className: 'whitespace-nowrap', renderCell: (r) => (r.actionable ? t('notifOps.yes', 'yes') : '—') },
  ];
  return (
    <section aria-label="invocations" data-testid="section-invocations">
      <h2 className="font-medium">{t('notifOps.invocations', 'Deliberate invocations')}</h2>
      <ListPageState
        isLoading={isLoading}
        error={isError ? (
          <span>
            {t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'invocations' })}
            <Button size="sm" variant="outline" className="ml-2" onClick={onRetry} data-testid="invocations-retry">
              {t('notifOps.retry', 'Retry')}
            </Button>
          </span>
        ) : undefined}
        isEmpty={(rows?.length ?? 0) === 0 && !isLoading && !isError}
        empty={<EmptyState icon={PlayCircle} title={t('notifOps.noInvocations', 'No deliberate invocations recorded')} description={t('notifOps.noInvocationsDesc', 'Smoke, canary and manual invocations appear here with their evidence.')} />}
      >
        {rows ? (
          <div data-testid="invocations">
            <DataTable<InvocationRow>
              columns={columns}
              rows={rows}
              compact
              desktopOnly={false}
              empty={t('notifOps.noInvocations', 'No deliberate invocations recorded')}
            />
          </div>
        ) : null}
      </ListPageState>
    </section>
  );
}
