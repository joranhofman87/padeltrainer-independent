import {
  buildInvoiceEmailEvents,
  mapCampaignEmailEvents,
  mergePlayerEmailHistory,
  type AcademyPlayerEmailHistoryItem,
  type InvoiceEmailSourceRow,
} from '@/lib/academyPlayerEmailHistory';
import { buildTrainerInvoiceEditPath } from '@/lib/trainerPlayerDetailNavigation';

export type TrainerPlayerEmailHistoryItem = AcademyPlayerEmailHistoryItem;

export function filterInvoicesForTrainer(
  invoices: InvoiceEmailSourceRow[],
  trainerProfileId: string,
): InvoiceEmailSourceRow[] {
  return invoices.filter(
    (inv) => !inv.trainer_id || inv.trainer_id === trainerProfileId,
  );
}

export function buildTrainerInvoiceEmailEvents(
  invoices: InvoiceEmailSourceRow[],
  labels: { sent: string; sentWithNumber: (number: string) => string },
): TrainerPlayerEmailHistoryItem[] {
  return buildInvoiceEmailEvents(invoices, labels, buildTrainerInvoiceEditPath);
}

export {
  mapCampaignEmailEvents,
  mergePlayerEmailHistory,
};
