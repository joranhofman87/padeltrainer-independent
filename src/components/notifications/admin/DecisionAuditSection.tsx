import { useTranslation } from 'react-i18next';
import { DataTable, type ColumnDef } from '@/components/ui/data-table-generic';
import { OpsSection } from './OpsSection';
import { useCursorList } from './useCursorList';
import type { AuditRow, RejectedRow } from './types';

/** The immutable decision audit and the rejected-attempt record — two feeds, same contract. */
export function DecisionAuditSection() {
  const { t } = useTranslation('admin');
  const audit = useCursorList<AuditRow>('admin_list_notification_audit', ['created_at', 'id'], ['p_before_created_at', 'p_before_id']);
  const rejected = useCursorList<RejectedRow>('admin_list_notification_rejected', ['created_at', 'id'], ['p_before_created_at', 'p_before_id']);

  const auditColumns: ColumnDef<AuditRow>[] = [
    { key: 'at', header: t('notifOps.when', 'When'), className: 'whitespace-nowrap max-w-[220px]',
      cellTitle: (r) => r.created_at, renderCell: (r) => <span className="block truncate">{r.created_at}</span> },
    { key: 'what', header: t('notifOps.decision', 'Decision'), className: 'max-w-[240px] whitespace-nowrap',
      cellTitle: (r) => `${r.action} · ${r.target}`,
      renderCell: (r) => <span className="block truncate">{r.action} · {r.target}</span> },
    { key: 'change', header: t('notifOps.change', 'Change'), className: 'whitespace-nowrap',
      renderCell: (r) => `${r.old_value}→${r.new_value} · ${r.outcome}` },
    { key: 'reason', header: t('notifOps.reasonCol', 'Reason'), className: 'max-w-[320px]',
      cellTitle: (r) => r.reason, renderCell: (r) => <span className="block truncate">{r.reason}</span> },
  ];
  const rejectedColumns: ColumnDef<RejectedRow>[] = [
    { key: 'at', header: t('notifOps.when', 'When'), className: 'whitespace-nowrap max-w-[220px]',
      cellTitle: (r) => r.created_at, renderCell: (r) => <span className="block truncate">{r.created_at}</span> },
    { key: 'what', header: t('notifOps.attempt', 'Attempt'), className: 'max-w-[240px] whitespace-nowrap',
      cellTitle: (r) => `${r.action} · ${r.target}`,
      renderCell: (r) => <span className="block truncate">{r.action} · {r.target}</span> },
    { key: 'conflict', header: t('notifOps.conflict', 'Conflict'), className: 'max-w-[380px]',
      cellTitle: (r) => r.conflict_with, renderCell: (r) => <span className="block truncate">{r.conflict_with}</span> },
  ];

  return (
    <>
      <OpsSection<AuditRow>
        title={t('notifOps.audit', 'Decision audit')}
        list={audit}
        testId="audit"
        labels={{
          load: t('notifOps.load', 'Load'),
          more: t('notifOps.more', 'Load more'),
          empty: t('notifOps.auditEmpty', 'No admin decisions recorded'),
          emptyDescription: t('notifOps.auditEmptyDesc', 'Every kill, reset, cancel and orphan decision lands here immutably.'),
          errorText: t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'audit' }),
        }}
      >
        {(rows) => (
          <DataTable<AuditRow> columns={auditColumns} rows={rows} compact desktopOnly={false}
            empty={t('notifOps.auditEmpty', 'No admin decisions recorded')} />
        )}
      </OpsSection>
      <OpsSection<RejectedRow>
        title={t('notifOps.rejected', 'Rejected attempts')}
        list={rejected}
        testId="rejected"
        labels={{
          load: t('notifOps.load', 'Load'),
          more: t('notifOps.more', 'Load more'),
          empty: t('notifOps.rejectedEmpty', 'No rejected attempts'),
          emptyDescription: t('notifOps.rejectedEmptyDesc', 'A reused request id or a refused recovery would appear here.'),
          errorText: t('notifOps.loadFailed', { defaultValue: 'Could not load {{label}} — the real state is unknown.', label: 'rejected attempts' }),
        }}
      >
        {(rows) => (
          <DataTable<RejectedRow> columns={rejectedColumns} rows={rows} compact desktopOnly={false}
            empty={t('notifOps.rejectedEmpty', 'No rejected attempts')} />
        )}
      </OpsSection>
    </>
  );
}
