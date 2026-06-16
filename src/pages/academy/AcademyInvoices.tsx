import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { useAcademyContext } from "@/components/academy/AcademyLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useTableSort } from "@/hooks/useTableSort";
import { SortableTableHead } from "@/components/admin/SortableTableHead";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  INVOICE_PAGE_SIZE,
  useAcademyInvoices,
  useAcademyInvoiceSummary,
  useAcademyInvoiceDeliverySummary,
  fetchAllAcademyInvoices,
  type AcademyInvoiceRow,
} from "@/lib/invoicesList";
import { InvoiceDeliveryChip } from "@/components/email/InvoiceDeliveryChip";
import { Input } from "@/components/ui/input";
import { annotateInvoiceStatusReason } from "@/lib/invoiceStatusHistory";
import { InvoiceEmailDialog } from "@/components/trainer/InvoiceEmailDialog";
import { BulkInvoiceEmailDialog } from "@/components/invoices/BulkInvoiceEmailDialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Settings, FileText, Send, Loader2, Share2, PlusCircle, Link2, Mail, CheckCheck, RotateCcw, Trash2, X, CalendarIcon, MailWarning } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { AppPage, dataTableCardContentClass } from "@/components/ui/app-page";
import { TableToolbar } from "@/components/ui/table-toolbar";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { invalidateAllPlayerData } from "@/lib/playerQueryKeys";
import { toast } from "sonner";
import { format } from "date-fns";
import { AcademyInvoiceSettingsCard } from "@/components/academy/AcademyInvoiceSettingsCard";
import { ExtraCostPresetsCard } from "@/components/settings/ExtraCostPresetsCard";
import { nl, enUS } from "date-fns/locale";
import { canSharePublicPaymentLink } from "@/lib/invoiceSettingsComplete";
import { type InvoiceStatus } from "@/lib/invoiceStatus";
import { InvoiceStatusBadge } from "@/components/invoices/InvoiceStatusBadge";
import { InvoiceStatusBadgeTooltip } from "@/components/invoices/InvoiceStatusBadgeTooltip";
import {
  buildInvoiceSettingsLabels,
  checkInvoiceSettingsGate,
} from "@/lib/invoiceShareGuards";


// The visible list is now the server-paginated RPC row (33 invoice columns plus
// computed_status / total_count / linked_email / location_id). Aliasing keeps the
// existing mutation/handler/ShareDropdown signatures intact across the data swap.
type Invoice = AcademyInvoiceRow;

export default function AcademyInvoices() {
  const { t, i18n } = useTranslation("academy");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const queryClient = useQueryClient();

  /** Refresh invoices + all player views (overdue flag, guest email edits). */
  const invalidateInvoicesAndPlayers = () => {
    queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
    if (activeAcademy?.id) {
      invalidateAllPlayerData(queryClient, { kind: "academy", id: activeAcademy.id });
    }
  };
  const pageTab = searchParams.get("tab") === "settings" ? "settings" : "overview";
  const [activeTab, setActiveTab] = useState("unpaid");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [trainerFilter, setTrainerFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [sendingAll, setSendingAll] = useState(false);
  const [forwardingId, setForwardingId] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; invoiceId: string; playerName: string; guestPlayerId: string | null }>({ open: false, invoiceId: '', playerName: '', guestPlayerId: null });
  const [sendingInvoiceIds, setSendingInvoiceIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<null | "reset" | "delete">(null);
  const [bulkCancelReason, setBulkCancelReason] = useState("");
  const [bulkRunning, setBulkRunning] = useState(false);
  const dateFnsLocale = i18n.language === "nl" ? nl : enUS;

  const [bulkDueOpen, setBulkDueOpen] = useState(false);
  const [bulkDueDate, setBulkDueDate] = useState<Date | undefined>(undefined);
  const [deliveryFilter, setDeliveryFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const debouncedSearch = useDebouncedValue(searchQuery);

  // Header-click sort affordance only; translated to RPC sort/sortDir params below.
  const { sortConfig, handleSort, setSortConfig } = useTableSort<Invoice>([]);

  // Translate the sortConfig column to the RPC's server-side sort key.
  const rpcSort =
    sortConfig.key === "player_name" ? "player_name"
    : sortConfig.key === "total" ? "total"
    : sortConfig.key === "due_date" ? "due_date"
    : sortConfig.key === "_computedStatus" ? "status"
    : sortConfig.key === "paid_at" ? "paid_at"
    : "created_at";
  const rpcSortDir: "asc" | "desc" = sortConfig.direction === "asc" ? "asc" : "desc";

  // Force the paid-tab default sort (paid_at desc) and clear it on the unpaid tab
  // so the unpaid default falls back to created_at desc — preserved from before.
  useEffect(() => {
    if (activeTab === "paid") {
      setSortConfig({ key: "paid_at" as any, direction: "desc" });
    } else {
      setSortConfig({ key: null, direction: null });
    }
  }, [activeTab, setSortConfig]);

  const academyId = activeAcademy?.id;
  const trainerScope = trainerFilter === "all" ? null : trainerFilter;
  const locationScope = locationFilter === "all" ? null : locationFilter;
  const statusScope = statusFilter === "all" ? null : statusFilter;

  // Server-paginated visible list (exact at >1000 invoices; no client re-filter/sort).
  const { data: overview, isLoading } = useAcademyInvoices(academyId, {
    tab: activeTab === "paid" ? "paid" : "unpaid",
    status: statusScope,
    search: debouncedSearch || null,
    trainerId: trainerScope,
    locationId: locationScope,
    delivery: deliveryFilter === "all" ? null : deliveryFilter,
    sort: rpcSort,
    sortDir: rpcSortDir,
    page,
    pageSize: INVOICE_PAGE_SIZE,
  });

  // Receivables scoreboard: follows trainer + location, ignores tab/status/search/no-email
  // (contract rule 3). This is the financial-correctness source — never derived from page rows.
  const { data: summary } = useAcademyInvoiceSummary(academyId, {
    trainerId: trainerScope,
    locationId: locationScope,
  });

  const filteredInvoices: Invoice[] = overview?.rows ?? [];

  // Delivery breakdown for the banner (follows tab + trainer/location, like the scoreboard).
  const { data: deliverySummary } = useAcademyInvoiceDeliverySummary(academyId, {
    tab: activeTab === "paid" ? "paid" : "unpaid",
    trainerId: trainerScope,
    locationId: locationScope,
  });
  const totalUnpaid = summary?.sumUnpaid ?? 0;
  const countUnpaid = summary?.countUnpaid ?? 0;
  const countPaid = summary?.countPaid ?? 0;
  const countDraft = summary?.countDraft ?? 0;
  const pageCount = Math.max(1, Math.ceil((overview?.total ?? 0) / INVOICE_PAGE_SIZE));

  // Keep page in range and reset to the first page whenever the query inputs change.
  useEffect(() => {
    setPage((p) => Math.min(Math.max(0, p), pageCount - 1));
  }, [pageCount]);
  useEffect(() => {
    setPage(0);
  }, [activeTab, statusFilter, trainerFilter, locationFilter, debouncedSearch, deliveryFilter, rpcSort, rpcSortDir]);

  // Clear selection when filters/tab/page change (selection is page-scoped).
  useEffect(() => { setSelectedIds(new Set()); }, [activeTab, statusFilter, trainerFilter, locationFilter, debouncedSearch, deliveryFilter, page]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };


  // Fetch trainers for filter (two-step: get user_ids, then profiles for names)
  const { data: trainers = [] } = useQuery({
    queryKey: ["academy-trainers-filter", activeAcademy?.id],
    queryFn: async () => {
      if (!activeAcademy?.id) return [];
      const { data, error } = await supabase
        .from("academy_trainers")
        .select("trainer_profile_id, trainer_profiles(id, business_name, user_id)")
        .eq("academy_profile_id", activeAcademy.id)
        .eq("status", "active");
      if (error) throw error;
      
      // Collect user_ids to fetch full_name from profiles
      const userIds = (data || [])
        .map((t: any) => t.trainer_profiles?.user_id)
        .filter(Boolean);
      
      let profileMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", userIds);
        profileMap = (profiles || []).reduce((acc: Record<string, string>, p: any) => {
          acc[p.user_id] = p.full_name || "";
          return acc;
        }, {});
      }
      
      return (data || []).map((t: any) => ({
        id: t.trainer_profile_id,
        name: t.trainer_profiles?.business_name || profileMap[t.trainer_profiles?.user_id] || "Trainer",
      }));
    },
    enabled: !!activeAcademy?.id,
  });

  // Fetch academy locations for filter
  const { data: academyLocations = [] } = useQuery({
    queryKey: ["academy-locations-filter", activeAcademy?.id],
    queryFn: async () => {
      if (!activeAcademy?.id) return [];
      const { data, error } = await supabase
        .from("academy_locations")
        .select("location_id, locations(id, name)")
        .eq("academy_profile_id", activeAcademy.id)
        .eq("is_active", true);
      if (error) throw error;
      return (data || []).map((l: any) => ({
        id: l.location_id,
        name: l.locations?.name || "Location",
      }));
    },
    enabled: !!activeAcademy?.id,
  });

  const { data: invoiceSettings } = useQuery({
    queryKey: ["academy-invoice-settings", activeAcademy?.id],
    queryFn: async () => {
      if (!activeAcademy?.id) return null;
      const { data, error } = await supabase
        .from("academy_profiles")
        .select("business_name, business_address, kvk_number, iban")
        .eq("id", activeAcademy.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!activeAcademy?.id,
  });

  const invoiceSettingsLabels = buildInvoiceSettingsLabels(t, "academy");

  const openInvoiceSettings = () => setSearchParams({ tab: "settings" });

  const ensureInvoiceSettingsComplete = (): boolean => {
    const gate = checkInvoiceSettingsGate(
      invoiceSettings,
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

  // The "no email" indicator now reads the linked-player email resolved
  // server-side by the RPC (single source of truth). Typed non-null by the
  // generator, but null at runtime when no email is linked — handle defensively.
  const invoiceHasEmail = (inv: Invoice) => inv.linked_email != null;

  // Map a known send-failure reason from the send-invoice-email function to
  // actionable copy for the failure toast description.
  const describeSendError = (reason?: string) =>
    reason === "email_not_configured"
      ? t("invoices.sendErrorNotConfigured", "Email sending is not configured yet — contact support.")
      : t("invoices.sendErrorWithHint", "Failed to send the invoice. Check the recipient email and try again.");

  // Send single invoice (with email)
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
        toast.info(t("invoices.recentlySentSkipped", "This invoice was already sent moments ago"));
        return;
      }
      invalidateInvoicesAndPlayers();
      toast.success(result.email
        ? t("invoices.sentSuccessTo", { email: result.email })
        : t("invoices.sentSuccess"));
    },
    onError: (error) => {
      toast.error(t("invoices.sendError", "Failed to send invoice"), {
        description: describeSendError(error instanceof Error ? error.message : undefined),
      });
    },
  });

  // Bulk send all drafts
  const handleSendAllDrafts = async () => {
    if (!ensureInvoiceSettingsComplete()) return;
    if (!academyId) return;
    setSendingAll(true);
    let sent = 0;
    let noEmail = 0;
    let failed = 0;
    const undelivered: string[] = [];

    // Reach ALL unsent drafts (not just the visible page) within the current
    // trainer/location scope — page the unpaid tab server-side, then keep rows
    // that were never sent.
    const drafts = (await fetchAllAcademyInvoices(academyId, {
      tab: "unpaid",
      trainerId: trainerScope,
      locationId: locationScope,
    })).filter((i) => !i.sent_at);

    for (const inv of drafts) {
      const rowLabel = inv.player_name ? `${inv.invoice_number} (${inv.player_name})` : inv.invoice_number;
      try {
        const { data, error: fnError } = await supabase.functions.invoke("send-invoice-email", {
          body: { invoiceId: inv.id },
        });

        if (data?.error === "no_email") {
          noEmail++;
          undelivered.push(rowLabel);
        } else if (!fnError && data?.success) {
          sent++;
          // Only stamp sent_at after a confirmed delivery — a failed or
          // address-less send must not record the invoice as issued.
          await supabase
            .from("invoices")
            .update({ sent_at: new Date().toISOString(), status: "sent" })
            .eq("id", inv.id);
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
        description: t("invoices.bulkNotSentList", "Not sent: {{list}}", { list }),
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

    const { data, error: fnError } = await supabase.functions.invoke("send-invoice-email", {
      body: { invoiceId },
    });

    // Only mark sent after a confirmed delivery
    if (fnError || !data?.success) {
      toast.error(t("invoices.sendError", "Failed to send invoice"), {
        description: describeSendError(typeof data?.error === "string" ? data.error : undefined),
      });
      return;
    }

    await supabase.from("invoices").update({
      sent_at: new Date().toISOString(),
      status: "sent"
    }).eq("id", invoiceId);

    invalidateInvoicesAndPlayers();
    toast.success(t("invoices.sentSuccessTo", { email }));
  };

  // Mark as sent (without email)
  const markAsSentMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const { error } = await supabase
        .from("invoices")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateInvoicesAndPlayers();
      toast.success(t("invoices.markedAsSent", "Invoice marked as sent"));
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

  // ========== Bulk actions ==========
  // Selection is page-scoped (cleared on page change), so resolve against the
  // visible page rows rather than a full in-memory set.
  const selectedInvoices = (overview?.rows ?? []).filter((i) => selectedIds.has(i.id));

  const toggleSelectAllVisible = (visible: Invoice[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = visible.length > 0 && visible.every((i) => next.has(i.id));
      if (allSelected) {
        visible.forEach((i) => next.delete(i.id));
      } else {
        visible.forEach((i) => next.add(i.id));
      }
      return next;
    });
  };

  const handleBulkReset = async () => {
    setBulkRunning(true);
    // Never reset a PAID invoice to draft — that erases paid_at and the record of
    // received money (preserved only at Mollie). Skip paid rows + DB-level guard.
    const resettable = selectedInvoices.filter((i) => i.status !== "paid");
    const skipped = selectedInvoices.length - resettable.length;
    const ids = resettable.map((i) => i.id);
    if (ids.length === 0) {
      setBulkRunning(false);
      setConfirmBulk(null);
      toast.error(t("invoices.bulk.resetAllPaid", "Paid invoices cannot be reset"));
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
      toast.error(t("invoices.bulk.resetError", "Failed to reset invoices"));
      return;
    }
    setSelectedIds(new Set());
    invalidateInvoicesAndPlayers();
    toast.success(
      skipped > 0
        ? t("invoices.bulk.resetDonePartial", "{{count}} reset, {{skipped}} paid skipped", { count: ids.length, skipped })
        : t("invoices.bulk.resetDone", "{{count}} invoices reset to draft", { count: ids.length }),
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
      if (error) fail += others.length;
      else {
        ok += others.length;
        // record WHY they were cancelled (best-effort; never blocks the action)
        const reason = bulkCancelReason.trim();
        if (reason) await Promise.all(others.map((id) => annotateInvoiceStatusReason(id, reason).catch(() => {})));
      }
    }
    setBulkRunning(false);
    setConfirmBulk(null);
    setBulkCancelReason("");
    setSelectedIds(new Set());
    invalidateInvoicesAndPlayers();
    if (fail > 0) {
      toast.error(t("invoices.bulk.deletePartial", "{{ok}} processed, {{fail}} failed", { ok, fail }));
    } else {
      toast.success(t("invoices.bulk.deleteDone", "{{count}} invoices removed", { count: ok }));
    }
  };

  const handleBulkUpdateDueDate = async () => {
    if (!bulkDueDate) return;
    setBulkRunning(true);
    const ids = [...selectedIds];
    // Format as YYYY-MM-DD to avoid timezone shifts
    const yyyy = bulkDueDate.getFullYear();
    const mm = String(bulkDueDate.getMonth() + 1).padStart(2, "0");
    const dd = String(bulkDueDate.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const { error } = await supabase
      .from("invoices")
      .update({ due_date: dateStr })
      .in("id", ids);
    setBulkRunning(false);
    if (error) {
      toast.error(t("invoices.bulk.dueDateError", "Failed to update due date"));
      return;
    }
    setBulkDueOpen(false);
    setBulkDueDate(undefined);
    setSelectedIds(new Set());
    invalidateInvoicesAndPlayers();
    toast.success(t("invoices.bulk.dueDateDone", "Due date updated for {{count}} invoices", { count: ids.length }));
  };

  const getStatusBadge = (invoice: Invoice) => {
    const status = invoice.computed_status;
    // 'open' is academy-only (not in the canonical InvoiceStatus); the five
    // canonical states render via the shared InvoiceStatusBadge.
    const badge =
      status === "open" ? (
        <Badge variant="secondary">{t("invoices.open", "Open")}</Badge>
      ) : (
        <InvoiceStatusBadge status={status as InvoiceStatus} />
      );
    // Hovering the badge surfaces the last status change (who/when/why) from the
    // audit trail — fetched lazily so the list stays a single query.
    return <InvoiceStatusBadgeTooltip invoiceId={invoice.id}>{badge}</InvoiceStatusBadgeTooltip>;
  };

  const getPaymentUrl = (inv: Invoice) =>
    `${window.location.origin}/nl/academies/${activeAcademy?.slug}/pay/${inv.public_token}`;

  const ShareDropdown = ({ invoice }: { invoice: Invoice }) => {
    const shareable = canSharePublicPaymentLink(invoice);
    const isDraft = invoice.status === "draft";
    const isSending = sendingInvoiceIds.has(invoice.id);

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" disabled={isSending} aria-label={t("invoices.shareActions", "Share invoice")}>
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {shareable ? (
            <DropdownMenuItem
              onClick={() => {
                navigator.clipboard.writeText(getPaymentUrl(invoice));
                toast.success(t("invoices.shareLinkCopied", "Invoice link copied"));
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
      {/* Header */}
      <PageHeader
        title={t("invoices.title", "Facturen")}
        description={t("invoices.description", "Beheer facturen voor je academy")}
        actions={
          <>
            {countDraft > 0 && (
              <Button size="sm" variant="outline" onClick={handleSendAllDrafts} disabled={sendingAll}>
                {sendingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                {sendingAll
                  ? t("invoices.sendingAll", "Sending...")
                  : t("invoices.sendAllDrafts", "Send all drafts")} ({countDraft})
              </Button>
            )}
            <Button size="sm" onClick={() => navigate('/app/academy/invoices/new')}>
              <PlusCircle className="h-4 w-4 mr-2" />
              {t("invoices.createInvoice", "Nieuwe factuur")}
            </Button>
          </>
        }
      />

      {/* Page-level tabs: Overview / Settings */}
      <Tabs value={pageTab} onValueChange={(v) => setSearchParams(v === "settings" ? { tab: "settings" } : {})}>
        <TabsList>
          <TabsTrigger value="overview">{t("invoices.overviewTab", "Overzicht")}</TabsTrigger>
          <TabsTrigger value="settings">
            <Settings className="h-4 w-4 mr-1.5" />
            {t("invoices.settingsTab", "Instellingen")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 mt-4">

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{t("invoices.totalUnpaid", "Unpaid")}</p>
            <p className="font-display text-2xl font-semibold tabular-nums">{formatCurrency(totalUnpaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{t("invoices.unpaidCount", "Open invoices")}</p>
            <p className="font-display text-2xl font-semibold tabular-nums">{countUnpaid}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{t("invoices.paid", "Paid")}</p>
            <p className="font-display text-2xl font-semibold tabular-nums">{countPaid}</p>
          </CardContent>
        </Card>
      </div>

      {/* Bulk Selection Action Bar */}
      {selectedIds.size > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 shadow-sm">
          <span className="text-sm font-medium">
            {t("invoices.bulk.selected", "{{count}} selected", { count: selectedIds.size })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            <X className="h-4 w-4 mr-1" />
            {t("invoices.bulk.clear", "Clear")}
          </Button>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setBulkEmailOpen(true)}>
              <Mail className="h-4 w-4 mr-1.5" />
              {t("invoices.bulk.sendEmail", "Send email")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setConfirmBulk("reset")}>
              <RotateCcw className="h-4 w-4 mr-1.5" />
              {t("invoices.bulk.resetToDraft", "Reset to draft")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBulkDueOpen(true)}>
              <CalendarIcon className="h-4 w-4 mr-1.5" />
              {t("invoices.bulk.updateDueDate", "Update due date")}
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setConfirmBulk("delete")}>
              <Trash2 className="h-4 w-4 mr-1.5" />
              {t("invoices.bulk.delete", "Delete")}
            </Button>
          </div>
        </div>
      )}


      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-3">
        <TabsList>
          <TabsTrigger value="unpaid">{t("invoices.unpaid", "Unpaid")} ({countUnpaid})</TabsTrigger>
          <TabsTrigger value="paid">{t("invoices.paid", "Paid")} ({countPaid})</TabsTrigger>
        </TabsList>

        {deliverySummary && (deliverySummary.bounced + deliverySummary.noEmail) > 0 && deliveryFilter === "all" && (
          <button
            type="button"
            onClick={() => setDeliveryFilter("undelivered")}
            aria-label={t("emailDelivery.bannerCta", "Show them")}
            className="flex w-full items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
          >
            <MailWarning className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              {t("emailDelivery.banner", "{{count}} of these invoices never reached the player", { count: deliverySummary.bounced + deliverySummary.noEmail })}
              {" — "}
              {t("emailDelivery.bannerDetail", "{{bounced}} bounced · {{noEmail}} no email", { bounced: deliverySummary.bounced, noEmail: deliverySummary.noEmail })}
            </span>
            <span className="shrink-0 text-xs underline">{t("emailDelivery.bannerCta", "Show them")}</span>
          </button>
        )}

        <TableToolbar
          searchPlaceholder={t("invoices.searchPlaceholder", "Zoek op speler...")}
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
        >
          {trainers.length > 0 && (
            <Select value={trainerFilter} onValueChange={setTrainerFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t("invoices.allTrainers", "Alle trainers")}>
                  {trainerFilter === "all"
                    ? t("invoices.allTrainers", "Alle trainers")
                    : (trainers as any[]).find(tr => tr.id === trainerFilter)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("invoices.allTrainers", "Alle trainers")}</SelectItem>
                {trainers.map((tr: any) => (
                  <SelectItem key={tr.id} value={tr.id}>{tr.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {academyLocations.length > 0 && (
            <Select value={locationFilter} onValueChange={setLocationFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t("invoices.allLocations", "Alle locaties")}>
                  {locationFilter === "all"
                    ? t("invoices.allLocations", "Alle locaties")
                    : (academyLocations as any[]).find(l => l.id === locationFilter)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("invoices.allLocations", "Alle locaties")}</SelectItem>
                {academyLocations.map((loc: any) => (
                  <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder={t("invoices.allStatuses", "Alle statussen")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("invoices.allStatuses", "Alle statussen")}</SelectItem>
              <SelectItem value="draft">{t("invoices.draft", "Draft")}</SelectItem>
              <SelectItem value="open">{t("invoices.open", "Open")}</SelectItem>
              <SelectItem value="sent">{t("invoices.sent", "Sent")}</SelectItem>
              <SelectItem value="overdue">{t("invoices.overdue", "Overdue")}</SelectItem>
              <SelectItem value="paid">{t("invoices.paid", "Paid")}</SelectItem>
              <SelectItem value="cancelled">{t("invoices.cancelled", "Cancelled")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={deliveryFilter} onValueChange={setDeliveryFilter}>
            <SelectTrigger className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("emailDelivery.filter.all", "All delivery")}</SelectItem>
              <SelectItem value="undelivered">{t("emailDelivery.filter.issue", "Delivery issue")}</SelectItem>
            </SelectContent>
          </Select>
        </TableToolbar>

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
                  <CardContent className={dataTableCardContentClass}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            checked={filteredInvoices.length > 0 && filteredInvoices.every((i) => selectedIds.has(i.id))}
                            onCheckedChange={() => toggleSelectAllVisible(filteredInvoices)}
                            aria-label={t("invoices.selectAll", "Select all")}
                          />
                        </TableHead>
                        <TableHead>{t("invoices.number", "Number")}</TableHead>
                        <TableHead>{t("invoices.player", "Player")}</TableHead>
                        <TableHead>{t("emailDelivery.column", "Delivery")}</TableHead>
                        <TableHead>{t("invoices.date", "Date")}</TableHead>
                        {activeTab === "paid" ? (
                          <SortableTableHead
                            sortKey="paid_at"
                            currentSortKey={sortConfig.key as string | null}
                            currentDirection={sortConfig.direction}
                            onSort={(key) => handleSort(key as any)}
                          >
                            {t("invoices.paymentDate", "Betaaldatum")}
                          </SortableTableHead>
                        ) : (
                          <SortableTableHead
                            sortKey="due_date"
                            currentSortKey={sortConfig.key as string | null}
                            currentDirection={sortConfig.direction}
                            onSort={(key) => handleSort(key as any)}
                          >
                            {t("invoices.dueDate", "Due")}
                          </SortableTableHead>
                        )}
                        <SortableTableHead
                          sortKey="total"
                          currentSortKey={sortConfig.key as string | null}
                          currentDirection={sortConfig.direction}
                          onSort={(key) => handleSort(key as any)}
                          className="text-right"
                        >
                          {t("invoices.amount", "Amount")}
                        </SortableTableHead>
                        <SortableTableHead
                          sortKey="_computedStatus"
                          currentSortKey={sortConfig.key as string | null}
                          currentDirection={sortConfig.direction}
                          onSort={(key) => handleSort(key as any)}
                        >
                          {t("invoices.status", "Status")}
                        </SortableTableHead>
                        <TableHead className="text-right">{t("invoices.actions", "Actions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredInvoices.map((inv) => (
                        <TableRow
                          key={inv.id}
                          className="cursor-pointer"
                          onClick={() => navigate(`/app/academy/invoices/${inv.id}/edit`)}
                        >
                          <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={selectedIds.has(inv.id)}
                              onCheckedChange={() => toggleSelect(inv.id)}
                              aria-label={t("invoices.selectInvoice", "Select {{number}}", { number: inv.invoice_number })}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                          <TableCell>{inv.player_name}</TableCell>
                          <TableCell>
                            <InvoiceDeliveryChip
                              deliveryStatus={inv.delivery_status}
                              hasEmail={invoiceHasEmail(inv)}
                            />
                          </TableCell>
                          <TableCell>{format(new Date(inv.invoice_date), "dd MMM yyyy", { locale: dateFnsLocale })}</TableCell>
                          <TableCell>{activeTab === "paid" ? (inv.paid_at ? format(new Date(inv.paid_at), "dd MMM yyyy", { locale: dateFnsLocale }) : "-") : format(new Date(inv.due_date), "dd MMM yyyy", { locale: dateFnsLocale })}</TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(inv.total)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              {getStatusBadge(inv)}
                              {inv.forwarded_at && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {t("invoices.forwardedOn", "Doorgestuurd op {{date}}", { date: format(new Date(inv.forwarded_at), "dd MMM yyyy HH:mm", { locale: dateFnsLocale }) })}
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </div>
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <div className="flex justify-end gap-1">
                              {inv.status !== "paid" && inv.status !== "cancelled" && (
                                <ShareDropdown invoice={inv} />
                              )}
                              {inv.status === "paid" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => handleForwardInvoice(inv.id)}
                                  disabled={forwardingId === inv.id}
                                >
                                  {forwardingId === inv.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Mail className="h-4 w-4" />
                                  )}
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

              {/* Mobile Cards — flush divided list (the viewport is the container on a phone) */}
              <div className="md:hidden divide-y divide-border/60 border-y border-border/60">
                {filteredInvoices.map((inv) => (
                  <Card key={inv.id} className="cursor-pointer rounded-none border-0 bg-transparent shadow-none" onClick={() => navigate(`/app/academy/invoices/${inv.id}/edit`)}>
                    <CardContent className="px-0 py-3">
                      <div className="flex items-start justify-between mb-2 gap-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
                            <Checkbox
                              checked={selectedIds.has(inv.id)}
                              onCheckedChange={() => toggleSelect(inv.id)}
                              aria-label={t("invoices.selectInvoice", "Select {{number}}", { number: inv.invoice_number })}
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
                        {inv.status !== "paid" && inv.status !== "cancelled" && (
                          <ShareDropdown invoice={inv} />
                        )}
                        {inv.status === "paid" && (
                          <Button size="sm" variant="outline" onClick={() => handleForwardInvoice(inv.id)} disabled={forwardingId === inv.id}>
                            {forwardingId === inv.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Mail className="h-4 w-4 mr-1" />}
                            {t("invoices.forwardToBookkeeper", "Forward")}
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {pageCount > 1 && (
                <Pagination className="mt-4">
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href="#"
                        aria-disabled={page === 0}
                        className={page === 0 ? 'pointer-events-none opacity-50' : ''}
                        onClick={(e) => { e.preventDefault(); setPage((p) => Math.max(0, p - 1)); }}
                      />
                    </PaginationItem>
                    {Array.from({ length: pageCount }, (_, i) => i)
                      .filter((i) => i === 0 || i === pageCount - 1 || Math.abs(i - page) <= 2)
                      .map((i, idx, arr) => (
                        <PaginationItem key={i}>
                          {idx > 0 && arr[idx - 1] !== i - 1 ? (
                            <span className="px-2 text-muted-foreground">…</span>
                          ) : null}
                          <PaginationLink
                            href="#"
                            isActive={i === page}
                            onClick={(e) => { e.preventDefault(); setPage(i); }}
                          >
                            {i + 1}
                          </PaginationLink>
                        </PaginationItem>
                      ))}
                    <PaginationItem>
                      <PaginationNext
                        href="#"
                        aria-disabled={page >= pageCount - 1}
                        className={page >= pageCount - 1 ? 'pointer-events-none opacity-50' : ''}
                        onClick={(e) => { e.preventDefault(); setPage((p) => Math.min(pageCount - 1, p + 1)); }}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

        </TabsContent>

        <TabsContent value="settings" className="space-y-6 mt-4">
          {activeAcademy?.id && (
            <>
              <AcademyInvoiceSettingsCard academyId={activeAcademy.id} />
              <ExtraCostPresetsCard academyProfileId={activeAcademy.id} />
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
            <DialogTitle>{t("invoices.bulk.updateDueDateTitle", "Update due date")}</DialogTitle>
            <DialogDescription>
              {t("invoices.bulk.updateDueDateDesc", "Set a new due date for {{count}} selected invoice(s).", { count: selectedIds.size })}
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
                  {bulkDueDate ? format(bulkDueDate, "dd MMM yyyy", { locale: dateFnsLocale }) : t("invoices.bulk.pickDate", "Pick a date")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={bulkDueDate}
                  onSelect={setBulkDueDate}
                  initialFocus
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDueOpen(false)} disabled={bulkRunning}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button onClick={handleBulkUpdateDueDate} disabled={!bulkDueDate || bulkRunning}>
              {bulkRunning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmBulk !== null} onOpenChange={(o) => { if (!o && !bulkRunning) { setConfirmBulk(null); setBulkCancelReason(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmBulk === "reset"
                ? t("invoices.bulk.confirmResetTitle", "Reset {{count}} invoices to draft?", { count: selectedIds.size })
                : t("invoices.bulk.confirmDeleteTitle", "Delete {{count}} invoices?", { count: selectedIds.size })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmBulk === "reset"
                ? t("invoices.bulk.confirmResetDesc", "Status, sent date and paid date will be cleared. This cannot be undone.")
                : t("invoices.bulk.confirmDeleteDesc", "Drafts will be removed permanently. Sent invoices will be cancelled.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmBulk === "delete" && (
            <Input
              value={bulkCancelReason}
              onChange={(e) => setBulkCancelReason(e.target.value)}
              placeholder={t("invoices.bulk.cancelReasonPlaceholder", "Reason (optional) — e.g. email bounced, duplicate")}
              disabled={bulkRunning}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkRunning}>{t("common.cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirmBulk === "reset") handleBulkReset();
                else if (confirmBulk === "delete") handleBulkDelete();
              }}
              disabled={bulkRunning}
            >
              {bulkRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {t("common.confirm", "Confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </AppPage>
  );
}
