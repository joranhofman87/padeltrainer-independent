import { useTranslation } from 'react-i18next';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { OpsSection } from './OpsSection';
import { useCursorList } from './useCursorList';
import type { WorkerRunRow } from './types';

type Row = WorkerRunRow & { id: string };

/** Worker-run history: did it run, and did it succeed. */
export function WorkerRunsSection() {
  const { t } = useTranslation('admin');
  const list = useCursorList<WorkerRunRow>(
    'admin_list_worker_runs',
    ['started_at', 'run_id'],
    ['p_before_started_at', 'p_before_run_id'],
    () => ({ p_days: 7 }),
  );
  const columns: ColumnDef<Row>[] = [
    { key: 'started', header: t('notifOps.started', 'Started'), className: 'whitespace-nowrap max-w-[220px]',
      cellTitle: (r) => r.started_at, renderCell: (r) => <span className="block truncate">{r.started_at}</span> },
    { key: 'what', header: t('notifOps.workerPhase', 'Channel / phase'), className: 'whitespace-nowrap',
      renderCell: (r) => `${r.channel}/${r.phase}` },
    { key: 'status', header: t('notifOps.status', 'Status'), className: 'whitespace-nowrap',
      renderCell: (r) => r.status ?? t('notifOps.running', 'running') },
    { key: 'ended', header: t('notifOps.ended', 'Ended'), className: 'whitespace-nowrap max-w-[220px]',
      cellTitle: (r) => r.ended_at ?? undefined, renderCell: (r) => <span className="block truncate">{r.ended_at ?? '—'}</span> },
  ];
  return (
    <OpsSection<WorkerRunRow>
      title={t('notifOps.runs', 'Worker runs (7 days)')}
      list={list}
      testId="runs"
      labels={{
        load: t('notifOps.load', 'Load'),
        more: t('notifOps.more', 'Load more'),
        empty: t('notifOps.runsEmpty', 'No worker runs in this window'),
        emptyDescription: t('notifOps.runsEmptyDesc', 'The workers have not run in the last 7 days.'),
        errorText: t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'worker runs' }),
      }}
    >
      {(rows) => (
        <DataTable<Row>
          columns={columns}
          rows={rows.map((r) => ({ ...r, id: r.run_id }))}
          compact
          desktopOnly={false}
          empty={t('notifOps.runsEmpty', 'No worker runs in this window')}
        />
      )}
    </OpsSection>
  );
}
