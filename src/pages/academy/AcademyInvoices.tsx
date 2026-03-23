import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Settings, FileText, Send, CheckCircle, Link as LinkIcon, Download, Copy, Loader2, AlertCircle, Share2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { nl, enUS } from "date-fns/locale";

interface Invoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  player_name: string;
  player_id: string | null;
  total: number;
  status: string;
  sent_at: string | null;
  paid_at: string | null;
  pdf_url: string | null;
  mollie_payment_url: string | null;
  mollie_payment_id: string | null;
  line_items: any;
  subtotal: number;
  vat_amount: number;
  vat_rate: number;
  public_token: string;
}

export default function AcademyInvoices() {
  const { t, i18n } = useTranslation("academy");
  const { activeAcademy } = useAcademyContext();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("all");
  const dateFnsLocale = i18n.language === "nl" ? nl : enUS;

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["academy-invoices", activeAcademy?.id],
    queryFn: async () => {
      if (!activeAcademy?.id) return [];
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .eq("academy_profile_id", activeAcademy.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as Invoice[];
    },
    enabled: !!activeAcademy?.id,
  });

  // Backfill mutation
  const backfillMutation = useMutation({
    mutationFn: async () => {
      if (!activeAcademy?.id) throw new Error("No academy");
      const { data, error } = await supabase.functions.invoke("backfill-invoices", {
        body: { academyProfileId: activeAcademy.id },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
      if (data?.created > 0) {
        toast.success(t("invoices.backfillSuccess", "{{count}} draft invoices created", { count: data.created }));
      } else {
        toast.info(t("invoices.backfillNone", "All bookings are already invoiced"));
      }
    },
    onError: () => {
      toast.error(t("invoices.backfillError", "Failed to generate invoices"));
    },
  });

  const draftInvoices = invoices.filter((i) => !i.sent_at && i.status !== "paid");
  const sentInvoices = invoices.filter((i) => i.sent_at && i.status !== "paid");
  const paidInvoices = invoices.filter((i) => i.status === "paid");

  const filteredInvoices =
    activeTab === "draft" ? draftInvoices :
    activeTab === "sent" ? sentInvoices :
    activeTab === "paid" ? paidInvoices :
    invoices;

  const totalUnpaid = sentInvoices.reduce((sum, i) => sum + i.total, 0) + draftInvoices.reduce((sum, i) => sum + i.total, 0);

  // Mark as sent mutation
  const markSentMutation = useMutation({
    mutationFn: async (invoiceIds: string[]) => {
      const { error } = await supabase
        .from("invoices")
        .update({ sent_at: new Date().toISOString(), status: "sent" })
        .in("id", invoiceIds);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
      toast.success(t("invoices.markedAsSent", "Invoices marked as sent"));
    },
  });

  // Mark as paid mutation
  const markPaidMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase
        .from("invoices")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
      toast.success(t("invoices.markedAsPaid", "Invoice marked as paid"));
    },
  });

  // Generate payment link
  const generateLinkMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const { data, error } = await supabase.functions.invoke("create-invoice-payment", {
        body: { invoiceId },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
      if (data?.paymentUrl) {
        navigator.clipboard.writeText(data.paymentUrl);
        toast.success(t("invoices.linkCopied", "Payment link copied to clipboard"));
      }
    },
    onError: (err) => {
      toast.error(t("invoices.linkError", "Failed to generate payment link"));
    },
  });

  const handleDownloadPdf = async (invoice: Invoice) => {
    if (!invoice.pdf_url) {
      toast.error(t("invoices.noPdf", "No PDF available"));
      return;
    }
    const { data } = await supabase.storage.from("invoices").createSignedUrl(invoice.pdf_url, 60);
    if (data?.signedUrl) {
      window.open(data.signedUrl, "_blank");
    }
  };

  const getStatusBadge = (invoice: Invoice) => {
    if (invoice.status === "paid") {
      return <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-0"><CheckCircle className="h-3 w-3 mr-1" />{t("invoices.paid", "Paid")}</Badge>;
    }
    if (invoice.sent_at) {
      const isOverdue = new Date(invoice.due_date) < new Date();
      return isOverdue
        ? <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />{t("invoices.overdue", "Overdue")}</Badge>
        : <Badge variant="secondary"><Send className="h-3 w-3 mr-1" />{t("invoices.sent", "Sent")}</Badge>;
    }
    return <Badge variant="outline"><FileText className="h-3 w-3 mr-1" />{t("invoices.draft", "Draft")}</Badge>;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t("invoices.title", "Invoices")}</h1>
          <p className="text-muted-foreground text-sm">
            {t("invoices.description", "Manage invoices for your academy")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
          >
            {backfillMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <FileText className="h-4 w-4 mr-2" />
            )}
            {backfillMutation.isPending
              ? t("invoices.generating", "Generating...")
              : t("invoices.generateMissing", "Generate missing invoices")}
          </Button>
          <Link to="/app/academy/settings">
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-2" />
              {t("invoices.editSettings", "Invoice Settings")}
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{t("invoices.totalUnpaid", "Unpaid")}</p>
            <p className="text-2xl font-bold">€{totalUnpaid.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{t("invoices.draft", "Draft")}</p>
            <p className="text-2xl font-bold">{draftInvoices.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{t("invoices.sent", "Sent")}</p>
            <p className="text-2xl font-bold">{sentInvoices.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{t("invoices.paid", "Paid")}</p>
            <p className="text-2xl font-bold">{paidInvoices.length}</p>
          </CardContent>
        </Card>
      </div>

      {/* Bulk Actions */}
      {draftInvoices.length > 0 && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => markSentMutation.mutate(draftInvoices.map((i) => i.id))}
            disabled={markSentMutation.isPending}
          >
            <Send className="h-4 w-4 mr-2" />
            {t("invoices.sendAllDrafts", "Send all drafts")} ({draftInvoices.length})
          </Button>
        </div>
      )}

      {/* Tabs + Table */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all">{t("invoices.all", "All")} ({invoices.length})</TabsTrigger>
          <TabsTrigger value="draft">{t("invoices.draft", "Draft")} ({draftInvoices.length})</TabsTrigger>
          <TabsTrigger value="sent">{t("invoices.sentOverdue", "Sent / Overdue")} ({sentInvoices.length})</TabsTrigger>
          <TabsTrigger value="paid">{t("invoices.paid", "Paid")} ({paidInvoices.length})</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="mt-4">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : filteredInvoices.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-4 opacity-30" />
                <p>{t("invoices.noInvoices", "No invoices found")}</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Desktop Table */}
              <div className="hidden md:block">
                <Card>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("invoices.number", "Number")}</TableHead>
                        <TableHead>{t("invoices.player", "Player")}</TableHead>
                        <TableHead>{t("invoices.date", "Date")}</TableHead>
                        <TableHead>{t("invoices.dueDate", "Due")}</TableHead>
                        <TableHead className="text-right">{t("invoices.amount", "Amount")}</TableHead>
                        <TableHead>{t("invoices.status", "Status")}</TableHead>
                        <TableHead className="text-right">{t("invoices.actions", "Actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredInvoices.map((inv) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                          <TableCell>{inv.player_name}</TableCell>
                          <TableCell>{format(new Date(inv.invoice_date), "dd MMM yyyy", { locale: dateFnsLocale })}</TableCell>
                          <TableCell>{format(new Date(inv.due_date), "dd MMM yyyy", { locale: dateFnsLocale })}</TableCell>
                          <TableCell className="text-right font-medium">€{inv.total.toFixed(2)}</TableCell>
                          <TableCell>{getStatusBadge(inv)}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              {inv.status !== "paid" && (
                                <>
                                  {/* Share public invoice link */}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      const url = `${window.location.origin}/pay/${inv.public_token}`;
                                      navigator.clipboard.writeText(url);
                                      toast.success(t("invoices.shareLinkCopied", "Invoice link copied"));
                                    }}
                                    title={t("invoices.shareLink", "Share invoice link")}
                                  >
                                    <Share2 className="h-4 w-4" />
                                  </Button>
                                  {/* Generate Mollie payment link */}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => generateLinkMutation.mutate(inv.id)}
                                    disabled={generateLinkMutation.isPending}
                                    title={t("invoices.generateLink", "Payment link")}
                                  >
                                    <LinkIcon className="h-4 w-4" />
                                  </Button>
                                  {!inv.sent_at && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => markSentMutation.mutate([inv.id])}
                                      disabled={markSentMutation.isPending}
                                    >
                                      <Send className="h-4 w-4" />
                                    </Button>
                                  )}
                                  {inv.sent_at && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => markPaidMutation.mutate(inv.id)}
                                      disabled={markPaidMutation.isPending}
                                      title={t("invoices.markPaid", "Mark paid")}
                                    >
                                      <CheckCircle className="h-4 w-4" />
                                    </Button>
                                  )}
                                </>
                              )}
                              {inv.pdf_url && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleDownloadPdf(inv)}
                                  title={t("invoices.downloadPdf", "Download PDF")}
                                >
                                  <Download className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </div>

              {/* Mobile Cards */}
              <div className="md:hidden space-y-3">
                {filteredInvoices.map((inv) => (
                  <Card key={inv.id}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="font-mono text-sm font-medium">{inv.invoice_number}</p>
                          <p className="text-sm text-muted-foreground">{inv.player_name}</p>
                        </div>
                        {getStatusBadge(inv)}
                      </div>
                      <div className="flex items-center justify-between text-sm mb-3">
                        <span className="text-muted-foreground">
                          {format(new Date(inv.invoice_date), "dd MMM yyyy", { locale: dateFnsLocale })}
                        </span>
                        <span className="font-bold text-lg">€{inv.total.toFixed(2)}</span>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        {!inv.sent_at && inv.status !== "paid" && (
                          <Button size="sm" variant="outline" onClick={() => markSentMutation.mutate([inv.id])}>
                            <Send className="h-4 w-4 mr-1" />{t("invoices.send", "Send")}
                          </Button>
                        )}
                        {inv.sent_at && inv.status !== "paid" && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => generateLinkMutation.mutate(inv.id)} disabled={generateLinkMutation.isPending}>
                              <LinkIcon className="h-4 w-4 mr-1" />{t("invoices.paymentLink", "Payment link")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => markPaidMutation.mutate(inv.id)}>
                              <CheckCircle className="h-4 w-4 mr-1" />{t("invoices.markPaid", "Mark paid")}
                            </Button>
                          </>
                        )}
                        {inv.pdf_url && (
                          <Button size="sm" variant="ghost" onClick={() => handleDownloadPdf(inv)}>
                            <Download className="h-4 w-4 mr-1" />PDF
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
