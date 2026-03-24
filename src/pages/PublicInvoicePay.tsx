import { useState, useEffect } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
import { Loader2, CheckCircle, FileText, AlertCircle, CreditCard, UserPlus, Pencil, LogIn } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";

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
  };
  academy: {
    name: string;
    slug: string | null;
    logoUrl: string | null;
    bannerColor: string | null;
    contactEmail: string | null;
    businessName: string | null;
    businessAddress: string | null;
    kvkNumber: string | null;
    btwNumber: string | null;
    iban: string | null;
    bic: string | null;
  } | null;
}

function PostPaymentCTA({ playerName, playerEmail, playerId }: { playerName?: string; playerEmail?: string | null; playerId?: string | null }) {
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

  const params = new URLSearchParams();
  if (playerEmail) params.set('email', playerEmail);
  if (playerName) params.set('name', playerName);
  params.set('redirect', '/app/player');
  const signupUrl = `/app/signup/player?${params.toString()}`;

  return (
    <div className="pt-4">
      <Link to={signupUrl}>
        <Button variant="outline" className="gap-2">
          <UserPlus className="h-4 w-4" />
          {t("invoice.createAccountToViewInvoices")}
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
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: PublicInvoiceData["invoice"];
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
      const { error } = await supabase
        .from("invoices")
        .update({
          player_business_name: businessName || null,
          player_address: address || null,
          player_btw_number: btwNumber || null,
        })
        .eq("id", invoice.id);

      if (error) throw error;
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
  currentUserId,
  onRefresh,
}: {
  invoice: PublicInvoiceData["invoice"];
  currentUserId: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("common");
  const [editOpen, setEditOpen] = useState(false);
  const isOwner = currentUserId && invoice.playerId && currentUserId === invoice.playerId;

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

      {isOwner ? (
        <>
          <button
            onClick={() => setEditOpen(true)}
            className="text-xs text-primary hover:underline mt-1.5 inline-flex items-center gap-1"
          >
            <Pencil className="h-3 w-3" />
            {t("updateBillingDetails", "Update billing details")}
          </button>
          <EditDetailsDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            invoice={invoice}
            onSaved={onRefresh}
          />
        </>
      ) : !currentUserId ? (
        <Link
          to={`/app/auth?redirect=${encodeURIComponent(window.location.pathname)}`}
          className="text-xs text-muted-foreground hover:text-primary hover:underline mt-1.5 inline-block"
        >
          {t("loginToEditDetails", "Log in to update your details")}
        </Link>
      ) : null}
    </div>
  );
}

export default function PublicInvoicePay() {
  const { t } = useTranslation("common");
  const { token } = useParams<{ token: string }>();
  const { user } = useAuth();
  const [data, setData] = useState<PublicInvoiceData | null>(null);
  const [searchParams] = useSearchParams();
  const isSuccessRedirect = searchParams.get("status") === "success";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [payLoading, setPayLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetchInvoice();
  }, [token]);

  const fetchInvoice = async () => {
    try {
      const { data: result, error: fnError } = await supabase.functions.invoke("get-public-invoice", {
        body: { publicToken: token },
      });

      if (fnError) throw fnError;

      if (result?.error === "already_paid") {
        setIsPaid(true);
        return;
      }

      if (result?.error) {
        setError(result.error);
        return;
      }

      setData(result);
    } catch {
      setError("not_found");
    } finally {
      setLoading(false);
    }
  };

  const handlePay = async () => {
    if (!data) return;
    setPayLoading(true);
    try {
      const { data: result, error: fnError } = await supabase.functions.invoke("create-invoice-payment", {
        body: { invoiceId: data.invoice.id },
      });

      if (fnError) throw fnError;
      if (result?.paymentUrl) {
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
        // message is not JSON, check if result had error
        errorCode = err?.error ?? null;
      }

      if (errorCode === "no_mollie_account") {
        toast.error("Online betaling is momenteel niet beschikbaar.");
      } else if (errorCode === "missing_mollie_profile") {
        toast.error("De betaalomgeving van deze aanbieder is nog niet volledig ingesteld.");
      } else {
        toast.error("Betaling aanmaken mislukt. Probeer het opnieuw.");
      }
    } finally {
      setPayLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30">
        <SEO title="Invoice" description="Invoice payment" noIndex={true} />
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
            <PostPaymentCTA playerName={data?.invoice.playerName} playerEmail={data?.invoice.playerEmail} />
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
            <PostPaymentCTA playerName={data?.invoice.playerName} playerEmail={data?.invoice.playerEmail} />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <SEO title={t("invoice.invoiceNotFound")} description={t("invoice.invoiceNotFoundDescription")} noIndex={true} />
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <AlertCircle className="h-16 w-16 text-muted-foreground mx-auto" />
            <h1 className="text-2xl font-bold">{t("invoice.invoiceNotFound")}</h1>
            <p className="text-muted-foreground">{t("invoice.invoiceNotFoundDescription")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { invoice, academy } = data;
  const isOverdue = new Date(invoice.dueDate) < new Date();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <SEO title="Invoice Payment" description="Pay your invoice online." noIndex={true} />
      <Card className="max-w-lg w-full overflow-hidden">
        {/* Branded banner */}
        <InvoiceBanner academy={academy} />

        <CardContent className="p-6 space-y-6">
          {/* Invoice header */}
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm text-muted-foreground font-mono">{invoice.invoiceNumber}</p>
              <h1 className="text-xl font-bold mt-1">{academy?.name || "Invoice"}</h1>
            </div>
            {isOverdue ? (
              <Badge variant="destructive">
                <AlertCircle className="h-3 w-3 mr-1" />Overdue
              </Badge>
            ) : (
              <Badge variant="secondary">
                <FileText className="h-3 w-3 mr-1" />Open
              </Badge>
            )}
          </div>

          <Separator />

          {/* From / To */}
          <div className="grid grid-cols-2 gap-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">From</p>
              <BusinessDetails academy={academy} />
              {!academy?.businessName && academy?.name && (
                <p className="text-sm font-medium">{academy.name}</p>
              )}
            </div>
            <PlayerDetails
              invoice={invoice}
              currentUserId={user?.id ?? null}
              onRefresh={fetchInvoice}
            />
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Invoice date</p>
              <p className="font-medium">{format(new Date(invoice.invoiceDate), "dd MMM yyyy")}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Due date</p>
              <p className={`font-medium ${isOverdue ? "text-destructive" : ""}`}>
                {format(new Date(invoice.dueDate), "dd MMM yyyy")}
              </p>
            </div>
          </div>

          <Separator />

          {/* Line items */}
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium">Description</th>
                  <th className="text-right p-3 font-medium">Qty</th>
                  <th className="text-right p-3 font-medium">Price</th>
                  <th className="text-right p-3 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(invoice.lineItems || []).map((item: LineItem, idx: number) => (
                  <tr key={idx} className="border-b last:border-0">
                    <td className="p-3">{item.description}</td>
                    <td className="text-right p-3">{item.quantity}</td>
                    <td className="text-right p-3">€{formatEuro(item.unit_price)}</td>
                    <td className="text-right p-3">€{formatEuro(item.total ?? item.quantity * item.unit_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>€{formatEuro(invoice.subtotal)}</span>
            </div>
            {invoice.vatAmount > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">VAT ({invoice.vatRate ?? 0}%)</span>
                <span>€{formatEuro(invoice.vatAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-lg pt-2 border-t">
              <span>Total</span>
              <span>€{formatEuro(invoice.total)}</span>
            </div>
          </div>

          {/* Pay button — only when academy has Mollie connected */}
          {invoice.hasMollieAccount ? (
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
              {payLoading ? "Redirecting..." : `Pay €${formatEuro(invoice.total)}`}
            </Button>
          ) : null}

          {/* Bank details — prominent when no online payment available */}
          {academy?.iban && !invoice.hasMollieAccount && (
            <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-1">
              {!invoice.hasMollieAccount && (
                <p className="font-medium text-foreground mb-2">
                  Please transfer the amount to the bank account below
                </p>
              )}
              <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                {invoice.hasMollieAccount ? "Or pay via bank transfer" : "Bank details"}
              </p>
              <p><span className="text-muted-foreground">IBAN:</span> {academy.iban}</p>
              {academy.bic && <p><span className="text-muted-foreground">BIC:</span> {academy.bic}</p>}
              {(academy.businessName || academy.name) && (
                <p><span className="text-muted-foreground">Name:</span> {academy.businessName || academy.name}</p>
              )}
              <p><span className="text-muted-foreground">Reference:</span> {invoice.invoiceNumber}</p>
            </div>
          )}

          {/* Contact */}
          {academy?.contactEmail && (
            <p className="text-xs text-center text-muted-foreground">
              Questions? Contact{" "}
              <a href={`mailto:${academy.contactEmail}`} className="underline">
                {academy.contactEmail}
              </a>
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
