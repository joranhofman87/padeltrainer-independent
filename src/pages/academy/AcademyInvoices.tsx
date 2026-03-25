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
import { Input } from "@/components/ui/input";
import { InvoiceEmailDialog } from "@/components/trainer/InvoiceEmailDialog";
import { Settings, FileText, Send, CheckCircle, Download, Loader2, AlertCircle, Share2, Search, Pencil, Mail } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { EditInvoiceDialog } from "@/components/invoices/EditInvoiceDialog";
import { nl, enUS } from "date-fns/locale";

interface Invoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  player_name: string;
  player_id: string | null;
  guest_player_id: string | null;
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
  const [searchQuery, setSearchQuery] = useState("");
  const [sendingAll, setSendingAll] = useState(false);
  const [forwardingId, setForwardingId] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; invoiceId: string; playerName: string; guestPlayerId: string | null }>({ open: false, invoiceId: '', playerName: '', guestPlayerId: null });
  const [editInvoice, setEditInvoice] = useState<Invoice | null>(null);
  const dateFnsLocale = i18n.language === "nl" ? nl : enUS;

  const formatEuro = (amount: number) =>
    amount.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  const tabFiltered =
    activeTab === "draft" ? draftInvoices :
    activeTab === "sent" ? sentInvoices :
    activeTab === "paid" ? paidInvoices :
    invoices;

  const filteredInvoices = tabFiltered.filter(i =>
    !searchQuery || i.player_name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalUnpaid = sentInvoices.reduce((sum, i) => sum + i.total, 0) + draftInvoices.reduce((sum, i) => sum + i.total, 0);

  // Send single invoice (with email)
  const sendInvoiceMutation = useMutation({
    mutationFn: async (invoice: Invoice) => {
      // Try sending email
      const { data } = await supabase.functions.invoke("send-invoice-email", {
        body: { invoiceId: invoice.id },
      });

      if (data?.error === "no_email") {
        // Return special marker so onSuccess can handle the dialog
        return { noEmail: true, invoice };
      }

      // Mark as sent
      const { error } = await supabase
        .from("invoices")
        .update({ sent_at: new Date().toISOString(), status: "sent" })
        .eq("id", invoice.id);
      if (error) throw error;

      return { noEmail: false, email: data?.email };
    },
    onSuccess: (result) => {
      if (result.noEmail && result.invoice) {
        setEmailDialog({
          open: true,
          invoiceId: result.invoice.id,
          playerName: result.invoice.player_name,
          guestPlayerId: result.invoice.guest_player_id,
        });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
      const emailMsg = result.email ? ` naar ${result.email}` : "";
      toast.success(t("invoices.sentSuccess", `Invoice sent${emailMsg}`));
    },
    onError: () => {
      toast.error(t("invoices.sendError", "Failed to send invoice"));
    },
  });

  // Bulk send all drafts
  const handleSendAllDrafts = async () => {
    setSendingAll(true);
    let sent = 0;
    let noEmail = 0;
    let failed = 0;

    for (const inv of draftInvoices) {
      try {
        const { data } = await supabase.functions.invoke("send-invoice-email", {
          body: { invoiceId: inv.id },
        });

        if (data?.error === "no_email") {
          noEmail++;
        } else if (data?.success) {
          sent++;
        } else {
          failed++;
        }

        // Mark as sent regardless
        await supabase
          .from("invoices")
          .update({ sent_at: new Date().toISOString(), status: "sent" })
          .eq("id", inv.id);
      } catch {
        failed++;
        // Still mark as sent
        await supabase
          .from("invoices")
          .update({ sent_at: new Date().toISOString(), status: "sent" })
          .eq("id", inv.id);
      }
    }

    queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
    
    const parts = [];
    if (sent > 0) parts.push(`${sent} verzonden`);
    if (noEmail > 0) parts.push(`${noEmail} zonder e-mail`);
    if (failed > 0) parts.push(`${failed} mislukt`);
    toast.success(`${draftInvoices.length} facturen verwerkt: ${parts.join(", ")}`);
    
    setSendingAll(false);
  };

  const handleEmailSubmitAndSend = async (email: string) => {
    const { invoiceId, guestPlayerId } = emailDialog;

    if (guestPlayerId) {
      await supabase.from("guest_players").update({ email }).eq("id", guestPlayerId);
    }

    // Retry sending email
    await supabase.functions.invoke("send-invoice-email", {
      body: { invoiceId },
    });

    // Mark as sent
    await supabase.from("invoices").update({ 
      sent_at: new Date().toISOString(), 
      status: "sent" 
    }).eq("id", invoiceId);

    queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
    toast.success(`Factuur verzonden naar ${email}`);
  };

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

  const handleForwardInvoice = async (invoiceId: string) => {
    setForwardingId(invoiceId);
    const { error } = await supabase.functions.invoke('forward-invoice', {
      body: { invoiceId },
    });
    if (error) {
      toast.error(t("invoices.forwardError", "Failed to forward invoice"));
    } else {
      toast.success(t("invoices.forwardSuccess", "Invoice forwarded to bookkeeper"));
    }
    setForwardingId(null);
  };

  const handleDownloadPdf = async (invoice: Invoice) => {
    try {
      const { data, error } = await supabase.functions.invoke('generate-invoice', {
        body: { invoiceId: invoice.id },
      });
      if (error || !data?.html) {
        toast.error(t("invoices.noPdf", "No PDF available"));
        return;
      }
      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(data.html);
        printWindow.document.close();
        printWindow.onload = () => printWindow.print();
      }
    } catch {
      toast.error(t("invoices.noPdf", "No PDF available"));
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
    <div className="container mx-auto px-4 py-6 space-y-6">
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
            <p className="text-2xl font-bold">€{formatEuro(totalUnpaid)}</p>
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
            onClick={handleSendAllDrafts}
            disabled={sendingAll}
          >
            {sendingAll ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            {sendingAll 
              ? t("invoices.sendingAll", "Sending...")
              : t("invoices.sendAllDrafts", "Send all drafts")} ({draftInvoices.length})
          </Button>
        </div>
      )}

      {/* Tabs + Table */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <TabsList>
            <TabsTrigger value="all">{t("invoices.all", "All")} ({invoices.length})</TabsTrigger>
          <TabsTrigger value="draft">{t("invoices.draft", "Draft")} ({draftInvoices.length})</TabsTrigger>
          <TabsTrigger value="sent">{t("invoices.sentOverdue", "Sent / Overdue")} ({sentInvoices.length})</TabsTrigger>
            <TabsTrigger value="paid">{t("invoices.paid", "Paid")} ({paidInvoices.length})</TabsTrigger>
          </TabsList>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("invoices.searchPlaceholder", "Search player name...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-64"
            />
          </div>
        </div>

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
                          <TableCell className="text-right font-medium">€{formatEuro(inv.total)}</TableCell>
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
                                      const url = `${window.location.origin}/nl/academies/${activeAcademy?.slug}/pay/${inv.public_token}`;
                                      navigator.clipboard.writeText(url);
                                      toast.success(t("invoices.shareLinkCopied", "Invoice link copied"));
                                    }}
                                    title={t("invoices.shareLink", "Share invoice link")}
                                  >
                                    <Share2 className="h-4 w-4" />
                                  </Button>
                                  {!inv.sent_at && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => sendInvoiceMutation.mutate(inv)}
                                      disabled={sendInvoiceMutation.isPending}
                                    >
                                      <Send className="h-4 w-4" />
                                    </Button>
                                  )}
                                   <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => markPaidMutation.mutate(inv.id)}
                                    disabled={markPaidMutation.isPending}
                                    title={t("invoices.markPaid", "Mark paid")}
                                  >
                                    <CheckCircle className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setEditInvoice(inv)}
                                    title={t("invoices.edit", "Edit")}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                </>
                              )}
                              {inv.status === "paid" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleForwardInvoice(inv.id)}
                                  disabled={forwardingId === inv.id}
                                  title={t("invoices.forwardToBookkeeper", "Forward to bookkeeper")}
                                >
                                  {forwardingId === inv.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Mail className="h-4 w-4" />
                                  )}
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDownloadPdf(inv)}
                                title={t("invoices.downloadPdf", "Download PDF")}
                              >
                                <Download className="h-4 w-4" />
                              </Button>
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
                        <span className="font-bold text-lg">€{formatEuro(inv.total)}</span>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        {inv.status !== "paid" && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => {
                              const url = `${window.location.origin}/nl/academies/${activeAcademy?.slug}/pay/${inv.public_token}`;
                              navigator.clipboard.writeText(url);
                              toast.success(t("invoices.shareLinkCopied", "Invoice link copied"));
                            }}>
                              <Share2 className="h-4 w-4 mr-1" />{t("invoices.shareLink", "Share")}
                            </Button>
                            {!inv.sent_at && (
                              <Button size="sm" variant="outline" onClick={() => sendInvoiceMutation.mutate(inv)}>
                                <Send className="h-4 w-4 mr-1" />{t("invoices.send", "Send")}
                              </Button>
                            )}
                            <Button size="sm" variant="outline" onClick={() => markPaidMutation.mutate(inv.id)}>
                              <CheckCircle className="h-4 w-4 mr-1" />{t("invoices.markPaid", "Mark paid")}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => setEditInvoice(inv)}>
                              <Pencil className="h-4 w-4 mr-1" />{t("invoices.edit", "Edit")}
                            </Button>
                          </>
                        )}
                        {inv.status === "paid" && (
                          <Button size="sm" variant="outline" onClick={() => handleForwardInvoice(inv.id)} disabled={forwardingId === inv.id}>
                            {forwardingId === inv.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Mail className="h-4 w-4 mr-1" />}
                            {t("invoices.forwardToBookkeeper", "Forward")}
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => handleDownloadPdf(inv)}>
                          <Download className="h-4 w-4 mr-1" />PDF
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>

      <InvoiceEmailDialog
        open={emailDialog.open}
        onClose={() => setEmailDialog({ open: false, invoiceId: '', playerName: '', guestPlayerId: null })}
        playerName={emailDialog.playerName}
        onSubmit={handleEmailSubmitAndSend}
      />

      <EditInvoiceDialog
        open={!!editInvoice}
        onClose={() => setEditInvoice(null)}
        invoice={editInvoice}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ["academy-invoices"] })}
        academyProfileId={activeAcademy?.id}
      />
    </div>
  );
}
