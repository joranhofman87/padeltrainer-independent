import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Loader2, Send } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onClose: () => void;
  invoiceIds: string[];
  language: string;
  onSent: () => void;
}

export function BulkInvoiceEmailDialog({ open, onClose, invoiceIds, language, onSent }: Props) {
  const { t } = useTranslation("academy");
  const [customMessage, setCustomMessage] = useState("");
  const [markAsSent, setMarkAsSent] = useState(true);
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    let sent = 0, noEmail = 0, failed = 0;

    for (const id of invoiceIds) {
      try {
        const { data } = await supabase.functions.invoke("send-invoice-email", {
          body: { invoiceId: id, customMessage, language },
        });
        if (data?.error === "no_email") {
          noEmail++;
        } else if (data?.success) {
          sent++;
          if (markAsSent) {
            await supabase.from("invoices")
              .update({ status: "sent", sent_at: new Date().toISOString() })
              .eq("id", id);
          }
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    toast.success(
      t("invoices.bulk.emailDone", "Sent: {{sent}}, no email: {{noEmail}}, failed: {{failed}}", { sent, noEmail, failed })
    );
    setSending(false);
    setCustomMessage("");
    onSent();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !sending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("invoices.bulk.emailTitle", "Send invoices by email")}</DialogTitle>
          <DialogDescription>
            {t("invoices.bulk.recipientCount", "{{count}} recipient(s) selected", { count: invoiceIds.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="custom-msg">{t("invoices.bulk.customMessageLabel", "Personal message (optional)")}</Label>
            <Textarea
              id="custom-msg"
              value={customMessage}
              onChange={(e) => setCustomMessage(e.target.value.slice(0, 2000))}
              placeholder={t("invoices.bulk.customMessagePlaceholder", "This text will appear after the greeting, before the invoice details.")}
              rows={6}
              disabled={sending}
            />
            <p className="text-xs text-muted-foreground">{customMessage.length}/2000</p>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="mark-sent" checked={markAsSent} onCheckedChange={(v) => setMarkAsSent(!!v)} disabled={sending} />
            <Label htmlFor="mark-sent" className="text-sm font-normal cursor-pointer">
              {t("invoices.bulk.markAsSent", "Mark invoices as sent")}
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={sending}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={handleSend} disabled={sending || invoiceIds.length === 0}>
            {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
            {sending ? t("invoices.bulk.sending", "Sending...") : t("invoices.bulk.send", "Send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
