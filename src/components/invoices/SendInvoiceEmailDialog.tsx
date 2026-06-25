import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Send, Eye, Info } from "lucide-react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabaseClient";
import { toast } from "sonner";
import { InvoiceEmailMessageField } from "./InvoiceEmailMessageField";

interface Props {
  open: boolean;
  onClose: () => void;
  invoiceId: string | null;
  /** Recipient name, shown in the dialog description. */
  playerName?: string | null;
  /** Email language for the preview render (defaults handled server-side). */
  language?: string;
  /** Pre-filled message (e.g. the academy's saved default template). */
  defaultMessage?: string;
  /** Link to the invoice settings tab where reply-to is configured. */
  replyToSettingsHref?: string;
  /** Whether the parent's send mutation is in flight (disables the dialog). */
  sending?: boolean;
  /** Fire the actual send — the parent owns the mutation (success/no-email/refresh). */
  onSend: (customMessage: string) => void;
}

/**
 * Single-invoice email composer: a personalized message (with `{first_name}` etc.
 * tokens), a server-rendered Preview, and Send. The actual send is delegated to
 * the parent via `onSend` so it reuses the page's existing send flow (settings
 * gate, no-email fallback, refresh). Modeled on BulkInvoiceEmailDialog; the
 * message editor is the shared `InvoiceEmailMessageField`.
 */
export function SendInvoiceEmailDialog({
  open,
  onClose,
  invoiceId,
  playerName,
  language,
  defaultMessage = "",
  replyToSettingsHref,
  sending = false,
  onSend,
}: Props) {
  const { t } = useTranslation("academy");
  const [message, setMessage] = useState(defaultMessage);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Re-seed the message from the default each time the dialog opens.
  useEffect(() => {
    if (open) setMessage(defaultMessage);
  }, [open, defaultMessage]);

  const handlePreview = async () => {
    if (!invoiceId) return;
    setPreviewLoading(true);
    try {
      const { data } = await supabase.functions.invoke("send-invoice-email", {
        body: { invoiceId, customMessage: message, language, previewOnly: true },
      });
      if (data?.html) {
        setPreviewHtml(data.html);
      } else {
        toast.error(t("invoices.send.previewFailed", "Could not generate preview"));
      }
    } catch {
      toast.error(t("invoices.send.previewFailed", "Could not generate preview"));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSend = () => {
    if (!invoiceId || sending) return;
    onSend(message);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && !sending && onClose()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("invoices.send.title", "Send invoice by email")}</DialogTitle>
            <DialogDescription>
              {playerName
                ? t("invoices.send.recipient", "To {{name}}", { name: playerName })
                : t("invoices.send.recipientGeneric", "Send this invoice to the player")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {replyToSettingsHref && (
              <div className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                <Info className="h-4 w-4 mt-0.5 shrink-0" />
                <p>
                  {t("invoices.send.replyToHint", "Replies from the player go to your reply-to email. You can set this in")}{" "}
                  <Link to={replyToSettingsHref} className="underline font-medium text-foreground" onClick={onClose}>
                    {t("invoices.send.replyToHintLink", "invoice settings")}
                  </Link>
                  .
                </p>
              </div>
            )}
            <InvoiceEmailMessageField
              value={message}
              onChange={setMessage}
              disabled={sending}
              label={t("invoices.send.messageLabel", "Email message (optional)")}
              placeholder={t(
                "invoices.send.messagePlaceholder",
                "Hi {first_name},\n\nHere is your invoice. Let me know if you have any questions.\n\nThanks!",
              )}
              variablesHelp={t("invoices.send.variablesHelp", "Insert variable:")}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={onClose} disabled={sending}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button variant="outline" onClick={handlePreview} disabled={sending || previewLoading || !invoiceId}>
              {previewLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Eye className="h-4 w-4 mr-2" />}
              {t("invoices.send.preview", "Preview")}
            </Button>
            <Button onClick={handleSend} disabled={sending || !invoiceId}>
              {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              {sending ? t("invoices.send.sending", "Sending...") : t("invoices.send.send", "Send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewHtml} onOpenChange={(o) => !o && setPreviewHtml(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t("invoices.send.previewTitle", "Email preview")}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-auto rounded-md border bg-white">
            <iframe title="invoice-email-preview" srcDoc={previewHtml ?? ""} className="w-full h-[60vh]" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
