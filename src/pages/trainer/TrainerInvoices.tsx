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
import { Checkbox } from "@/components/ui/checkbox";
import { useTableSort } from "@/hooks/useTableSort";
import { SortableTableHead } from "@/components/admin/SortableTableHead";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InvoiceEmailDialog } from "@/components/trainer/InvoiceEmailDialog";
import { BulkInvoiceEmailDialog } from "@/components/invoices/BulkInvoiceEmailDialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InvoiceSettingsCard } from "@/components/trainer/InvoiceSettingsCard";
import { ExtraCostPresetsCard } from "@/components/settings/ExtraCostPresetsCard";
import { Settings, FileText, Send, CheckCircle, Loader2, AlertCircle, Share2, PlusCircle, Link2, Mail, CheckCheck, RotateCcw, Trash2, X, CalendarIcon } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { AppPage, dataTableCardContentClass } from "@/components/ui/app-page";
import { TableToolbar } from "@/components/ui/table-toolbar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { format } from "date-fns";
import { nl, enUS } from "date-fns/locale";
import { canSharePublicPaymentLink } from "@/lib/invoiceSettingsComplete";
import { formatCurrency } from "@/lib/format";
import {
  buildTrainerInvoiceSettingsLabels,
  checkInvoiceSettingsGate,
} from "@/lib/invoiceShareGuards";

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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<null | "reset" | "delete">(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkDueOpen, setBulkDueOpen] = useState(false);
  const [bulkDueDate, setBulkDueDate] = useState<Date | undefined>(undefined);
  const dateFnsLocale = i18n.language === "nl" ? nl : enUS;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = (visible: Invoice[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = visible.length > 0 && visible.every((i) => next.has(i.id));
      if (allSelected) visible.forEach((i) => next.delete(i.id));
      else visible.forEach((i) => next.add(i.id));
      return next;
    });
  };

  // Fetch trainer profile ID
  const { data: trainerProfile } = useQuery({
    queryKey: ["trainer-profile-id", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("trainer_profiles_owner" as any)
        .select("id, invoice_forward_emails, invoice_prefix, invoice_next_number, invoice_include_year, invoice_language, business_name, business_address, kvk_number, btw_number, iban, bic, payment_terms_days, default_vat_rate, use_manual_invoicing, invoice_logo_url, invoice_banner_color, invoice_reply_to_email")
        .eq("user_id", user.id)
        .single();
      if (error) throw error;
      return data as any;
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
  const { sortedData, sortConfig, handleSort, setSortConfig } = useTableSort(dataWithStatus);

  useEffect(() => {
    if (activeTab === "paid") {
      setSortConfig({ key: "paid_at" as any, direction: "desc" });
    } else {
      setSortConfig({ key: null, direction: null });
    }
  }, [activeTab, setSortConfig]);
  const filteredInvoices = sortedData.map(({ _computedStatus, ...rest }) => rest as Invoice);

  const totalUnpaid = unpaidInvoices.reduce((sum, i) => sum + i.total, 0);

  const invoiceSettingsLabels = buildTrainerInvoiceSettingsLabels(t);

  const openInvoiceSettings = () => setSearchParams({ tab: "settings" });

  const ensureInvoiceSettingsComplete = (): boolean => {
    const gate = checkInvoiceSettingsGate(
      trainerProfile,
      invoiceSettingsLabels,
      t("invoices.settingsIncompleteWarning", "Complete your invoice settings before sending this invoice. Missing:"),
    );
    if (!gate.ok) {
      toast.error(gate.message, {
        action: {
          label: t("invoices.openInvoiceSettings", "Invoice settings"),
          onClick: openInvoiceSettings,
        },
      });
      return false;
    }
    return true;
  };

  // Send single invoice
  const sendInvoiceMutation = useMutation({
    mutationFn: async (invoice: Invoice) => {
      const { data } = await supabase.functions.invoke("send-invoice-email", {
        body: { invoiceId: invoice.id },
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
    if (!ensureInvoiceSettingsComplete()) return;
    setSendingAll(true);
    let sent = 0, noEmail = 0, failed = 0;
    for (const inv of draftInvoices) {
      try {
        const { data } = await supabase.functions.invoke("send-invoice-email", { body: { invoiceId: inv.id } });
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
    if (sent > 0) parts.push(t("invoices.bulkSent", { count: sent }));
    if (noEmail > 0) parts.push(t("invoices.bulkNoEmail", { count: noEmail }));
    if (failed > 0) parts.push(t("invoices.bulkFailed", { count: failed }));
    toast.success(t("invoices.bulkProcessed", { total: draftInvoices.length, parts: parts.join(", ") }));
    setSendingAll(false);
  };

  const handleEmailSubmitAndSend = async (email: string) => {
    const { invoiceId, guestPlayerId } = emailDialog;
    if (guestPlayerId) {
      await supabase.from("guest_players").update({ email }).eq("id", guestPlayerId);
    }
    await supabase.functions.invoke("send-invoice-email", { body: { invoiceId } });
    await supabase.from("invoices").update({ sent_at: new Date().toISOString(), status: "sent" }).eq("id", invoiceId);
    queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
    toast.success(t("invoices.sentSuccessTo", { email }));
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

  const handleForwardInvoice = async (invoiceId: string) => {
    setForwardingId(invoiceId);
    const { error } = await supabase.functions.invoke('forward-invoice', { body: { invoiceId } });
    if (error) toast.error(t("invoices.forwardError", "Doorsturen mislukt"));
    else toast.success(t("invoices.forwardSuccess", "Factuur doorgestuurd naar boekhouder"));
    setForwardingId(null);
  };

  // ========== Bulk actions ==========
  const selectedInvoices = invoices.filter((i) => selectedIds.has(i.id));

  const handleBulkReset = async () => {
    setBulkRunning(true);
    const ids = [...selectedIds];
    const { error } = await supabase
      .from("invoices")
      .update({ status: "draft", sent_at: null, paid_at: null })
      .in("id", ids);
    setBulkRunning(false);
    setConfirmBulk(null);
    if (error) {
      toast.error(t("invoices.bulk.resetError", "Kon facturen niet resetten"));
      return;
    }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
    toast.success(t("invoices.bulk.resetDone", "{{count}} facturen gereset", { count: ids.length }));
  };

  const handleBulkDelete = async () => {
    setBulkRunning(true);
    const drafts = selectedInvoices.filter((i) => i.status === "draft").map((i) => i.id);
    const others = selectedInvoices.filter((i) => i.status !== "draft").map((i) => i.id);
    let ok = 0, fail = 0;
    if (drafts.length) {
      const { error } = await supabase.from("invoices").delete().in("id", drafts);
      if (error) fail += drafts.length; else ok += drafts.length;
    }
    if (others.length) {
      const { error } = await supabase.from("invoices").update({ status: "cancelled" }).in("id", others);
      if (error) fail += others.length; else ok += others.length;
    }
    setBulkRunning(false);
    setConfirmBulk(null);
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
    if (fail > 0) toast.error(t("invoices.bulk.deletePartial", "{{ok}} verwerkt, {{fail}} mislukt", { ok, fail }));
    else toast.success(t("invoices.bulk.deleteDone", "{{count}} facturen verwijderd", { count: ok }));
  };

  const handleBulkUpdateDueDate = async () => {
    if (!bulkDueDate) return;
    setBulkRunning(true);
    const ids = [...selectedIds];
    const yyyy = bulkDueDate.getFullYear();
    const mm = String(bulkDueDate.getMonth() + 1).padStart(2, "0");
    const dd = String(bulkDueDate.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const { error } = await supabase.from("invoices").update({ due_date: dateStr }).in("id", ids);
    setBulkRunning(false);
    if (error) {
      toast.error(t("invoices.bulk.dueDateError", "Vervaldatum bijwerken mislukt"));
      return;
    }
    setBulkDueOpen(false);
    setBulkDueDate(undefined);
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
    toast.success(t("invoices.bulk.dueDateDone", "Vervaldatum bijgewerkt voor {{count}} facturen", { count: ids.length }));
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

  const ShareDropdown = ({ invoice }: { invoice: Invoice }) => {
    const shareable = canSharePublicPaymentLink(invoice);
    const isDraft = invoice.status === "draft";

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label={t("invoices.shareOptions", "Share options")}><Share2 className="h-4 w-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {shareable ? (
            <DropdownMenuItem
              onClick={() => {
                navigator.clipboard.writeText(getPaymentUrl(invoice));
                toast.success(t("invoices.shareLinkCopied", "Link gekopieerd"));
              }}
            >
              <Link2 className="h-4 w-4 mr-2" />
              {t("invoices.copyLink", "Link kopiëren")}
            </DropdownMenuItem>
          ) : isDraft ? (
            <DropdownMenuItem disabled className="text-muted-foreground max-w-[240px] whitespace-normal">
              {t(
                "invoices.draftShareHint",
                "Complete invoice settings and send this invoice before sharing a payment link.",
              )}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            onClick={() => {
              if (!ensureInvoiceSettingsComplete()) return;
              sendInvoiceMutation.mutate(invoice);
            }}
          >
            <Mail className="h-4 w-4 mr-2" />
            {t("invoices.sendViaEmail", "Verstuur via e-mail")}
          </DropdownMenuItem>
          {invoice.status !== "sent" && !invoice.sent_at && (
            <DropdownMenuItem
              onClick={() => {
                if (!ensureInvoiceSettingsComplete()) return;
                markAsSentMutation.mutate(invoice.id);
              }}
            >
              <CheckCheck className="h-4 w-4 mr-2" />
              {t("invoices.markAsSent", "Markeer als verstuurd")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <AppPage>
      <PageHeader
        title={t("invoices.title", "Facturen")}
        description={t("invoices.description", "Beheer je facturen")}
        actions={
          <>
            {draftInvoices.length > 0 && (
              <Button size="sm" variant="outline" onClick={handleSendAllDrafts} disabled={sendingAll}>
                {sendingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                {sendingAll ? t("invoices.sendingAll", "Verzenden...") : t("invoices.sendAllDrafts", "Alle concepten verzenden")} ({draftInvoices.length})
              </Button>
            )}
            <Button size="sm" onClick={() => navigate('/app/trainer/invoices/new')}>
              <PlusCircle className="h-4 w-4 mr-2" />
              {t("invoices.createInvoice", "Nieuwe factuur")}
            </Button>
          </>
        }
      />

      <Tabs value={pageTab} onValueChange={(v) => setSearchParams(v === "settings" ? { tab: "settings" } : {})}>
        <TabsList>
          <TabsTrigger value="overview">{t("invoices.overviewTab", "Overzicht")}</TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-4 w-4 mr-1.5" />
            {t("invoices.settingsTab", "Instellingen")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">
          {/* Bulk Selection Action Bar */}
          {selectedIds.size > 0 && (
            <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 shadow-sm">
              <span className="text-sm font-medium">
                {t("invoices.bulk.selected", "{{count}} geselecteerd", { count: selectedIds.size })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                <X className="h-4 w-4 mr-1" />
                {t("invoices.bulk.clear", "Wissen")}
              </Button>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setBulkEmailOpen(true)}>
                  <Mail className="h-4 w-4 mr-1.5" />
                  {t("invoices.bulk.sendEmail", "Verstuur e-mail")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmBulk("reset")}>
                  <RotateCcw className="h-4 w-4 mr-1.5" />
                  {t("invoices.bulk.resetToDraft", "Reset naar concept")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setBulkDueOpen(true)}>
                  <CalendarIcon className="h-4 w-4 mr-1.5" />
                  {t("invoices.bulk.updateDueDate", "Vervaldatum wijzigen")}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setConfirmBulk("delete")}>
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  {t("invoices.bulk.delete", "Verwijder")}
                </Button>
              </div>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("invoices.totalUnpaid", "Openstaand")}</p><p className="font-display text-2xl font-semibold tabular-nums">{formatCurrency(totalUnpaid)}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("invoices.unpaidCount", "Open facturen")}</p><p className="font-display text-2xl font-semibold tabular-nums">{unpaidInvoices.length}</p></CardContent></Card>
            <Card><CardContent className="p-4"><p className="text-sm text-muted-foreground">{t("invoices.paid", "Betaald")}</p><p className="font-display text-2xl font-semibold tabular-nums">{paidInvoices.length}</p></CardContent></Card>
          </div>

          {/* Tabs + Filters */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-3">
            <TabsList>
              <TabsTrigger value="unpaid">{t("invoices.unpaid", "Openstaand")} ({unpaidInvoices.length})</TabsTrigger>
              <TabsTrigger value="paid">{t("invoices.paid", "Betaald")} ({paidInvoices.length})</TabsTrigger>
            </TabsList>
            <TableToolbar
              searchPlaceholder={t("invoices.searchPlaceholder", "Zoek op speler...")}
              searchValue={searchQuery}
              onSearchChange={setSearchQuery}
            >
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[160px]">
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
            </TableToolbar>

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
                      <CardContent className={dataTableCardContentClass}>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-10">
                              <Checkbox
                                checked={filteredInvoices.length > 0 && filteredInvoices.every((i) => selectedIds.has(i.id))}
                                onCheckedChange={() => toggleSelectAllVisible(filteredInvoices)}
                                aria-label="Select all"
                              />
                            </TableHead>
                            <TableHead>{t("invoices.number", "Nummer")}</TableHead>
                            <TableHead>{t("invoices.player", "Klant")}</TableHead>
                            <TableHead>{t("invoices.date", "Datum")}</TableHead>
                            {activeTab === "paid" ? (
                              <SortableTableHead sortKey="paid_at" currentSortKey={sortConfig.key as string | null} currentDirection={sortConfig.direction} onSort={(key) => handleSort(key as any)}>
                                {t("invoices.paymentDate", "Betaaldatum")}
                              </SortableTableHead>
                            ) : (
                              <SortableTableHead sortKey="due_date" currentSortKey={sortConfig.key as string | null} currentDirection={sortConfig.direction} onSort={(key) => handleSort(key as any)}>
                                {t("invoices.dueDate", "Vervaldatum")}
                              </SortableTableHead>
                            )}
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
                              <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                  checked={selectedIds.has(inv.id)}
                                  onCheckedChange={() => toggleSelect(inv.id)}
                                  aria-label={`Select ${inv.invoice_number}`}
                                />
                              </TableCell>
                              <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                              <TableCell>{inv.player_name}</TableCell>
                              <TableCell>{format(new Date(inv.invoice_date), "dd MMM yyyy", { locale: dateFnsLocale })}</TableCell>
                              <TableCell>{activeTab === "paid" ? (inv.paid_at ? format(new Date(inv.paid_at), "dd MMM yyyy", { locale: dateFnsLocale }) : "-") : format(new Date(inv.due_date), "dd MMM yyyy", { locale: dateFnsLocale })}</TableCell>
                              <TableCell className="text-right font-medium">{formatCurrency(inv.total)}</TableCell>
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
                      </CardContent>
                    </Card>
                  </div>

                  {/* Mobile Cards */}
                  <div className="md:hidden space-y-3">
                    {filteredInvoices.map((inv) => (
                      <Card key={inv.id} className="cursor-pointer" onClick={() => navigate(`/app/trainer/invoices/${inv.id}/edit`)}>
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between mb-2 gap-2">
                            <div className="flex items-start gap-2 min-w-0">
                              <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
                                <Checkbox
                                  checked={selectedIds.has(inv.id)}
                                  onCheckedChange={() => toggleSelect(inv.id)}
                                  aria-label={`Select ${inv.invoice_number}`}
                                />
                              </div>
                              <div className="min-w-0">
                                <p className="font-mono text-sm font-medium truncate">{inv.invoice_number}</p>
                                <p className="text-sm text-muted-foreground truncate">{inv.player_name}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {getStatusBadge(inv)}
                              {inv.forwarded_at && <Mail className="h-3.5 w-3.5 text-muted-foreground" />}
                            </div>
                          </div>
                          <div className="flex items-center justify-between text-sm mb-3">
                            <span className="text-muted-foreground">
                              {activeTab === "paid" && inv.paid_at
                                ? `${t("invoices.paymentDate", "Betaaldatum")}: ${format(new Date(inv.paid_at), "dd MMM yyyy", { locale: dateFnsLocale })}`
                                : format(new Date(inv.invoice_date), "dd MMM yyyy", { locale: dateFnsLocale })}
                            </span>
                            <span className="font-bold text-lg">{formatCurrency(inv.total)}</span>
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
          {trainerId && (
            <ExtraCostPresetsCard trainerId={trainerId} />
          )}
        </TabsContent>
      </Tabs>

      <InvoiceEmailDialog
        open={emailDialog.open}
        onClose={() => setEmailDialog({ open: false, invoiceId: '', playerName: '', guestPlayerId: null })}
        playerName={emailDialog.playerName}
        onSubmit={handleEmailSubmitAndSend}
      />

      <BulkInvoiceEmailDialog
        open={bulkEmailOpen}
        onClose={() => setBulkEmailOpen(false)}
        invoiceIds={[...selectedIds]}
        language={i18n.language || "nl"}
        onSent={() => {
          setSelectedIds(new Set());
          queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
        }}
      />

      <Dialog open={bulkDueOpen} onOpenChange={(o) => !bulkRunning && setBulkDueOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("invoices.bulk.updateDueDateTitle", "Vervaldatum wijzigen")}</DialogTitle>
            <DialogDescription>
              {t("invoices.bulk.updateDueDateDesc", "Stel een nieuwe vervaldatum in voor {{count}} geselecteerde factu(u)r(en).", { count: selectedIds.size })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn("w-full justify-start text-left font-normal", !bulkDueDate && "text-muted-foreground")}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {bulkDueDate ? format(bulkDueDate, "dd MMM yyyy", { locale: dateFnsLocale }) : t("invoices.bulk.pickDate", "Kies een datum")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={bulkDueDate} onSelect={setBulkDueDate} initialFocus className={cn("p-3 pointer-events-auto")} />
              </PopoverContent>
            </Popover>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDueOpen(false)} disabled={bulkRunning}>
              {t("common.cancel", "Annuleren")}
            </Button>
            <Button onClick={handleBulkUpdateDueDate} disabled={!bulkDueDate || bulkRunning}>
              {bulkRunning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("common.save", "Opslaan")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmBulk !== null} onOpenChange={(o) => !o && !bulkRunning && setConfirmBulk(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmBulk === "reset"
                ? t("invoices.bulk.confirmResetTitle", "{{count}} facturen resetten naar concept?", { count: selectedIds.size })
                : t("invoices.bulk.confirmDeleteTitle", "{{count}} facturen verwijderen?", { count: selectedIds.size })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmBulk === "reset"
                ? t("invoices.bulk.confirmResetDesc", "Status, verzenddatum en betaaldatum worden gewist. Dit kan niet ongedaan worden gemaakt.")
                : t("invoices.bulk.confirmDeleteDesc", "Concepten worden definitief verwijderd. Verstuurde facturen worden geannuleerd.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkRunning}>{t("common.cancel", "Annuleren")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirmBulk === "reset") handleBulkReset();
                else if (confirmBulk === "delete") handleBulkDelete();
              }}
              disabled={bulkRunning}
            >
              {bulkRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {t("common.confirm", "Bevestigen")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppPage>
  );
}
