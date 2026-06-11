import { useState, useEffect } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { useTranslation, Trans } from "react-i18next";
import { SEO } from "@/components/SEO";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Loader2, CheckCircle, FileText, AlertCircle, CreditCard, UserPlus, Pencil, LogIn, ArrowDown } from "lucide-react";
import { format } from "date-fns";
import { nl, enUS, de, fr, es, it } from "date-fns/locale";

const dateLocales: Record<string, any> = { nl, en: enUS, de, fr, es, it };
const getDateLocale = (lang: string) => dateLocales[lang?.slice(0, 2)] ?? nl;
import { toast } from "sonner";
import {
  isPublicInvoiceDetailPayload,
  resolvePublicInvoiceLoadError,
} from "@/lib/publicInvoiceFetch";
import {
  getOnlinePaymentUnavailableMessageKey,
  type PublicInvoicePaymentRecipient,
} from "@/lib/publicInvoiceMollieMessage";
import { buildPaidInvoiceClaimSignupPath } from "@/lib/signupClaimFlow";
import { trackInvoiceClaimStarted } from "@/lib/invoiceClaimTracking";
import {
  normalizeInvoicePayRecipientType,
  normalizeInvoicePayStatus,
  trackInvoicePayPageLoadFailed,
  trackInvoicePayPageLoaded,
  trackInvoicePaymentFailed,
  trackInvoicePaymentRedirect,
  trackInvoicePaymentStarted,
} from "@/lib/invoicePayTracking";
import { resolvePublicInvoiceContactEmail } from "@/lib/publicInvoiceContact";
import { formatCurrency } from "@/lib/format";

// Keep the /pay/:token URL out of Referer headers — these tokens grant access
// to invoice PII until the invoice is paid.
function useNoReferrerMeta() {
  useEffect(() => {
    const prev = document.querySelector('meta[name="referrer"]');
    const prevContent = prev?.getAttribute("content") ?? null;
    let tag = prev as HTMLMetaElement | null;
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "referrer");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", "no-referrer");
    return () => {
      if (prevContent !== null) tag!.setAttribute("content", prevContent);
      else tag!.parentNode?.removeChild(tag!);
    };
  }, []);
}


const formatEuro = (amount: number | null | undefined) =>
  (amount ?? 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

interface PublicInvoiceData {
  invoice: {
    id: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate: string;
    playerName: string;
    playerId: string | null;
    playerEmail: string | null;
    playerBusinessName: string | null;
    playerAddress: string | null;
    playerBtwNumber: string | null;
    total: number;
    subtotal: number;
    vatAmount: number;
    vatRate: number;
    lineItems: LineItem[];
    status: string;
    hasMolliePayment: boolean;
    hasMollieAccount: boolean;
    paymentUnavailableReason?: string | null;
    paymentRecipient?: PublicInvoicePaymentRecipient;
  };
  academy: {
    name: string;
    slug: string | null;
    logoUrl: string | null;
    bannerColor: string | null;
    contactEmail: string | null;
    invoiceReplyToEmail: string | null;
    businessName: string | null;
    businessAddress: string | null;
    kvkNumber: string | null;
    btwNumber: string | null;
    iban: string | null;
    bic: string | null;
  } | null;
}

function PublicPayAccountActions() {
  const { t } = useTranslation("common");

  return (
    <div className="pt-4 space-y-3 text-left" data-testid="public-pay-account-actions">
      <p className="text-sm text-muted-foreground">{t("invoice.paidPrivacyMessage")}</p>
      <div className="flex flex-col sm:flex-row gap-2 justify-center">
        <Link to={buildPaidInvoiceClaimSignupPath()}>
          <Button
            variant="default"
            className="ph-no-capture gap-2 w-full sm:w-auto"
            data-testid="public-pay-claim-account"
            onClick={() => {
              try {
                trackInvoiceClaimStarted();
              } catch {
                /* analytics must not block navigation */
              }
            }}
          >
            <UserPlus className="h-4 w-4" />
            {t("invoice.publicPayClaimAccount")}
          </Button>
        </Link>
        <Link to="/app/auth">
          <Button variant="outline" className="gap-2 w-full sm:w-auto" data-testid="public-pay-log-in">
            <LogIn className="h-4 w-4" />
            {t("invoice.publicPayLogIn")}
          </Button>
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">{t("invoice.publicPaySignupHelper")}</p>
      <p className="text-xs text-muted-foreground">{t("invoice.publicPayForgotPasswordNote")}</p>
    </div>
  );
}

function PostPaymentCTA({ playerId }: { playerId?: string | null }) {
  const { t } = useTranslation();

  if (playerId) {
    return (
      <div className="pt-4">
        <Link to="/app/player">
          <Button variant="outline" className="gap-2">
            <LogIn className="h-4 w-4" />
            {t("invoice.goToMyAccount")}
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="pt-4 space-y-2">
      <p className="text-sm text-muted-foreground">{t("invoice.publicPaySignupHelper")}</p>
      <Link to={buildPaidInvoiceClaimSignupPath()}>
        <Button variant="outline" className="gap-2">
          <UserPlus className="h-4 w-4" />
          {t("invoice.publicPayClaimAccount")}
        </Button>
      </Link>
    </div>
  );
}

function InvoiceBanner({ academy }: { academy: PublicInvoiceData["academy"] }) {
  if (!academy) return null;
  const bannerColor = academy.bannerColor || "hsl(var(--primary))";

  return (
    <div
      className="px-6 py-6 flex items-center justify-center"
      style={{ backgroundColor: bannerColor }}
    >
      {academy.logoUrl ? (
        <img
          src={academy.logoUrl}
          alt={academy.name || "Logo"}
          className="h-12 max-w-[200px] object-contain"
        />
      ) : (
        <h2 className="text-xl font-bold text-white">{academy.name}</h2>
      )}
    </div>
  );
}

function BusinessDetails({ academy }: { academy: PublicInvoiceData["academy"] }) {
  if (!academy) return null;
  const hasDetails = academy.businessName || academy.businessAddress || academy.kvkNumber || academy.btwNumber;
  if (!hasDetails) return null;

  return (
    <div className="text-sm text-muted-foreground space-y-0.5">
      {academy.businessName && <p className="font-medium text-foreground">{academy.businessName}</p>}
      {academy.businessAddress && <p className="whitespace-pre-line">{academy.businessAddress}</p>}
      {academy.kvkNumber && <p>KvK: {academy.kvkNumber}</p>}
      {academy.btwNumber && <p>BTW: {academy.btwNumber}</p>}
    </div>
  );
}

function EditDetailsDialog({
  open,
  onOpenChange,
  invoice,
  publicToken,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: PublicInvoiceData["invoice"];
  publicToken: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation("common");
  const [businessName, setBusinessName] = useState(invoice.playerBusinessName || "");
  const [address, setAddress] = useState(invoice.playerAddress || "");
  const [btwNumber, setBtwNumber] = useState(invoice.playerBtwNumber || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke("update-public-invoice-details", {
        body: {
          publicToken,
          playerBusinessName: businessName,
          playerAddress: address,
          playerBtwNumber: btwNumber,
        },
      });
      if (error || (data && (data as any).error)) throw error || new Error((data as any).error);
      toast.success(t("changesSaved", "Changes saved"));
      onOpenChange(false);
      onSaved();
    } catch {
      toast.error(t("errorSaving", "Failed to save changes"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("updateBillingDetails", "Update billing details")}</DialogTitle>
          <DialogDescription>
            {t("updateBillingDetailsDesc", "Add or change your business details on this invoice.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>{t("businessName", "Business name")}</Label>
            <Input
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder={t("businessNamePlaceholder", "Your company name (optional)")}
            />
          </div>
          <div>
            <Label>{t("address", "Address")}</Label>
            <Textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={t("addressPlaceholder", "Street, city, postal code")}
              rows={3}
            />
          </div>
          <div>
            <Label>{t("btwNumber", "BTW number")}</Label>
            <Input
              value={btwNumber}
              onChange={(e) => setBtwNumber(e.target.value)}
              placeholder="NL123456789B01"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel", "Cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t("save", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlayerDetails({
  invoice,
  publicToken,
  onRefresh,
}: {
  invoice: PublicInvoiceData["invoice"];
  publicToken: string;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("common");
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">{t("to", "To")}</p>
      {invoice.playerBusinessName && (
        <p className="text-sm font-medium">{invoice.playerBusinessName}</p>
      )}
      <p className={`text-sm ${invoice.playerBusinessName ? "text-muted-foreground" : "font-medium"}`}>
        {invoice.playerName}
      </p>
      {invoice.playerAddress && (
        <p className="text-sm text-muted-foreground whitespace-pre-line">{invoice.playerAddress}</p>
      )}
      {invoice.playerBtwNumber && (
        <p className="text-sm text-muted-foreground">BTW: {invoice.playerBtwNumber}</p>
      )}

      <button
        onClick={() => setEditOpen(true)}
        className="text-xs text-primary hover:underline mt-1.5 inline-flex items-center gap-1"
      >
        <Pencil className="h-3 w-3" />
        {t("invoice.editBillingDetails", "Edit billing details")}
      </button>
      <EditDetailsDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        invoice={invoice}
        publicToken={publicToken}
        onSaved={onRefresh}
      />
    </div>
  );
}

export default function PublicInvoicePay() {
  useNoReferrerMeta();
  const { t, i18n } = useTranslation("common");
  const { token } = useParams<{ token: string }>();
  
  const [data, setData] = useState<PublicInvoiceData | null>(null);
  const [searchParams] = useSearchParams();
  const isSuccessRedirect = searchParams.get("status") === "success";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);
  const [payLoading, setPayLoading] = useState(false);

  // Pin language to the URL locale segment so the page matches the email link's language
  useEffect(() => {
    const seg = window.location.pathname.split("/").filter(Boolean)[0];
    const supported = ["nl", "en", "es", "de", "fr", "it"];
    if (seg && supported.includes(seg) && i18n.language !== seg) {
      i18n.changeLanguage(seg);
    }
  }, [i18n]);

  useEffect(() => {
    if (!token) return;
    fetchInvoice();
  }, [token]);

  const fetchInvoice = async () => {
    try {
      const { data: result, error: fnError } = await supabase.functions.invoke("get-public-invoice", {
        body: { publicToken: token },
      });

      const loadError = resolvePublicInvoiceLoadError(result, fnError);
      if (loadError === "already_paid") {
        setIsPaid(true);
        try {
          trackInvoicePayPageLoaded({
            has_mollie_account: false,
            recipient_type: "unknown",
            status: "paid",
          });
        } catch {
          /* analytics must not block page */
        }
        return;
      }
      if (loadError === "cancelled") {
        setIsCancelled(true);
        try {
          trackInvoicePayPageLoaded({
            has_mollie_account: false,
            recipient_type: "unknown",
            status: "cancelled",
          });
        } catch {
          /* analytics must not block page */
        }
        return;
      }
      if (loadError) {
        setError(loadError);
        try {
          trackInvoicePayPageLoadFailed(loadError);
        } catch {
          /* analytics must not block page */
        }
        return;
      }

      if (fnError || !isPublicInvoiceDetailPayload(result)) {
        setError("not_found");
        try {
          trackInvoicePayPageLoadFailed("not_found");
        } catch {
          /* analytics must not block page */
        }
        return;
      }

      const loaded = result as PublicInvoiceData;
      setData(loaded);
      try {
        const inv = loaded.invoice;
        trackInvoicePayPageLoaded({
          has_mollie_account: inv.hasMollieAccount,
          payment_unavailable_reason: inv.paymentUnavailableReason ?? null,
          recipient_type: normalizeInvoicePayRecipientType(
            inv.paymentRecipient ?? (loaded.academy ? "academy" : "trainer"),
          ),
          status: normalizeInvoicePayStatus(inv.status),
        });
      } catch {
        /* analytics must not block page */
      }
    } catch {
      setError("not_found");
      try {
        trackInvoicePayPageLoadFailed("not_found");
      } catch {
        /* analytics must not block page */
      }
    } finally {
      setLoading(false);
    }
  };

  const paymentRecipient: PublicInvoicePaymentRecipient =
    data?.invoice.paymentRecipient ??
    (data?.academy ? "academy" : data?.invoice ? "trainer" : null);

  const onlinePaymentUnavailableMessage = t(
    getOnlinePaymentUnavailableMessageKey(paymentRecipient),
  );

  const showOnlinePaymentUnavailable =
    !!data && !data.invoice.hasMollieAccount && data.invoice.status !== "paid";

  const handlePay = async () => {
    if (!data || !data.invoice.hasMollieAccount) return;
    const payRecipient = normalizeInvoicePayRecipientType(paymentRecipient);
    const payStatus = normalizeInvoicePayStatus(data.invoice.status);
    try {
      trackInvoicePaymentStarted({
        has_mollie_account: data.invoice.hasMollieAccount,
        payment_unavailable_reason: data.invoice.paymentUnavailableReason ?? null,
        recipient_type: payRecipient,
        status: payStatus,
      });
    } catch {
      /* analytics must not block payment */
    }
    setPayLoading(true);
    try {
      const { data: result, error: fnError } = await supabase.functions.invoke("create-invoice-payment", {
        body: { invoiceId: data.invoice.id, publicToken: token },
      });

      if (fnError) throw fnError;
      if (result?.paymentUrl) {
        try {
          trackInvoicePaymentRedirect({
            recipient_type: payRecipient,
            status: payStatus,
          });
        } catch {
          /* analytics must not block redirect */
        }
        window.location.href = result.paymentUrl;
      } else {
        throw new Error("No payment URL");
      }
    } catch (err: any) {
      let errorCode: string | null = null;
      try {
        const parsed = typeof err?.message === "string" ? JSON.parse(err.message) : null;
        errorCode = parsed?.error ?? null;
      } catch {
        errorCode = err?.error ?? null;
      }
      const trackedErrorCode = errorCode ?? "payment_failed";
      try {
        trackInvoicePaymentFailed(trackedErrorCode);
      } catch {
        /* analytics must not block error UI */
      }

      if (errorCode === "no_mollie_account") {
        toast.error(onlinePaymentUnavailableMessage);
      } else if (errorCode === "missing_mollie_profile") {
        toast.error(t("invoice.errorMissingProfile"));
      } else {
        toast.error(t("invoice.errorPaymentFailed"));
      }
    } finally {
      setPayLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <SEO title={t("invoice.seoTitle")} description={t("invoice.seoDescription")} noIndex={true} />
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (isPaid) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <SEO title={t("invoice.paymentReceived")} description={t("invoice.paymentReceivedDescription")} noIndex={true} />
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <CheckCircle className="h-16 w-16 text-green-500 mx-auto" />
            <h1 className="text-2xl font-bold">{t("invoice.paymentReceived")}</h1>
            <p className="text-muted-foreground">{t("invoice.paymentReceivedDescription")}</p>
            <PublicPayAccountActions />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isCancelled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <SEO title={t("invoice.invoiceCancelledTitle")} description={t("invoice.invoiceCancelledDescription")} noIndex={true} />
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <AlertCircle className="h-16 w-16 text-muted-foreground mx-auto" />
            <h1 className="text-2xl font-bold">{t("invoice.invoiceCancelledTitle")}</h1>
            <p className="text-muted-foreground">{t("invoice.invoiceCancelledDescription")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isSuccessRedirect && data && data.invoice.status !== "paid") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <SEO title={t("invoice.paymentProcessing")} description={t("invoice.paymentProcessingDescription")} noIndex={true} />
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <CheckCircle className="h-16 w-16 text-primary mx-auto" />
            <h1 className="text-2xl font-bold">{t("invoice.paymentProcessing")}</h1>
            <p className="text-muted-foreground">{t("invoice.paymentProcessingDescription")}</p>
            <PostPaymentCTA playerId={data?.invoice.playerId} />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    const errorCopy =
      error === "unavailable"
        ? {
            title: t("invoice.pageUnavailable"),
            description: t("invoice.pageUnavailableDescription"),
          }
        : error === "draft_invoice"
          ? {
              title: t("invoice.draftNotSent"),
              description: t("invoice.draftNotSentDescription"),
            }
          : error === "cancelled"
            ? {
                title: t("invoice.invoiceCancelledTitle"),
                description: t("invoice.invoiceCancelledDescription"),
              }
            : {
                title: t("invoice.invoiceNotFound"),
                description: t("invoice.invoiceNotFoundDescription"),
              };

    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <SEO title={errorCopy.title} description={errorCopy.description} noIndex={true} />
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <AlertCircle className="h-16 w-16 text-muted-foreground mx-auto" />
            <h1 className="text-2xl font-bold">{errorCopy.title}</h1>
            <p className="text-muted-foreground">{errorCopy.description}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { invoice, academy } = data;
  const publicContactEmail = resolvePublicInvoiceContactEmail(academy);
  const isOverdue = new Date(invoice.dueDate) < new Date();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <SEO title={t("invoice.seoTitlePay")} description={t("invoice.seoDescriptionPay")} noIndex={true} />
      <Card className="max-w-lg w-full overflow-hidden">
        {/* Branded banner */}
        <InvoiceBanner academy={academy} />

        <CardContent className="p-6 space-y-6">
          {/* Invoice header */}
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-muted-foreground font-mono">{invoice.invoiceNumber}</p>
              <h1 className="text-xl font-bold mt-1">{academy?.name || t("invoice.seoTitle")}</h1>
            </div>
            {isOverdue ? (
              <Badge variant="destructive">
                <AlertCircle className="h-3 w-3 mr-1" />{t("invoice.overdue")}
              </Badge>
            ) : (
              <Badge variant="secondary">
                <FileText className="h-3 w-3 mr-1" />{t("invoice.open")}
              </Badge>
            )}
          </div>

          {/* Guided steps */}
          <div className="flex items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 rounded-full bg-primary/10 text-primary px-3 py-1 font-medium">
              <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-primary text-primary-foreground text-[10px]">1</span>
              {t("invoice.stepReviewDetails")}
            </div>
            <div className="h-px flex-1 bg-border" />
            <div className="flex items-center gap-1.5 rounded-full bg-muted text-muted-foreground px-3 py-1 font-medium">
              <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-muted-foreground/30 text-[10px]">2</span>
              {t("invoice.stepPay")}
            </div>
          </div>

          <Separator />

          {/* From / To */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">{t("invoice.from")}</p>
              <BusinessDetails academy={academy} />
              {!academy?.businessName && academy?.name && (
                <p className="text-sm font-medium">{academy.name}</p>
              )}
            </div>
            <PlayerDetails
              invoice={invoice}
              publicToken={token!}
              onRefresh={fetchInvoice}
            />
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">{t("invoice.invoiceDate")}</p>
              <p className="font-medium">{format(new Date(invoice.invoiceDate), "dd MMM yyyy", { locale: getDateLocale(i18n.language) })}</p>
            </div>
            <div>
              <p className="text-muted-foreground">{t("invoice.dueDate")}</p>
              <p className={`font-medium ${isOverdue ? "text-destructive" : ""}`}>
                {format(new Date(invoice.dueDate), "dd MMM yyyy", { locale: getDateLocale(i18n.language) })}
              </p>
            </div>
          </div>

          <Separator />

          {/* Line items */}
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium">{t("invoice.description")}</th>
                  <th className="text-right p-3 font-medium">{t("invoice.qty")}</th>
                  <th className="text-right p-3 font-medium">{t("invoice.price")}</th>
                  <th className="text-right p-3 font-medium">{t("invoice.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {(invoice.lineItems || []).map((item: LineItem, idx: number) => (
                  <tr key={idx} className="border-b last:border-0">
                    <td className="p-3">{item.description}</td>
                    <td className="text-right p-3">{item.quantity}</td>
                    <td className="text-right p-3">{formatCurrency(item.unit_price)}</td>
                    <td className="text-right p-3">{formatCurrency(item.total ?? item.quantity * item.unit_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("invoice.subtotal")}</span>
              <span>{formatCurrency(invoice.subtotal)}</span>
            </div>
            {invoice.vatAmount > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t("invoice.vatLine", { rate: invoice.vatRate ?? 0 })}</span>
                <span>{formatCurrency(invoice.vatAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-lg pt-2 border-t">
              <span>{t("invoice.total")}</span>
              <span>{formatCurrency(invoice.total)}</span>
            </div>
          </div>

          {showOnlinePaymentUnavailable && (
            <div
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-foreground"
              role="status"
            >
              {onlinePaymentUnavailableMessage}
            </div>
          )}

          {/* Pay button — only when payment creation can succeed */}
          {invoice.hasMollieAccount ? (
            <div className="space-y-2">
              <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                <ArrowDown className="h-3 w-3" />
                {t("invoice.payHelper")}
              </p>
              <Button
                className="w-full"
                size="lg"
                onClick={handlePay}
                disabled={payLoading}
              >
                {payLoading ? (
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                ) : (
                  <CreditCard className="h-5 w-5 mr-2" />
                )}
                {payLoading ? t("invoice.redirecting") : t("invoice.payAmount", { amount: formatEuro(invoice.total) })}
              </Button>
            </div>
          ) : null}

          {/* Bank details — prominent when no online payment available */}
          {academy?.iban && !invoice.hasMollieAccount && (
            <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-1">
              {!invoice.hasMollieAccount && (
                <p className="font-medium text-foreground mb-2">
                  {t("invoice.transferInstruction")}
                </p>
              )}
              <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {invoice.hasMollieAccount ? t("invoice.bankTransferAlt") : t("invoice.bankDetails")}
              </p>
              <p><span className="text-muted-foreground">{t("invoice.iban")}</span> {academy.iban}</p>
              {academy.bic && <p><span className="text-muted-foreground">{t("invoice.bic")}</span> {academy.bic}</p>}
              {(academy.businessName || academy.name) && (
                <p><span className="text-muted-foreground">{t("invoice.name")}</span> {academy.businessName || academy.name}</p>
              )}
              <p><span className="text-muted-foreground">{t("invoice.reference")}</span> {invoice.invoiceNumber}</p>
            </div>
          )}

          {/* Contact */}
          {publicContactEmail && (
            <p className="text-xs text-center text-muted-foreground">
              <Trans
                i18nKey="invoice.questionsContact"
                values={{ email: publicContactEmail }}
                components={{
                  a: <a href={`mailto:${publicContactEmail}`} className="underline" />,
                }}
              />
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
