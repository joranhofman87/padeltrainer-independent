import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { History, User, Cpu, ArrowRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useInvoiceStatusHistory, type InvoiceStatusEvent } from '@/lib/invoiceStatusHistory';

/** WHO changed an invoice's status, WHEN, from→to, and WHY (if recorded). Reads the
 *  trigger-captured audit trail, so it reflects every path (UI, bulk, Mollie webhook). */
export function InvoiceStatusHistoryCard({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation('trainer');
  const { data: events = [], isLoading } = useInvoiceStatusHistory(invoiceId);

  if (isLoading || events.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <History className="h-4 w-4" />
          {t('invoices.history.title', 'Status history')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {events.slice().reverse().map((e, i) => (
            <li key={`${e.changed_at}-${i}`} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 text-muted-foreground">
                {e.changed_by ? <User className="h-3.5 w-3.5" /> : <Cpu className="h-3.5 w-3.5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  {e.old_status && (
                    <>
                      <StatusChip label={e.old_status} muted />
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    </>
                  )}
                  <StatusChip label={e.new_status ?? '—'} />
                  <span className="text-muted-foreground">
                    {t('invoices.history.by', 'by')}{' '}
                    <span className="font-medium text-foreground">
                      {e.changed_by_name || (e.changed_by ? t('invoices.history.unknownUser', 'a user') : t('invoices.history.system', 'System'))}
                    </span>
                  </span>
                </div>
                {e.reason && <p className="text-muted-foreground mt-0.5 italic">“{e.reason}”</p>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap" title={format(new Date(e.changed_at), 'dd MMM yyyy HH:mm')}>
                {format(new Date(e.changed_at), 'dd MMM HH:mm')}
              </span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function StatusChip({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <Badge variant={muted ? 'outline' : 'secondary'} className="font-normal">
      {label}
    </Badge>
  );
}

export type { InvoiceStatusEvent };
