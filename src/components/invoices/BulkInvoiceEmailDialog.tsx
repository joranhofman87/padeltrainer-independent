import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Loader2, Send, Eye, Mail, Info } from "lucide-react";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onClose: () => void;
  invoiceIds: string[];
  language: string;
  onSent: () => void;
}

const VARIABLES = [
  { token: "{first_name}", labelKey: "insertFirstName", fallback: "First name" },
  { token: "{last_name}", labelKey: "insertLastName", fallback: "Last name" },
  { token: "{full_name}", labelKey: "insertFullName", fallback: "Full name" },
];

export function BulkInvoiceEmailDialog({ open, onClose, invoiceIds, language, onSent }: Props) {
  const { t } = useTranslation("academy");
  const { user } = useAuth();
  const [customMessage, setCustomMessage] = useState("");
  const [markAsSent, setMarkAsSent] = useState(true);
  const [sending, setSending] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testSending, setTestSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (token: string) => {
    const el = textareaRef.current;
    if (!el) {
      setCustomMessage((m) => m + token);
      return;
    }
    const start = el.selectionStart ?? customMessage.length;
    const end = el.selectionEnd ?? customMessage.length;
    const next = customMessage.slice(0, start) + token + customMessage.slice(end);
    setCustomMessage(next.slice(0, 2000));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const handlePreview = async () => {
    if (invoiceIds.length === 0) return;
    setPreviewLoading(true);
    try {
      const { data } = await supabase.functions.invoke("send-invoice-email", {
        body: { invoiceId: invoiceIds[0], customMessage, language, previewOnly: true },
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
        body: { invoiceId: invoiceIds[0], customMessage, language, testEmail: email },
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
            <div className="space-y-2">
              <Label htmlFor="custom-msg">
                {t("invoices.bulk.messageLabel", "Email message")}
              </Label>
              <Textarea
                id="custom-msg"
                ref={textareaRef}
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value.slice(0, 2000))}
                placeholder={t(
                  "invoices.bulk.messagePlaceholder",
                  "Hi {first_name},\n\nHere is your invoice. Let me know if you have any questions.\n\nThanks!"
                )}
                rows={8}
                disabled={sending}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground mr-1">
                  {t("invoices.bulk.variablesHelp", "Insert variable:")}
                </span>
                {VARIABLES.map((v) => (
                  <Button
                    key={v.token}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => insertVariable(v.token)}
                    disabled={sending}
                  >
                    {v.token}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{customMessage.length}/2000</p>
            </div>

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
