import { Badge } from '@/components/ui/badge';
import { MailCheck, MailWarning, MailX, Send, Minus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  deliveryStatus: string | null | undefined;
  hasEmail: boolean;
  sentAt: string | null | undefined;
}

/**
 * Clear per-invoice delivery state for the invoice list — distinguishes
 * No email / Not delivered / Delivered / Sent (accepted, awaiting) / Not sent,
 * so "marked sent" no longer hides a bounce.
 */
export function InvoiceDeliveryChip({ deliveryStatus, hasEmail, sentAt }: Props) {
  const { t } = useTranslation('academy');

  if (!hasEmail) {
    return (
      <Badge variant="outline" className="gap-1 text-amber-600 border-amber-300">
        <MailX className="h-3 w-3" />
        {t('emailDelivery.chip.noEmail', 'No email')}
      </Badge>
    );
  }
  if (deliveryStatus === 'bounced' || deliveryStatus === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1">
        <MailWarning className="h-3 w-3" />
        {t('emailDelivery.chip.bounced', 'Not delivered')}
      </Badge>
    );
  }
  if (deliveryStatus === 'delivered') {
    return (
      <Badge variant="outline" className="gap-1 text-emerald-600 border-emerald-300">
        <MailCheck className="h-3 w-3" />
        {t('emailDelivery.chip.delivered', 'Delivered')}
      </Badge>
    );
  }
  if (deliveryStatus === 'sent' || sentAt) {
    return (
      <Badge variant="secondary" className="gap-1">
        <Send className="h-3 w-3" />
        {t('emailDelivery.chip.sent', 'Sent')}
      </Badge>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Minus className="h-3 w-3" />
      {t('emailDelivery.chip.notSent', 'Not sent')}
    </span>
  );
}
