import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2, Send, Eye, Mail, Info } from "lucide-react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabaseClient";
import { markInvoicesSent } from "@/lib/invoices";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { InvoiceEmailMessageField } from "./InvoiceEmailMessageField";
import { EmailSubjectField } from "@/components/email/EmailSubjectField";

interface Props {
  open: boolean;
  onClose: () => void;
  invoiceIds: string[];
  language: string;
  onSent: () => void;
  /** Pre-fill the message with the academy's saved default. */
  defaultMessage?: string;
  /** Persist the current message as the account default (parent owns the write). */
  onSaveDefault?: (message: string) => void;
  /** Pre-fill the subject with the academy's saved default (empty ⇒ the composed default). */
  defaultSubject?: string;
  /** Persist the current subject as the account default (parent owns the write). */
  onSaveDefaultSubject?: (subject: string) => void;
}

export function BulkInvoiceEmailDialog({ open, onClose, invoiceIds, language, onSent, defaultMessage = "", onSaveDefault, defaultSubject = "", onSaveDefaultSubject }: Props) {
  const { t } = useTranslation("academy");
  const { user } = useAuth();
  const [customMessage, setCustomMessage] = useState(defaultMessage);
  const [customSubject, setCustomSubject] = useState(defaultSubject);
  const [markAsSent, setMarkAsSent] = useState(true);
  const [sending, setSending] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testSending, setTestSending] = useState(false);

  // Re-seed from the saved default each time the dialog opens.
  useEffect(() => {
    if (open) {
      setCustomMessage(defaultMessage);
      setCustomSubject(defaultSubject);
    }
  }, [open, defaultMessage, defaultSubject]);

  const handlePreview = async () => {
    if (invoiceIds.length === 0) return;
    setPreviewLoading(true);
    try {
      const { data } = await supabase.functions.invoke("send-invoice-email", {
        body: { invoiceId: invoiceIds[0], customMessage, customSubject, language, previewOnly: true },
      });
      if (data?.html) {
        setPreviewHtml(data.html);
      } else {
        toast.error(t("invoices.bulk.previewFailed", "Could not generate preview"));
      }
    } catch {
      toast.error(t("invoices.bulk.previewFailed", "Could not generate preview"));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSendTest = async () => {
    const email = (testEmail || user?.email || "").trim();
    if (!email || invoiceIds.length === 0) return;
    setTestSending(true);
    try {
      const { data } = await supabase.functions.invoke("send-invoice-email", {
        body: { invoiceId: invoiceIds[0], customMessage, customSubject, language, testEmail: email },
      });
      if (data?.success) {
        toast.success(t("invoices.bulk.testSent", "Test email sent to {{email}}", { email }));
      } else {
        toast.error(t("invoices.bulk.testFailed", "Could not send test email"));
      }
    } catch {
      toast.error(t("invoices.bulk.testFailed", "Could not send test email"));
    } finally {
      setTestSending(false);
    }
  };

  const [, setProgress] = useState({ current: 0, total: 0, sent: 0, noEmail: 0, failed: 0 });

  const runBulkSend = async (ids: string[], message: string, subject: string, mark: boolean, toastId: string | number) => {
    let sent = 0, noEmail = 0, failed = 0;
    const total = ids.length;
    const CONCURRENCY = 3;
    let cursor = 0;

    const updateToast = (current: number) => {
      toast.loading(
        t("invoices.bulk.progressToast", "Sending invoices… {{current}} of {{total}}", { current, total }),
        { id: toastId, description: t("invoices.bulk.progressToastDesc", "You can safely close this window. Sending continues in the background.") }
      );
    };

    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= total) return;
        const id = ids[i];
        try {
          const { data } = await supabase.functions.invoke("send-invoice-email", {
            body: { invoiceId: id, customMessage: message, customSubject: subject },
          });
          if (data?.error === "no_email") {
            noEmail++;
          } else if (data?.success) {
            sent++;
            if (mark) {
              await markInvoicesSent([id]);
            }
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
        const done = sent + noEmail + failed;
        setProgress({ current: done, total, sent, noEmail, failed });
        updateToast(done);
      }
    };

    updateToast(0);
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

    toast.success(
      t("invoices.bulk.emailDone", "Sent: {{sent}}, no email: {{noEmail}}, failed: {{failed}}", { sent, noEmail, failed }),
      { id: toastId, description: undefined }
    );
    onSent();
  };

  const handleSend = () => {
    const ids = [...invoiceIds];
    const message = customMessage;
    const subject = customSubject;
    const mark = markAsSent;
    const toastId = `bulk-invoice-email-${Date.now()}`;

    setSending(true);
    setProgress({ current: 0, total: ids.length, sent: 0, noEmail: 0, failed: 0 });

    // Fire-and-forget: keeps running even if dialog closes
    runBulkSend(ids, message, subject, mark, toastId).finally(() => {
      setSending(false);
      setProgress({ current: 0, total: 0, sent: 0, noEmail: 0, failed: 0 });
    });

    // Close dialog immediately so user isn't blocked by perceived hang
    setCustomMessage("");
    onClose();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && !sending && onClose()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("invoices.bulk.emailTitle", "Send invoices by email")}</DialogTitle>
            <DialogDescription>
              {t("invoices.bulk.recipientCount", "{{count}} recipient(s) selected", { count: invoiceIds.length })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Info className="h-4 w-4 mt-0.5 shrink-0" />
              <p>
                {t(
                  "invoices.bulk.replyToHint",
                  "Replies from players go to your reply-to email. You can set this in"
                )}{" "}
                <Link
                  to="/app/academy/invoices?tab=settings"
                  className="underline font-medium text-foreground"
                  onClick={onClose}
                >
                  {t("invoices.bulk.replyToHintLink", "invoice settings")}
                </Link>
                .
              </p>
            </div>
            <EmailSubjectField
              id="custom-subject"
              value={customSubject}
              onChange={setCustomSubject}
              disabled={sending}
              label={t("invoices.bulk.subjectLabel", "Email subject")}
              placeholder={t("invoices.bulk.subjectPlaceholder", "Factuur {first_name}")}
              variablesHelp={t("invoices.bulk.variablesHelp", "Insert variable:")}
              onSaveDefault={onSaveDefaultSubject ? () => onSaveDefaultSubject(customSubject) : undefined}
              saveDefaultLabel={t("invoices.bulk.saveAsDefault", "Save as default")}
            />
            <InvoiceEmailMessageField
              id="custom-msg"
              value={customMessage}
              onChange={setCustomMessage}
              disabled={sending}
              label={t("invoices.bulk.messageLabel", "Email message")}
              placeholder={t(
                "invoices.bulk.messagePlaceholder",
                "Hi {first_name},\n\nHere is your invoice. Let me know if you have any questions.\n\nThanks!"
              )}
              variablesHelp={t("invoices.bulk.variablesHelp", "Insert variable:")}
              onSaveDefault={onSaveDefault ? () => onSaveDefault(customMessage) : undefined}
              saveDefaultLabel={t("invoices.bulk.saveAsDefault", "Save as default")}
            />

            <div className="flex items-center gap-2">
              <Checkbox id="mark-sent" checked={markAsSent} onCheckedChange={(v) => setMarkAsSent(!!v)} disabled={sending} />
              <Label htmlFor="mark-sent" className="text-sm font-normal cursor-pointer">
                {t("invoices.bulk.markAsSent", "Mark invoices as sent")}
              </Label>
            </div>

            <div className="rounded-md border p-3 space-y-2">
              <Label className="text-sm">{t("invoices.bulk.sendTest", "Send test email")}</Label>
              <div className="flex gap-2">
                <Input
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder={user?.email || t("invoices.bulk.sendTestPlaceholder", "your@email.com")}
                  disabled={testSending || sending}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSendTest}
                  disabled={testSending || sending || invoiceIds.length === 0}
                >
                  {testSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={onClose} disabled={sending}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={handlePreview}
              disabled={sending || previewLoading || invoiceIds.length === 0}
            >
              {previewLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Eye className="h-4 w-4 mr-2" />}
              {t("invoices.bulk.preview", "Preview")}
            </Button>
            <Button onClick={handleSend} disabled={sending || invoiceIds.length === 0}>
              {sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              {sending ? t("invoices.bulk.sending", "Sending...") : t("invoices.bulk.send", "Send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewHtml} onOpenChange={(o) => !o && setPreviewHtml(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t("invoices.bulk.previewTitle", "Email preview")}</DialogTitle>
            <DialogDescription>
              {t("invoices.bulk.previewDescription", "Preview based on the first selected invoice.")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-auto rounded-md border bg-white">
            <iframe
              title="email-preview"
              srcDoc={previewHtml || ""}
              className="w-full h-[60vh] border-0"
              sandbox=""
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewHtml(null)}>
              {t("common.close", "Close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
