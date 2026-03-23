import { useState, useEffect } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { SEO } from "@/components/SEO";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle, FileText, AlertCircle, CreditCard, UserPlus } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

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
    total: number;
    subtotal: number;
    vatAmount: number;
    vatRate: number;
    lineItems: LineItem[];
    status: string;
    hasMolliePayment: boolean;
  };
  academy: {
    name: string;
    slug: string | null;
    logoUrl: string | null;
    bannerColor: string | null;
    contactEmail: string | null;
  } | null;
}

export default function PublicInvoicePay() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<PublicInvoiceData | null>(null);
  const [searchParams] = useSearchParams();
  const isSuccessRedirect = searchParams.get("status") === "success";
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const [paidInvoiceNumber, setPaidInvoiceNumber] = useState<string | null>(null);
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
        setPaidInvoiceNumber(result.invoiceNumber);
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
    } catch {
      toast.error("Failed to create payment. Please try again.");
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
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <CheckCircle className="h-16 w-16 text-green-500 mx-auto" />
            <h1 className="text-2xl font-bold">Payment Received</h1>
            <p className="text-muted-foreground">
              Invoice {paidInvoiceNumber} has already been paid. Thank you!
            </p>
            <div className="pt-4">
              <Link to="/app/signup/player">
                <Button variant="outline">
                  <UserPlus className="h-4 w-4 mr-2" />
                  Create account to view your invoices
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Show processing state when redirected from Mollie but payment not yet confirmed
  if (isSuccessRedirect && data && data.invoice.status !== "paid") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <CheckCircle className="h-16 w-16 text-primary mx-auto" />
            <h1 className="text-2xl font-bold">Payment Processing</h1>
            <p className="text-muted-foreground">
              Your payment for {data.invoice.invoiceNumber} is being processed. You'll receive a confirmation shortly.
            </p>
            <div className="pt-4">
              <Link to="/app/signup/player">
                <Button variant="outline">
                  <UserPlus className="h-4 w-4 mr-2" />
                  Create account to view your invoices
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <Card className="max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <AlertCircle className="h-16 w-16 text-muted-foreground mx-auto" />
            <h1 className="text-2xl font-bold">Invoice Not Found</h1>
            <p className="text-muted-foreground">
              This invoice link is invalid or has expired.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { invoice, academy } = data;
  const bannerColor = academy?.bannerColor || null;
  const isOverdue = new Date(invoice.dueDate) < new Date();

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="max-w-lg w-full overflow-hidden">
        {/* Banner header */}
        {(academy?.logoUrl || bannerColor) && (
          <div
            className="px-6 py-6 flex items-center justify-center"
            style={{ backgroundColor: bannerColor || "hsl(var(--primary))" }}
          >
            {academy?.logoUrl ? (
              <img
                src={academy.logoUrl}
                alt={academy.name || "Logo"}
                className="h-12 max-w-[200px] object-contain"
              />
            ) : (
              <h2 className="text-xl font-bold text-white">{academy?.name}</h2>
            )}
          </div>
        )}

        <CardHeader className="pb-2">
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
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Invoice meta */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">To</p>
              <p className="font-medium">{invoice.playerName}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Date</p>
              <p className="font-medium">{format(new Date(invoice.invoiceDate), "dd MMM yyyy")}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Due</p>
              <p className={`font-medium ${isOverdue ? "text-destructive" : ""}`}>
                {format(new Date(invoice.dueDate), "dd MMM yyyy")}
              </p>
            </div>
          </div>

          {/* Line items */}
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="text-left p-3 font-medium">Description</th>
                  <th className="text-right p-3 font-medium">Qty</th>
                  <th className="text-right p-3 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(invoice.lineItems || []).map((item: LineItem, idx: number) => (
                  <tr key={idx} className="border-b last:border-0">
                    <td className="p-3">{item.description}</td>
                    <td className="text-right p-3">{item.quantity}</td>
                    <td className="text-right p-3">€{formatEuro(item.total)}</td>
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

          {/* Pay button */}
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
