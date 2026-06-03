import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { AffectedInvoicesSummary } from "@/lib/affectedInvoices";
import type { InvoiceUpdateChoice } from "@/lib/invoiceUpdateChoice";

type UpdateAffectedInvoicesDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: AffectedInvoicesSummary;
  onConfirm: (choice: InvoiceUpdateChoice) => void;
  loading?: boolean;
};

export function UpdateAffectedInvoicesDialog({
  open,
  onOpenChange,
  summary,
  onConfirm,
  loading = false,
}: UpdateAffectedInvoicesDialogProps) {
  const { t } = useTranslation("trainer");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("invoices.updateAffectedTitle", "Update affected invoices?")}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>
                {t(
                  "invoices.updateAffectedBody",
                  "This change affects invoices that were already sent. Draft invoices can be updated automatically. Sent invoices should only be changed if you want to resend them.",
                )}
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  {t("invoices.updateAffectedDraftCount", {
                    count: summary.draftCount,
                    defaultValue: "{{count}} draft invoice(s) will be updated",
                  })}
                </li>
                <li>
                  {t("invoices.updateAffectedSentCount", {
                    count: summary.sentOrPendingCount,
                    defaultValue: "{{count}} sent/pending invoice(s) can be updated",
                  })}
                </li>
                {summary.hasPaidUnchanged && (
                  <li>
                    {t("invoices.updateAffectedPaidCount", {
                      count: summary.paidCount,
                      defaultValue: "{{count}} paid invoice(s) will not be changed",
                    })}
                  </li>
                )}
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-col sm:flex-col gap-2 sm:space-x-0">
          <Button
            type="button"
            className="w-full sm:w-full"
            disabled={loading}
            onClick={() => onConfirm("update_drafts_and_sent")}
          >
            {t("invoices.updateDraftAndSent", "Update draft + sent invoices")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="w-full sm:w-full"
            disabled={loading}
            onClick={() => onConfirm("update_drafts_only")}
          >
            {t("invoices.updateDraftOnly", "Update draft invoices only")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-full"
            disabled={loading}
            onClick={() => onConfirm("skip")}
          >
            {t("invoices.skipInvoiceUpdates", "Do not update invoices")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
