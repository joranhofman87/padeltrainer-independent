import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTableSort } from "@/hooks/useTableSort";
import { SortableTableHead } from "@/components/admin/SortableTableHead";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InvoiceEmailDialog } from "@/components/trainer/InvoiceEmailDialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InvoiceSettingsCard } from "@/components/trainer/InvoiceSettingsCard";
import { Settings, FileText, Send, CheckCircle, Loader2, AlertCircle, Share2, Search, PlusCircle, Link2, Mail, CheckCheck } from "lucide-react";
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
  guest_player_id: string | null;
  total: number;
  status: string;
  sent_at: string | null;
  paid_at: string | null;
  forwarded_at: string | null;
  pdf_url: string | null;
  mollie_payment_url: string | null;
  mollie_payment_id: string | null;
  line_items: any;
  subtotal: number;
  vat_amount: number;
  vat_rate: number;
  public_token: string;
  prices_include_vat?: boolean;
  player_business_name?: string;
  player_address?: string;
  player_btw_number?: string;
  booking_ids?: string[] | null;
  notes?: string | null;
  trainer_id?: string | null;
}

export default function TrainerInvoices() {
  const { t, i18n } = useTranslation("trainer");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const pageTab = searchParams.get("tab") === "settings" ? "settings" : "overview";
  const [activeTab, setActiveTab] = useState("unpaid");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sendingAll, setSendingAll] = useState(false);
  const [forwardingId, setForwardingId] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; invoiceId: string; playerName: string; guestPlayerId: string | null }>({ open: false, invoiceId: '', playerName: '', guestPlayerId: null });
  const dateFnsLocale = i18n.language === "nl" ? nl : enUS;

  const formatEuro = (amount: number) =>
    amount.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Fetch trainer profile ID
  const { data: trainerProfile } = useQuery({
    queryKey: ["trainer-profile-id", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, invoice_forward_emails, invoice_prefix, invoice_next_number, invoice_include_year, business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, default_vat_rate, use_manual_invoicing, invoice_logo_url")
        .eq("user_id", user.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  const trainerId = trainerProfile?.id;

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ["trainer-invoices", trainerId],
    queryFn: async () => {
      if (!trainerId) return [];
      const { data, error } = await supabase
        .from("invoices")
        .select("*")
        .eq("trainer_id", trainerId)
        .is("academy_profile_id", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as Invoice[];
    },
    enabled: !!trainerId,
  });

  const getComputedStatus = (inv: Invoice): string => {
    if (inv.status === "paid") return "paid";
    if (inv.status === "cancelled") return "cancelled";
    if (inv.sent_at && new Date(inv.due_date) < new Date()) return "overdue";
    if (inv.sent_at) return "sent";
    if (inv.status === "draft") return "draft";
    return "open";
  };

  const unpaidInvoices = invoices.filter((i) => i.status !== "paid" && i.status !== "cancelled");
  const paidInvoices = invoices.filter((i) => i.status === "paid");
  const draftInvoices = invoices.filter((i) => !i.sent_at && i.status !== "paid" && i.status !== "cancelled");

  const tabFiltered = activeTab === "paid" ? paidInvoices : unpaidInvoices;

  const statusFiltered = statusFilter === "all"
    ? tabFiltered
    : tabFiltered.filter(i => getComputedStatus(i) === statusFilter);

  const searchFiltered = statusFiltered.filter(i =>
    !searchQuery || i.player_name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const dataWithStatus = searchFiltered.map(i => ({ ...i, _computedStatus: getComputedStatus(i) }));
  const { sortedData, sortConfig, handleSort } = useTableSort(dataWithStatus);
  const filteredInvoices = sortedData.map(({ _computedStatus, ...rest }) => rest as Invoice);

  const totalUnpaid = unpaidInvoices.reduce((sum, i) => sum + i.total, 0);

  // Send single invoice
  const sendInvoiceMutation = useMutation({
    mutationFn: async (invoice: Invoice) => {
      const { data } = await supabase.functions.invoke("send-invoice-email", {
        body: { invoiceId: invoice.id, language: i18n.language || "nl" },
      });
      if (data?.error === "no_email") {
        return { noEmail: true, invoice };
      }
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
      queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
      toast.success(result.email
        ? t("invoices.sentSuccessTo", { email: result.email })
        : t("invoices.sentSuccess"));
    },
    onError: () => {
      toast.error(t("invoices.sendError", "Verzenden mislukt"));
    },
  });

  // Bulk send
  const handleSendAllDrafts = async () => {
    setSendingAll(true);
    let sent = 0, noEmail = 0, failed = 0;
    for (const inv of draftInvoices) {
      try {
        const { data } = await supabase.functions.invoke("send-invoice-email", { body: { invoiceId: inv.id, language: i18n.language || "nl" } });
        if (data?.error === "no_email") noEmail++;
        else if (data?.success) sent++;
        else failed++;
        await supabase.from("invoices").update({ sent_at: new Date().toISOString(), status: "sent" }).eq("id", inv.id);
      } catch {
        failed++;
        await supabase.from("invoices").update({ sent_at: new Date().toISOString(), status: "sent" }).eq("id", inv.id);
      }
    }
    queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
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
    await supabase.functions.invoke("send-invoice-email", { body: { invoiceId, language: i18n.language || "nl" } });
    await supabase.from("invoices").update({ sent_at: new Date().toISOString(), status: "sent" }).eq("id", invoiceId);
    queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
    toast.success(`Factuur verzonden naar ${email}`);
  };

  const markAsSentMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase.from("invoices").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
      toast.success(t("invoices.markedAsSent", "Gemarkeerd als verstuurd"));
    },
  });

  const markPaidMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase.from("invoices").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
      toast.success(t("invoices.markedAsPaid", "Gemarkeerd als betaald"));
    },
  });

  const handleForwardInvoice = async (invoiceId: string) => {
    setForwardingId(invoiceId);
    const { error } = await supabase.functions.invoke('forward-invoice', { body: { invoiceId } });
    if (error) toast.error(t("invoices.forwardError", "Doorsturen mislukt"));
    else toast.success(t("invoices.forwardSuccess", "Factuur doorgestuurd naar boekhouder"));
    setForwardingId(null);
  };

  const deleteMutation = useMutation({
    mutationFn: async (invoice: Invoice) => {
      if (invoice.status === 'draft') {
        const { error } = await supabase.from("invoices").delete().eq("id", invoice.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("invoices").update({ status: "cancelled" }).eq("id", invoice.id);
        if (error) throw error;
      }
      return invoice;
    },
    onSuccess: (invoice) => {
      queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
      toast.success(invoice.status === 'draft'
        ? t("invoices.deleted", "Factuur verwijderd")
        : t("invoices.cancelled", "Factuur geannuleerd"));
    },
    onError: () => {
      toast.error(t("invoices.deleteError", "Kon factuur niet verwijderen"));
    },
  });

  const handleDownloadPdf = async (invoice: Invoice) => {
    try {
      const { downloadInvoicePdf } = await import('@/lib/downloadInvoicePdf');
      const ok = await downloadInvoicePdf(invoice.id, invoice.invoice_number);
      if (!ok) toast.error(t("invoices.noPdf", "Geen PDF beschikbaar"));
    } catch {
      toast.error(t("invoices.noPdf", "Geen PDF beschikbaar"));
    }
  };

  const getStatusBadge = (invoice: Invoice) => {
    if (invoice.status === "paid") {
      return <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-0"><CheckCircle className="h-3 w-3 mr-1" />{t("invoices.paid", "Betaald")}</Badge>;
    }
    if (invoice.status === "cancelled") {
      return <Badge variant="outline">{t("invoices.cancelled", "Geannuleerd")}</Badge>;
    }
    if (invoice.sent_at) {
      const isOverdue = new Date(invoice.due_date) < new Date();
      return isOverdue
        ? <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />{t("invoices.overdue", "Verlopen")}</Badge>
        : <Badge variant="secondary"><Send className="h-3 w-3 mr-1" />{t("invoices.sent", "Verstuurd")}</Badge>;
    }
    if (invoice.status === "draft") {
      return <Badge variant="outline"><FileText className="h-3 w-3 mr-1" />{t("invoices.draft", "Concept")}</Badge>;
    }
    return <Badge variant="secondary">{t("invoices.open", "Open")}</Badge>;
  };

  const getPaymentUrl = (inv: Invoice) =>
    `${window.location.origin}/pay/${inv.public_token}`;

  const ShareDropdown = ({ invoice }: { invoice: Invoice }) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost"><Share2 className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => {
          navigator.clipboard.writeText(getPaymentUrl(invoice));
          toast.success(t("invoices.shareLinkCopied", "Link gekopieerd"));
        }}>
          <Link2 className="h-4 w-4 mr-2" />
          {t("invoices.copyLink", "Link kopiëren")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => sendInvoiceMutation.mutate(invoice)}>
          <Mail className="h-4 w-4 mr-2" />
          {t("invoices.sendViaEmail", "Verstuur via e-mail")}
        </DropdownMenuItem>
        {invoice.status !== "sent" && !invoice.sent_at && (
          <DropdownMenuItem onClick={() => markAsSentMutation.mutate(invoice.id)}>
            <CheckCheck className="h-4 w-4 mr-2" />
            {t("invoices.markAsSent", "Markeer als verstuurd")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("invoices.title", "Facturen")}</h1>
        <p className="text-muted-foreground text-sm">{t("invoices.description", "Beheer je facturen")}</p>
      </div>

      <Tabs value={pageTab} onValueChange={(v) => setSearchParams(v === "settings" ? { tab: "settings" } : {})}>
        <TabsList>
          <TabsTrigger value="overview">{t("invoices.overviewTab", "Overzicht")}</TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-4 w-4 mr-1.5" />
            {t("invoices.settingsTab", "Instellingen")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6 mt-4">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("invoices.totalUnpaid", "Openstaand")}</p><p className="text-2xl font-bold">€{formatEuro(totalUnpaid)}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("invoices.unpaidCount", "Open facturen")}</p><p className="text-2xl font-bold">{unpaidInvoices.length}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("invoices.paid", "Betaald")}</p><p className="text-2xl font-bold">{paidInvoices.length}</p></CardContent></Card>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => navigate('/app/trainer/invoices/new')}>
              <PlusCircle className="h-4 w-4 mr-2" />
              {t("invoices.createInvoice", "Nieuwe factuur")}
            </Button>
          </div>

          {draftInvoices.length > 0 && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={handleSendAllDrafts} disabled={sendingAll}>
                {sendingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                {sendingAll ? t("invoices.sendingAll", "Verzenden...") : t("invoices.sendAllDrafts", "Alle concepten verzenden")} ({draftInvoices.length})
              </Button>
            </div>
          )}

          {/* Tabs + Filters */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <TabsList>
                <TabsTrigger value="unpaid">{t("invoices.unpaid", "Openstaand")} ({unpaidInvoices.length})</TabsTrigger>
                <TabsTrigger value="paid">{t("invoices.paid", "Betaald")} ({paidInvoices.length})</TabsTrigger>
              </TabsList>
              <div className="flex items-center gap-2 flex-1 flex-wrap">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue placeholder={t("invoices.allStatuses", "Alle statussen")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("invoices.allStatuses", "Alle statussen")}</SelectItem>
                    <SelectItem value="draft">{t("invoices.draft", "Concept")}</SelectItem>
                    <SelectItem value="open">{t("invoices.open", "Open")}</SelectItem>
                    <SelectItem value="sent">{t("invoices.sent", "Verstuurd")}</SelectItem>
                    <SelectItem value="overdue">{t("invoices.overdue", "Verlopen")}</SelectItem>
                    <SelectItem value="paid">{t("invoices.paid", "Betaald")}</SelectItem>
                    <SelectItem value="cancelled">{t("invoices.cancelled", "Geannuleerd")}</SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t("invoices.searchPlaceholder", "Zoek op speler...")}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 w-full sm:w-64"
                  />
                </div>
              </div>
            </div>

            <TabsContent value={activeTab} className="mt-4">
              {isLoading ? (
                <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
              ) : filteredInvoices.length === 0 ? (
                <Card><CardContent className="py-12 text-center text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-4 opacity-30" />
                  <p>{t("invoices.noInvoices", "Geen facturen gevonden")}</p>
                </CardContent></Card>
              ) : (
                <>
                  {/* Desktop Table */}
                  <div className="hidden md:block">
                    <Card>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t("invoices.number", "Nummer")}</TableHead>
                            <TableHead>{t("invoices.player", "Klant")}</TableHead>
                            <TableHead>{t("invoices.date", "Datum")}</TableHead>
                            <SortableTableHead sortKey="due_date" currentSortKey={sortConfig.key as string | null} currentDirection={sortConfig.direction} onSort={(key) => handleSort(key as any)}>
                              {t("invoices.dueDate", "Vervaldatum")}
                            </SortableTableHead>
                            <SortableTableHead sortKey="total" currentSortKey={sortConfig.key as string | null} currentDirection={sortConfig.direction} onSort={(key) => handleSort(key as any)} className="text-right">
                              {t("invoices.amount", "Bedrag")}
                            </SortableTableHead>
                            <SortableTableHead sortKey="_computedStatus" currentSortKey={sortConfig.key as string | null} currentDirection={sortConfig.direction} onSort={(key) => handleSort(key as any)}>
                              {t("invoices.status", "Status")}
                            </SortableTableHead>
                            <TableHead className="text-right">{t("invoices.actions", "Acties")}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredInvoices.map((inv) => (
                            <TableRow key={inv.id} className="cursor-pointer" onClick={() => navigate(`/app/trainer/invoices/${inv.id}/edit`)}>
                              <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                              <TableCell>{inv.player_name}</TableCell>
                              <TableCell>{format(new Date(inv.invoice_date), "dd MMM yyyy", { locale: dateFnsLocale })}</TableCell>
                              <TableCell>{format(new Date(inv.due_date), "dd MMM yyyy", { locale: dateFnsLocale })}</TableCell>
                              <TableCell className="text-right font-medium">€{formatEuro(inv.total)}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1.5">
                                  {getStatusBadge(inv)}
                                  {inv.forwarded_at && (
                                    <Tooltip><TooltipTrigger asChild><Mail className="h-3.5 w-3.5 text-muted-foreground" /></TooltipTrigger>
                                      <TooltipContent>Doorgestuurd op {format(new Date(inv.forwarded_at), "dd MMM yyyy HH:mm", { locale: dateFnsLocale })}</TooltipContent></Tooltip>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell onClick={(e) => e.stopPropagation()}>
                                <div className="flex justify-end gap-1">
                                  {inv.status !== "paid" && inv.status !== "cancelled" && <ShareDropdown invoice={inv} />}
                                  {inv.status === "paid" && (
                                    <Button size="sm" variant="ghost" onClick={() => handleForwardInvoice(inv.id)} disabled={forwardingId === inv.id}>
                                      {forwardingId === inv.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
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
                      <Card key={inv.id} className="cursor-pointer" onClick={() => navigate(`/app/trainer/invoices/${inv.id}/edit`)}>
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between mb-2">
                            <div>
                              <p className="font-mono text-sm font-medium">{inv.invoice_number}</p>
                              <p className="text-sm text-muted-foreground">{inv.player_name}</p>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {getStatusBadge(inv)}
                              {inv.forwarded_at && <Mail className="h-3.5 w-3.5 text-muted-foreground" />}
                            </div>
                          </div>
                          <div className="flex items-center justify-between text-sm mb-3">
                            <span className="text-muted-foreground">{format(new Date(inv.invoice_date), "dd MMM yyyy", { locale: dateFnsLocale })}</span>
                            <span className="font-bold text-lg">€{formatEuro(inv.total)}</span>
                          </div>
                          <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                            {inv.status !== "paid" && inv.status !== "cancelled" && <ShareDropdown invoice={inv} />}
                            {inv.status === "paid" && (
                              <Button size="sm" variant="outline" onClick={() => handleForwardInvoice(inv.id)} disabled={forwardingId === inv.id}>
                                {forwardingId === inv.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Mail className="h-4 w-4 mr-1" />}
                                {t("invoices.forwardToBookkeeper", "Doorsturen")}
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
        </TabsContent>

        <TabsContent value="settings" className="space-y-6 mt-4">
          {user?.id && trainerProfile && (
            <InvoiceSettingsCard
              userId={user.id}
              initialData={trainerProfile}
              onSave={() => queryClient.invalidateQueries({ queryKey: ["trainer-profile-id"] })}
            />
          )}
        </TabsContent>
      </Tabs>

      <InvoiceEmailDialog
        open={emailDialog.open}
        onClose={() => setEmailDialog({ open: false, invoiceId: '', playerName: '', guestPlayerId: null })}
        playerName={emailDialog.playerName}
        onSubmit={handleEmailSubmitAndSend}
      />
    </div>
  );
}
