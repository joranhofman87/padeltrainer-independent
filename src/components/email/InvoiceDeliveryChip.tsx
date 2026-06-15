import { MailWarning } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';

interface Props {
  deliveryStatus: string | null | undefined;
  hasEmail: boolean;
}

/**
 * Per-invoice delivery FLAG. Renders a warning icon ONLY when the invoice can't
 * have reached the player — no email on file, a bounce (incl. spam complaint,
 * which get_invoice_delivery_status folds into 'bounced'), or a send failure.
 * Hovering gives the reason. Healthy rows (delivered / accepted / unknown) render
 * nothing, so a column of mostly-blank cells reads as a scannable "needs action"
 * flag. Shared by the academy + trainer invoice pages.
 */
export function InvoiceDeliveryChip({ deliveryStatus, hasEmail }: Props) {
  const { t } = useTranslation('academy');

  let reason: string | null = null;
  let tone = 'text-destructive';
  if (!hasEmail) {
    reason = t('emailDelivery.reason.noEmail', 'No email address on file');
    tone = 'text-amber-600';
  } else if (deliveryStatus === 'bounced') {
    reason = t('emailDelivery.reason.bounced', "Email bounced — couldn't be delivered");
  } else if (deliveryStatus === 'failed') {
    reason = t('emailDelivery.reason.failed', 'Sending failed');
  }
  if (!reason) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-flex ${tone}`} aria-label={t('emailDelivery.flagLabel', 'Delivery issue')}>
          <MailWarning className="h-4 w-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
