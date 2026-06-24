import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  INVOICE_PAGE_SIZE,
  invoiceListPageCount,
  useTrainerInvoices,
  useTrainerInvoiceSummary,
  useTrainerInvoiceDeliverySummary,
  fetchAllTrainerInvoices,
  type TrainerInvoiceRow,
} from "@/lib/invoicesList";
import { useInvoiceListSort } from "@/components/invoices/useInvoiceListSort";
import { useInvoiceListSelection } from "@/components/invoices/useInvoiceListSelection";
import { ListPagination } from "@/components/ui/list-pagination";
import { InvoiceDeliveryChip } from "@/components/email/InvoiceDeliveryChip";
import { InvoiceListStatusBadge } from "@/components/invoices/InvoiceListStatusBadge";
import { InvoiceStatTiles } from "@/components/invoices/InvoiceStatTiles";
import { InvoiceListTable } from "@/components/invoices/InvoiceListTable";
import { InvoiceEmailDialog } from "@/components/trainer/InvoiceEmailDialog";
import { BulkInvoiceEmailDialog } from "@/components/invoices/BulkInvoiceEmailDialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InvoiceSettingsCard } from "@/components/trainer/InvoiceSettingsCard";
import { ExtraCostPresetsCard } from "@/components/settings/ExtraCostPresetsCard";
import { Settings, FileText, Send, Loader2, Share2, PlusCircle, Link2, Mail, CheckCheck, RotateCcw, Trash2, X, CalendarIcon, MailWarning } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { AppPage } from "@/components/ui/app-page";
import { TableToolbar } from "@/components/ui/table-toolbar";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { format } from "date-fns";
import { nl, enUS } from "date-fns/locale";
import { canSharePublicPaymentLink } from "@/lib/invoiceSettingsComplete";
import { formatCurrency } from "@/lib/format";
import { invalidateAllPlayerData } from "@/lib/playerQueryKeys";
import {
  buildTrainerInvoiceSettingsLabels,
  checkInvoiceSettingsGate,
} from "@/lib/invoiceShareGuards";

// The visible rows are now the server-paginated RPC rows. Aliasing keeps every
// existing (inv: Invoice) signature valid against the new row shape.
type Invoice = TrainerInvoiceRow;

export default function TrainerInvoices() {
  const { t, i18n } = useTranslation("trainer");
  // Email-delivery copy + the InvoiceDeliveryChip live in the shared 'academy'
  // namespace (single source of truth — see InvoiceDeliveryChip).
  const { t: tDelivery } = useTranslation("academy");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const pageTab = searchParams.get("tab") === "settings" ? "settings" : "overview";
  const [activeTab, setActiveTab] = useState("unpaid");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [deliveryFilter, setDeliveryFilter] = useState<string>("all");
  const [sendingAll, setSendingAll] = useState(false);
  const [forwardingId, setForwardingId] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; invoiceId: string; playerName: string; guestPlayerId: string | null }>({ open: false, invoiceId: '', playerName: '', guestPlayerId: null });
  const [sendingInvoiceIds, setSendingInvoiceIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<null | "reset" | "delete">(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkDueOpen, setBulkDueOpen] = useState(false);
  const [bulkDueDate, setBulkDueDate] = useState<Date | undefined>(undefined);
  const [page, setPage] = useState(0);
  const dateFnsLocale = i18n.language === "nl" ? nl : enUS;

  // Server-side ILIKE search: debounce the input before it hits the RPC.
  const debouncedSearch = useDebouncedValue(searchQuery, 300);

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

  /** Refresh invoices + all player views (overdue flag, guest email edits). */
  const invalidateInvoicesAndPlayers = () => {
    queryClient.invalidateQueries({ queryKey: ["trainer-invoices"] });
    if (trainerId) {
      invalidateAllPlayerData(queryClient, { kind: "trainer", id: trainerId });
    }
  };

  // Shared header-sort wiring: the useTableSort affordance + paid-tab default sort
  // + the header-key → RPC sort/sortDir mapping (rows come from the server page).
  const { sortConfig, handleSort, sort, sortDir } = useInvoiceListSort(activeTab);

  const tab: "unpaid" | "paid" = activeTab === "paid" ? "paid" : "unpaid";

  const { data: overview, isLoading } = useTrainerInvoices(trainerId, {
    tab,
    status: statusFilter === "all" ? null : statusFilter,
    search: debouncedSearch || null,
    delivery: deliveryFilter === "all" ? null : deliveryFilter,
    sort,
    sortDir,
    page,
    pageSize: INVOICE_PAGE_SIZE,
  });

  // Delivery breakdown for the current tab (drives the "never reached" banner).
  const { data: deliverySummary } = useTrainerInvoiceDeliverySummary(trainerId, { tab });
  const invoiceHasEmail = (inv: Invoice) => inv.linked_email != null;

  // Scoreboard reads from the summary RPC (always one row) so the tiles + tab
  // labels stay correct even when the current tab/page is empty. The trainer
  // page has no trainer/location sub-filters, so the summary has no scope.
  const { data: summary } = useTrainerInvoiceSummary(trainerId);
  const sumUnpaid = summary?.sumUnpaid ?? 0;
  const countUnpaid = summary?.countUnpaid ?? 0;
  const countPaid = summary?.countPaid ?? 0;
  const countDraft = summary?.countDraft ?? 0;

  // VISIBLE LIST = the server page rows only. No client-side re-filter/re-sort.
  const filteredInvoices = overview?.rows ?? [];

  // Shared page-scoped selection (toggle / select-all-visible / selectedInvoices).
  const { selectedIds, setSelectedIds, toggleSelect, toggleSelectAllVisible, selectedInvoices } =
    useInvoiceListSelection(filteredInvoices);

  const totalUnpaid = sumUnpaid;

  const pageCount = invoiceListPageCount(overview?.total ?? 0);

  // Keep the page in range if the result set shrinks (e.g. after a bulk delete).
  useEffect(() => {
    setPage((p) => Math.min(Math.max(0, p), pageCount - 1));
  }, [pageCount]);

  // Reset to the first page whenever any list-shaping input changes.
  useEffect(() => {
    setPage(0);
  }, [activeTab, statusFilter, deliveryFilter, debouncedSearch, sort, sortDir]);

  // Selection is page-scoped: clear it on any filter/tab/page change so the
  // page-scoped selectedInvoices (rows on the current page) is always safe.
  // (setSelectedIds is a stable setter; listed only to satisfy exhaustive-deps.)
  useEffect(() => {
    setSelectedIds(new Set());
  }, [activeTab, statusFilter, deliveryFilter, debouncedSearch, sort, sortDir, page, setSelectedIds]);

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

  // Map a known send-failure reason from the send-invoice-email function to
  // actionable copy for the failure toast description.
  const describeSendError = (reason?: string) =>
    reason === "email_not_configured"
      ? t("invoices.sendErrorNotConfigured", "Email sending is not configured yet — contact support.")
      : t("invoices.sendErrorWithHint", "Failed to send the invoice. Check the recipient email and try again.");

  // Send single invoice
  type SendInvoiceResult = { noEmail: boolean; skipped?: boolean; email?: string; invoice?: Invoice };
  const sendInvoiceMutation = useMutation({
    mutationFn: async (invoice: Invoice): Promise<SendInvoiceResult> => {
      const { data, error: fnError } = await supabase.functions.invoke("send-invoice-email", {
        body: { invoiceId: invoice.id },
      });
      if (fnError) throw fnError;
      if (data?.error === "no_email") {
        return { noEmail: true, invoice };
      }
      // Duplicate-send guard tripped server-side: already delivered moments ago.
      if (data?.skipped === "recently_sent") {
        return { noEmail: false, skipped: true, email: data?.email };
      }
      // Only stamp sent_at after a confirmed delivery. Preserve the structured
      // failure reason (e.g. "email_not_configured") so onError can surface it.
      if (!data?.success) throw new Error(typeof data?.error === "string" ? data.error : "send_failed");
      const { error } = await supabase
        .from("invoices")
        .update({ sent_at: new Date().toISOString(), status: "sent" })
        .eq("id", invoice.id);
      if (error) throw error;
      return { noEmail: false, email: data?.email };
    },
    onMutate: (invoice) => {
      setSendingInvoiceIds((prev) => new Set(prev).add(invoice.id));
    },
    onSettled: (_data, _error, invoice) => {
      setSendingInvoiceIds((prev) => {
        const next = new Set(prev);
        next.delete(invoice.id);
        return next;
      });
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
      if (result.skipped) {
        toast.info(t("invoices.recentlySentSkipped", "Deze factuur is zojuist al verzonden"));
        return;
      }
      invalidateInvoicesAndPlayers();
      toast.success(result.email
        ? t("invoices.sentSuccessTo", { email: result.email })
        : t("invoices.sentSuccess"));
    },
    onError: (error) => {
      toast.error(t("invoices.sendError", "Verzenden mislukt"), {
        description: describeSendError(error instanceof Error ? error.message : undefined),
      });
    },
  });

  // Bulk send
  const handleSendAllDrafts = async () => {
    if (!ensureInvoiceSettingsComplete()) return;
    if (!trainerId) return;
    setSendingAll(true);
    // Reach is ALL unsent drafts (every page), not just the visible page.
    const drafts = (await fetchAllTrainerInvoices(trainerId, { tab: "unpaid" })).filter((i) => !i.sent_at);
    let sent = 0, noEmail = 0, failed = 0;
    const undelivered: string[] = [];
    for (const inv of drafts) {
      const rowLabel = inv.player_name ? `${inv.invoice_number} (${inv.player_name})` : inv.invoice_number;
      try {
        const { data, error: fnError } = await supabase.functions.invoke("send-invoice-email", { body: { invoiceId: inv.id } });
        if (data?.error === "no_email") {
          noEmail++;
          undelivered.push(rowLabel);
        } else if (!fnError && data?.success) {
          sent++;
          // Only stamp sent_at after a confirmed delivery — a failed or
          // address-less send must not record the invoice as issued.
          await supabase.from("invoices").update({ sent_at: new Date().toISOString(), status: "sent" }).eq("id", inv.id);
        } else {
          failed++;
          undelivered.push(rowLabel);
        }
      } catch {
        failed++;
        undelivered.push(rowLabel);
      }
    }
    invalidateInvoicesAndPlayers();
    const parts = [];
    if (sent > 0) parts.push(t("invoices.bulkSent", { count: sent }));
    if (noEmail > 0) parts.push(t("invoices.bulkNoEmail", { count: noEmail }));
    if (failed > 0) parts.push(t("invoices.bulkFailed", { count: failed }));
    const summary = t("invoices.bulkProcessed", { total: drafts.length, parts: parts.join(", ") });
    if (undelivered.length > 0) {
      const MAX_LISTED = 8;
      const list = undelivered.slice(0, MAX_LISTED).join(", ") + (undelivered.length > MAX_LISTED ? ", …" : "");
      toast.error(summary, {
        description: t("invoices.bulkNotSentList", "Niet verzonden: {{list}}", { list }),
        duration: 10000,
      });
    } else {
      toast.success(summary);
    }
    setSendingAll(false);
  };

  const handleEmailSubmitAndSend = async (email: string) => {
    const { invoiceId, guestPlayerId } = emailDialog;
    if (guestPlayerId) {
      await supabase.from("guest_players").update({ email }).eq("id", guestPlayerId);
    }
    const { data, error: fnError } = await supabase.functions.invoke("send-invoice-email", { body: { invoiceId } });
    // Only mark sent after a confirmed delivery
    if (fnError || !data?.success) {
      toast.error(t("invoices.sendError", "Verzenden mislukt"), {
        description: describeSendError(typeof data?.error === "string" ? data.error : undefined),
      });
      return;
    }
    await supabase.from("invoices").update({ sent_at: new Date().toISOString(), status: "sent" }).eq("id", invoiceId);
    invalidateInvoicesAndPlayers();
    toast.success(t("invoices.sentSuccessTo", { email }));
  };

  const markAsSentMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase.from("invoices").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateInvoicesAndPlayers();
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
  // Selection is page-scoped (cleared on page change); selectedInvoices comes from
  // useInvoiceListSelection above — the chosen rows on the current page.

  const handleBulkReset = async () => {
    setBulkRunning(true);
    // Never reset a PAID invoice to draft: it erases paid_at and the record that
    // money was received (which then survives only at Mollie), and re-sending
    // renumbers + emails a dead pay link. Skip paid rows; back it with a DB guard.
    const resettable = selectedInvoices.filter((i) => i.status !== "paid");
    const skipped = selectedInvoices.length - resettable.length;
    const ids = resettable.map((i) => i.id);
    if (ids.length === 0) {
      setBulkRunning(false);
      setConfirmBulk(null);
      toast.error(t("invoices.bulk.resetAllPaid", "Betaalde facturen kunnen niet worden gereset"));
      return;
    }
    const { error } = await supabase
      .from("invoices")
      .update({ status: "draft", sent_at: null, paid_at: null })
      .in("id", ids)
      .neq("status", "paid");
    setBulkRunning(false);
    setConfirmBulk(null);
    if (error) {
      toast.error(t("invoices.bulk.resetError", "Kon facturen niet resetten"));
      return;
    }
    setSelectedIds(new Set());
    invalidateInvoicesAndPlayers();
    toast.success(
      skipped > 0
        ? t("invoices.bulk.resetDonePartial", "{{count}} gereset, {{skipped}} betaalde overgeslagen", { count: ids.length, skipped })
        : t("invoices.bulk.resetDone", "{{count}} facturen gereset", { count: ids.length }),
    );
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
    invalidateInvoicesAndPlayers();
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
    invalidateInvoicesAndPlayers();
    toast.success(t("invoices.bulk.dueDateDone", "Vervaldatum bijgewerkt voor {{count}} facturen", { count: ids.length }));
  };

  // Shared with the academy list: render the server computed_status via InvoiceStatusBadge +
  // audit-trail tooltip (was hand-rolled here from raw status/sent_at/due_date, ignoring
  // computed_status). Visible change: trainer badges now match the canonical status styling.
  const getStatusBadge = (invoice: Invoice) => (
    <InvoiceListStatusBadge invoiceId={invoice.id} status={invoice.computed_status} />
  );

  const getPaymentUrl = (inv: Invoice) =>
    `${window.location.origin}/pay/${inv.public_token}`;

  const ShareDropdown = ({ invoice }: { invoice: Invoice }) => {
    const shareable = canSharePublicPaymentLink(invoice);
    const isDraft = invoice.status === "draft";
    const isSending = sendingInvoiceIds.has(invoice.id);

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" disabled={isSending} aria-label={t("invoices.shareOptions", "Share options")}>
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
          </Button>
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
            disabled={isSending}
            onClick={() => {
              if (isSending) return;
              if (!ensureInvoiceSettingsComplete()) return;
              sendInvoiceMutation.mutate(invoice);
            }}
          >
            {isSending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Mail className="h-4 w-4 mr-2" />}
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
            {countDraft > 0 && (
              <Button size="sm" variant="outline" onClick={handleSendAllDrafts} disabled={sendingAll}>
                {sendingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                {sendingAll ? t("invoices.sendingAll", "Verzenden...") : t("invoices.sendAllDrafts", "Alle concepten verzenden")} ({countDraft})
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
          <InvoiceStatTiles
            tiles={[
              { label: t("invoices.totalUnpaid", "Openstaand"), value: formatCurrency(totalUnpaid) },
              { label: t("invoices.unpaidCount", "Open facturen"), value: countUnpaid },
              { label: t("invoices.paid", "Betaald"), value: countPaid },
            ]}
          />

          {/* Tabs + Filters */}
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-3">
            <TabsList>
              <TabsTrigger value="unpaid">{t("invoices.unpaid", "Openstaand")} ({countUnpaid})</TabsTrigger>
              <TabsTrigger value="paid">{t("invoices.paid", "Betaald")} ({countPaid})</TabsTrigger>
            </TabsList>

            {deliverySummary && (deliverySummary.bounced + deliverySummary.noEmail) > 0 && deliveryFilter === "all" && (
              <button
                type="button"
                onClick={() => setDeliveryFilter("undelivered")}
                aria-label={tDelivery("emailDelivery.bannerCta", "Show them")}
                className="flex w-full items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
              >
                <MailWarning className="h-4 w-4 shrink-0" />
                <span className="flex-1">
                  {tDelivery("emailDelivery.banner", "{{count}} of these invoices never reached the player", { count: deliverySummary.bounced + deliverySummary.noEmail })}
                  {" — "}
                  {tDelivery("emailDelivery.bannerDetail", "{{bounced}} bounced · {{noEmail}} no email", { bounced: deliverySummary.bounced, noEmail: deliverySummary.noEmail })}
                </span>
                <span className="shrink-0 text-xs underline">{tDelivery("emailDelivery.bannerCta", "Show them")}</span>
              </button>
            )}

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
              <Select value={deliveryFilter} onValueChange={setDeliveryFilter}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tDelivery("emailDelivery.filter.all", "All delivery")}</SelectItem>
                  <SelectItem value="undelivered">{tDelivery("emailDelivery.filter.issue", "Delivery issue")}</SelectItem>
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
                  <InvoiceListTable
                    rows={filteredInvoices}
                    activeTab={activeTab}
                    dateFnsLocale={dateFnsLocale}
                    sortKey={sortConfig.key}
                    sortDirection={sortConfig.direction}
                    onSort={handleSort}
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    onToggleSelectAll={toggleSelectAllVisible}
                    onRowClick={(inv) => navigate(`/app/trainer/invoices/${inv.id}/edit`)}
                    labels={{
                      selectAll: "Select all",
                      number: t("invoices.number", "Nummer"),
                      player: t("invoices.player", "Klant"),
                      delivery: tDelivery("emailDelivery.column", "Delivery"),
                      date: t("invoices.date", "Datum"),
                      paymentDate: t("invoices.paymentDate", "Betaaldatum"),
                      dueDate: t("invoices.dueDate", "Vervaldatum"),
                      amount: t("invoices.amount", "Bedrag"),
                      status: t("invoices.status", "Status"),
                      actions: t("invoices.actions", "Acties"),
                      selectRow: (n) => `Select ${n}`,
                      forwardedOn: (d) => `Doorgestuurd op ${d}`,
                    }}
                    renderActions={(inv) => (
                      <>
                        {inv.status !== "paid" && inv.status !== "cancelled" && <ShareDropdown invoice={inv} />}
                        {inv.status === "paid" && (
                          <Button size="sm" variant="ghost" onClick={() => handleForwardInvoice(inv.id)} disabled={forwardingId === inv.id}>
                            {forwardingId === inv.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                          </Button>
                        )}
                      </>
                    )}
                  />

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
                            <div className="flex items-center gap-1.5 flex-wrap justify-end">
                              {getStatusBadge(inv)}
                              <InvoiceDeliveryChip
                                deliveryStatus={inv.delivery_status}
                                hasEmail={invoiceHasEmail(inv)}
                              />
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

              <ListPagination page={page} pageCount={pageCount} onPageChange={setPage} className="mt-4" />
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
          invalidateInvoicesAndPlayers();
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
