import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { FileText, Clock, CheckCircle2, AlertCircle, Ban } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { InvoiceStatus } from '@/lib/invoiceStatus';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

interface StatusDescriptor {
  labelKey: string;
  defaultLabel: string;
  variant: BadgeVariant;
  icon: LucideIcon;
}

const STATUS_DESCRIPTORS: Record<InvoiceStatus, StatusDescriptor> = {
  draft: { labelKey: 'invoiceStatus.draft', defaultLabel: 'Draft', variant: 'secondary', icon: FileText },
  sent: { labelKey: 'invoiceStatus.sent', defaultLabel: 'Sent', variant: 'default', icon: Clock },
  paid: { labelKey: 'invoiceStatus.paid', defaultLabel: 'Paid', variant: 'outline', icon: CheckCircle2 },
  overdue: { labelKey: 'invoiceStatus.overdue', defaultLabel: 'Overdue', variant: 'destructive', icon: AlertCircle },
  cancelled: { labelKey: 'invoiceStatus.cancelled', defaultLabel: 'Cancelled', variant: 'secondary', icon: Ban },
};

export interface InvoiceStatusBadgeProps {
  status: InvoiceStatus;
  className?: string;
}

/**
 * Presentational badge for an invoice status. Pair with deriveInvoiceStatus()
 * to render the canonical status across trainer, academy and player views.
 */
export function InvoiceStatusBadge({ status, className }: InvoiceStatusBadgeProps) {
  const { t } = useTranslation('common');
  const descriptor = STATUS_DESCRIPTORS[status] ?? STATUS_DESCRIPTORS.draft;
  const Icon = descriptor.icon;

  return (
    <Badge variant={descriptor.variant} className={cn('gap-1', className)}>
      <Icon className="h-3 w-3" />
      {t(descriptor.labelKey, descriptor.defaultLabel)}
    </Badge>
  );
}
