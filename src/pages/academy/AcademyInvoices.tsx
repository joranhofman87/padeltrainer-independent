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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { InvoiceEmailDialog } from "@/components/trainer/InvoiceEmailDialog";
import { BulkInvoiceEmailDialog } from "@/components/invoices/BulkInvoiceEmailDialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Settings, FileText, Send, CheckCircle, Loader2, AlertCircle, Share2, Search, PlusCircle, Link2, Mail, CheckCheck, RotateCcw, Trash2, X, CalendarIcon, MailX } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { AppPage, dataTableCardContentClass } from "@/components/ui/app-page";
import { TableToolbar } from "@/components/ui/table-toolbar";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { toast } from "sonner";
import { logger } from "@/lib/logger";
import { format } from "date-fns";
import { AcademyInvoiceSettingsCard } from "@/components/academy/AcademyInvoiceSettingsCard";
import { ExtraCostPresetsCard } from "@/components/settings/ExtraCostPresetsCard";
import { nl, enUS } from "date-fns/locale";
import { canSharePublicPaymentLink } from "@/lib/invoiceSettingsComplete";
import {
  buildInvoiceSettingsLabels,
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

export default function AcademyInvoices() {
  const { t, i18n } = useTranslation("academy");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const queryClient = useQueryClient();
  const pageTab = searchParams.get("tab") === "settings" ? "settings" : "overview";
  const [activeTab, setActiveTab] = useState("unpaid");
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [trainerFilter, setTrainerFilter] = useState("all");
  const [locationFilter, setLocationFilter] = useState("all");
  const [sendingAll, setSendingAll] = useState(false);
  const [forwardingId, setForwardingId] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; invoiceId: string; playerName: string; guestPlayerId: string | null }>({ open: false, invoiceId: '', playerName: '', guestPlayerId: null });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState<null | "reset" | "delete">(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const dateFnsLocale = i18n.language === "nl" ? nl : enUS;

  const [bulkDueOpen, setBulkDueOpen] = useState(false);
  const [bulkDueDate, setBulkDueDate] = useState<Date | undefined>(undefined);
  const [noEmailFilter, setNoEmailFilter] = useState(false);

  // Clear selection when filters/tab change
  useEffect(() => { setSelectedIds(new Set()); }, [activeTab, statusFilter, trainerFilter, locationFilter, searchQuery, noEmailFilter]);

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

  // Build a set of player/guest IDs that have an email, purely for display
  const { data: playerEmailSet = new Set<string>() } = useQuery({
    queryKey: ["invoice-player-emails", invoices.map(i => i.guest_player_id ?? i.player_id).join(",")],
    queryFn: async () => {
      const guestIds = invoices.map(i => i.guest_player_id).filter(Boolean) as string[];
      const profileIds = invoices.map(i => i.player_id).filter(Boolean) as string[];
      const results = new Set<string>();

      if (guestIds.length) {
        const { data } = await supabase
          .from("guest_players")
          .select("id, email")
          .in("id", guestIds);
        for (const row of data || []) {
          if (row.email) results.add(row.id);
        }
      }
      if (profileIds.length) {
        const { data } = await supabase
          .from("profiles")
          .select("id, email")
          .in("id", profileIds);
        for (const row of data || []) {
          if ((row as any).email) results.add(row.id);
        }
      }
      return results;
    },
    enabled: invoices.length > 0,
  });

  const invoiceHasEmail = (inv: Invoice) => {
    const id = inv.guest_player_id ?? inv.player_id;
    return id ? playerEmailSet.has(id) : false;
  };

  // Build invoice → location map from booking_ids → bookings → slots
  const { data: invoiceLocationMap = {} } = useQuery({
    queryKey: ["invoice-location-map", invoices.map(i => i.id).join(",")],
    queryFn: async () => {
      const allBookingIds = Array.from(new Set(
        invoices.flatMap(i => i.booking_ids || []).filter(Boolean)
      ));
      if (allBookingIds.length === 0) return {};

      // Batch in chunks to avoid the default 1000-row limit and overly long IN clauses
      const chunk = <T,>(arr: T[], size: number): T[][] => {
        const out: T[][] = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
      };

      const bookings: { id: string; slot_id: string }[] = [];
      for (const ids of chunk(allBookingIds, 200)) {
        const { data } = await supabase
          .from("bookings")
          .select("id, slot_id")
          .in("id", ids);
        if (data) bookings.push(...(data as any));
      }
      if (!bookings.length) return {};

      const slotIds = Array.from(new Set(bookings.map(b => b.slot_id).filter(Boolean)));
      const slots: { id: string; location_id: string | null }[] = [];
      for (const ids of chunk(slotIds, 200)) {
        const { data } = await supabase
          .from("availability_slots")
          .select("id, location_id")
          .in("id", ids);
        if (data) slots.push(...(data as any));
      }
      if (!slots.length) return {};
      
      const slotLocationMap = slots.reduce((acc: Record<string, string>, s: any) => {
        if (s.location_id) acc[s.id] = s.location_id;
        return acc;
      }, {});
      
      const bookingLocationMap = bookings.reduce((acc: Record<string, string>, b: any) => {
        if (slotLocationMap[b.slot_id]) acc[b.id] = slotLocationMap[b.slot_id];
        return acc;
      }, {});
      
      const map: Record<string, string> = {};
      for (const inv of invoices) {
        for (const bid of (inv.booking_ids || [])) {
          if (bookingLocationMap[bid]) {
            map[inv.id] = bookingLocationMap[bid];
            break;
          }
        }
      }
      return map;
    },
    enabled: invoices.length > 0,
  });


  const getComputedStatus = (inv: Invoice): string => {
    if (inv.status === "paid") return "paid";
    if (inv.status === "cancelled") return "cancelled";
    if (inv.sent_at && new Date(inv.due_date) < new Date()) return "overdue";
    if (inv.sent_at) return "sent";
    if (inv.status === "draft") return "draft";
    return "open";
  };

  // Filter by trainer, then by location
  const trainerFiltered = trainerFilter === "all"
    ? invoices
    : invoices.filter(i => (i as any).trainer_id === trainerFilter);

  const locationFiltered = locationFilter === "all"
    ? trainerFiltered
    : trainerFiltered.filter(i => (invoiceLocationMap as Record<string, string>)[i.id] === locationFilter);

  const unpaidInvoices = locationFiltered.filter((i) => i.status !== "paid" && i.status !== "cancelled");
  const paidInvoices = locationFiltered.filter((i) => i.status === "paid");
  const draftInvoices = locationFiltered.filter((i) => !i.sent_at && i.status !== "paid" && i.status !== "cancelled");

  const tabFiltered = activeTab === "paid" ? paidInvoices : unpaidInvoices;

  const statusFiltered = statusFilter === "all"
    ? tabFiltered
    : tabFiltered.filter(i => getComputedStatus(i) === statusFilter);

  const searchFiltered = statusFiltered.filter(i =>
    !searchQuery || i.player_name?.toLowerCase().includes(searchQuery.toLowerCase())
  ).filter(i => !noEmailFilter || !invoiceHasEmail(i));

  // Add computed status for sorting
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

  // Send single invoice (with email)
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
      queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
      toast.success(result.email
        ? t("invoices.sentSuccessTo", { email: result.email })
        : t("invoices.sentSuccess"));
    },
    onError: () => {
      toast.error(t("invoices.sendError", "Failed to send invoice"));
    },
  });

  // Bulk send all drafts
  const handleSendAllDrafts = async () => {
    if (!ensureInvoiceSettingsComplete()) return;
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

        await supabase
          .from("invoices")
          .update({ sent_at: new Date().toISOString(), status: "sent" })
          .eq("id", inv.id);
      } catch {
        failed++;
        await supabase
          .from("invoices")
          .update({ sent_at: new Date().toISOString(), status: "sent" })
          .eq("id", inv.id);
      }
    }

    queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
    
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

    await supabase.functions.invoke("send-invoice-email", {
      body: { invoiceId },
    });

    await supabase.from("invoices").update({ 
      sent_at: new Date().toISOString(), 
      status: "sent" 
    }).eq("id", invoiceId);

    queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
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
      queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
      toast.success(t("invoices.markedAsSent", "Invoice marked as sent"));
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

  // Delete / cancel invoice
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
      queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
      toast.success(invoice.status === 'draft'
        ? t("invoices.deleted", "Invoice deleted")
        : t("invoices.cancelled", "Invoice cancelled"));
    },
    onError: () => {
      toast.error(t("invoices.deleteError", "Failed to delete invoice"));
    },
  });

  // ========== Bulk actions ==========
  const selectedInvoices = invoices.filter((i) => selectedIds.has(i.id));

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
    const ids = [...selectedIds];
    const { error } = await supabase
      .from("invoices")
      .update({ status: "draft", sent_at: null, paid_at: null })
      .in("id", ids);
    setBulkRunning(false);
    setConfirmBulk(null);
    if (error) {
      toast.error(t("invoices.bulk.resetError", "Failed to reset invoices"));
      return;
    }
    setSelectedIds(new Set());
    queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
    toast.success(t("invoices.bulk.resetDone", "{{count}} invoices reset to draft", { count: ids.length }));
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
    queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
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
    queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
    toast.success(t("invoices.bulk.dueDateDone", "Due date updated for {{count}} invoices", { count: ids.length }));
  };

  const handleDownloadPdf = async (invoice: Invoice) => {
    try {
      const { downloadInvoicePdf } = await import('@/lib/downloadInvoicePdf');
      const ok = await downloadInvoicePdf(invoice.id, invoice.invoice_number);
      if (!ok) toast.error(t("invoices.noPdf", "No PDF available"));
    } catch (err) {
      logger.error('Invoice download failed:', err);
      toast.error(t("invoices.noPdf", "No PDF available"));
    }
  };

  const getStatusBadge = (invoice: Invoice) => {
    if (invoice.status === "paid") {
      return <Badge className="bg-green-500/10 text-green-600 dark:text-green-400 border-0"><CheckCircle className="h-3 w-3 mr-1" />{t("invoices.paid", "Paid")}</Badge>;
    }
    if (invoice.status === "cancelled") {
      return <Badge variant="outline">{t("invoices.cancelled", "Cancelled")}</Badge>;
    }
    if (invoice.sent_at) {
      const isOverdue = new Date(invoice.due_date) < new Date();
      return isOverdue
        ? <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />{t("invoices.overdue", "Overdue")}</Badge>
        : <Badge variant="secondary"><Send className="h-3 w-3 mr-1" />{t("invoices.sent", "Sent")}</Badge>;
    }
    if (invoice.status === "draft") {
      return <Badge variant="outline"><FileText className="h-3 w-3 mr-1" />{t("invoices.draft", "Draft")}</Badge>;
    }
    return <Badge variant="secondary">{t("invoices.open", "Open")}</Badge>;
  };

  const getPaymentUrl = (inv: Invoice) =>
    `${window.location.origin}/nl/academies/${activeAcademy?.slug}/pay/${inv.public_token}`;

  const ShareDropdown = ({ invoice }: { invoice: Invoice }) => {
    const shareable = canSharePublicPaymentLink(invoice);
    const isDraft = invoice.status === "draft";

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label={t("invoices.shareActions", "Share invoice")}>
            <Share2 className="h-4 w-4" />
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
      {/* Header */}
      <PageHeader
        title={t("invoices.title", "Facturen")}
        description={t("invoices.description", "Beheer facturen voor je academy")}
        actions={
          <>
            {draftInvoices.length > 0 && (
              <Button size="sm" variant="outline" onClick={handleSendAllDrafts} disabled={sendingAll}>
                {sendingAll ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
                {sendingAll
                  ? t("invoices.sendingAll", "Sending...")
                  : t("invoices.sendAllDrafts", "Send all drafts")} ({draftInvoices.length})
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
            <p className="font-display text-2xl font-semibold tabular-nums">{unpaidInvoices.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{t("invoices.paid", "Paid")}</p>
            <p className="font-display text-2xl font-semibold tabular-nums">{paidInvoices.length}</p>
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
          <TabsTrigger value="unpaid">{t("invoices.unpaid", "Unpaid")} ({unpaidInvoices.length})</TabsTrigger>
          <TabsTrigger value="paid">{t("invoices.paid", "Paid")} ({paidInvoices.length})</TabsTrigger>
        </TabsList>

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
          <Button
            size="sm"
            variant={noEmailFilter ? "default" : "outline"}
            onClick={() => setNoEmailFilter(v => !v)}
          >
            <MailX className="h-4 w-4 mr-1.5" />
            {t("invoices.noEmailFilter", "Geen e-mail")}
          </Button>
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
                            aria-label="Select all"
                          />
                        </TableHead>
                        <TableHead>{t("invoices.number", "Number")}</TableHead>
                        <TableHead>{t("invoices.player", "Player")}</TableHead>
                        <TableHead className="w-8"></TableHead>
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
                              aria-label={`Select ${inv.invoice_number}`}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                          <TableCell>{inv.player_name}</TableCell>
                          <TableCell className="w-8">
                            {!invoiceHasEmail(inv) && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <MailX className="h-3.5 w-3.5 text-muted-foreground" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t("invoices.noEmail", "No email address")}
                                </TooltipContent>
                              </Tooltip>
                            )}
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
                                    Doorgestuurd op {format(new Date(inv.forwarded_at), "dd MMM yyyy HH:mm", { locale: dateFnsLocale })}
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

              {/* Mobile Cards */}
              <div className="md:hidden space-y-3">
                {filteredInvoices.map((inv) => (
                  <Card key={inv.id} className="cursor-pointer" onClick={() => navigate(`/app/academy/invoices/${inv.id}/edit`)}>
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
          queryClient.invalidateQueries({ queryKey: ["academy-invoices"] });
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

      <AlertDialog open={confirmBulk !== null} onOpenChange={(o) => !o && !bulkRunning && setConfirmBulk(null)}>
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
