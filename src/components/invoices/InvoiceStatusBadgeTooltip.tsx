import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useInvoiceStatusHistory } from '@/lib/invoiceStatusHistory';

/** Wraps an invoice status badge with a hover tooltip showing the LAST status change
 *  (who / when / why). The audit trail is fetched lazily — only once the user hovers —
 *  so a list of N badges stays a single invoice query, not N+1. */
export function InvoiceStatusBadgeTooltip({ invoiceId, children }: { invoiceId: string; children: ReactNode }) {
  const { t } = useTranslation('trainer');
  const [armed, setArmed] = useState(false);
  const { data: events = [], isFetching } = useInvoiceStatusHistory(invoiceId, armed);
  const last = events.length ? events[events.length - 1] : null;

  return (
    <Tooltip onOpenChange={(open) => { if (open) setArmed(true); }}>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[16rem]">
        {!last ? (
          <span className="text-muted-foreground">
            {armed && isFetching
              ? t('invoices.history.loading', 'Loading…')
              : t('invoices.history.none', 'No status changes recorded')}
          </span>
        ) : (
          <div className="space-y-0.5">
            <div>
              <span className="font-medium">{last.new_status}</span>{' '}
              <span className="text-muted-foreground">
                {t('invoices.history.by', 'by')}{' '}
                {last.changed_by_name ||
                  (last.changed_by
                    ? t('invoices.history.unknownUser', 'a user')
                    : t('invoices.history.system', 'System'))}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {format(new Date(last.changed_at), 'dd MMM yyyy HH:mm')}
            </div>
            {last.reason && <div className="text-xs italic">“{last.reason}”</div>}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
