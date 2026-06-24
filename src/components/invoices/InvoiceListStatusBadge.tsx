import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { InvoiceStatusBadge } from './InvoiceStatusBadge';
import { InvoiceStatusBadgeTooltip } from './InvoiceStatusBadgeTooltip';
import type { InvoiceStatus } from '@/lib/invoiceStatus';

interface InvoiceListStatusBadgeProps {
  invoiceId: string;
  /** The server-computed status from the get_*_invoices RPC (`computed_status`). */
  status: string;
}

/**
 * Status badge for a trainer/academy invoice LIST row. Renders the server `computed_status` via the
 * shared `InvoiceStatusBadge` (plus the academy-only `open` state, which is not a canonical
 * InvoiceStatus), wrapped in the lazily-fetched audit-trail tooltip. This is the single source the
 * two list pages share — the trainer page previously hand-rolled the badge from raw
 * status/sent_at/due_date and ignored `computed_status`.
 */
export function InvoiceListStatusBadge({ invoiceId, status }: InvoiceListStatusBadgeProps) {
  const { t } = useTranslation('common');
  const badge =
    status === 'open' ? (
      <Badge variant="secondary">{t('invoiceStatus.open', 'Open')}</Badge>
    ) : (
      <InvoiceStatusBadge status={status as InvoiceStatus} />
    );
  return <InvoiceStatusBadgeTooltip invoiceId={invoiceId}>{badge}</InvoiceStatusBadgeTooltip>;
}
