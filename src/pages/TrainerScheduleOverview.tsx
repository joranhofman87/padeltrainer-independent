import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Locale } from "date-fns";
import { useNavigate } from "react-router-dom";
import { format, isPast, isFuture, parseISO } from "date-fns";
import { nl, enUS, de, fr, es } from "date-fns/locale";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/hooks/useAuth";
import { getTrainerProfile } from "@/lib/auth";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Search,
  ChevronDown,
  ChevronRight,
  Calendar,
  Users,
  Pencil,
  MapPin,
  Loader2,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const localeMap: Record<string, Locale> = { nl, en: enUS, de, fr, es };

type SlotWithBookings = {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  max_participants: number | null;
  is_public: boolean;
  location_id: string | null;
  locations?: { name: string; city: string } | null;
  bookings: {
    id: string;
    status: string;
    payment_status: string;
    player_id: string | null;
    guest_player_id: string | null;
    profiles?: { full_name: string | null } | null;
    guest_players?: { full_name: string } | null;
  }[];
};

type TabValue = "current" | "future" | "past";

export default function TrainerScheduleOverview() {
  const { t, i18n } = useTranslation("trainer");
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<TabValue>("current");
  const [search, setSearch] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["__individual__"]));
  const [expandedSlots, setExpandedSlots] = useState<Set<string>>(new Set());

  // Rename cycle dialog
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameCycleId, setRenameCycleId] = useState<string | null>(null);
  const [renameCycleName, setRenameCycleName] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  // Remove player confirm
  const [removeBookingId, setRemoveBookingId] = useState<string | null>(null);
  const [removingBooking, setRemovingBooking] = useState(false);

  // Payment toggle loading
  const [togglingPayment, setTogglingPayment] = useState<string | null>(null);

  const dateFnsLocale = localeMap[i18n.language] || enUS;

  const { data: slots, isLoading } = useQuery({
    queryKey: ["trainer-schedule-overview", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const tp = await getTrainerProfile(user.id);
      if (!tp) return [];

      const { data, error } = await supabase
        .from("availability_slots")
        .select(`
          id, start_time, end_time, cyclus_id, cyclus_name, max_participants, is_public, location_id,
          locations:location_id (name, city),
          bookings (id, status, payment_status, player_id, guest_player_id,
            profiles:player_id (full_name),
            guest_players:guest_player_id (full_name)
          )
        `)
        .eq("trainer_id", tp.id)
        .order("start_time", { ascending: true });

      if (error) throw error;
      return (data || []) as unknown as SlotWithBookings[];
    },
    enabled: !!user,
  });

  // Group by cyclus
  const grouped = useMemo(() => {
    if (!slots) return new Map<string, { name: string; slots: SlotWithBookings[] }>();
    const map = new Map<string, { name: string; slots: SlotWithBookings[] }>();
    for (const s of slots) {
      const key = s.cyclus_id || "__individual__";
      if (!map.has(key)) {
        map.set(key, {
          name: s.cyclus_name || t("scheduleOverview.individualSessions", "Individual Sessions"),
          slots: [],
        });
      }
      map.get(key)!.slots.push(s);
    }
    return map;
  }, [slots, t]);

  // Filter by tab
  const filtered = useMemo(() => {
    const result = new Map<string, { name: string; slots: SlotWithBookings[] }>();

    grouped.forEach((group, key) => {
      const filteredSlots = group.slots.filter((s) => {
        const end = parseISO(s.end_time);
        const start = parseISO(s.start_time);
        if (tab === "past") return isPast(end);
        if (tab === "future") return isFuture(start);
        return !isPast(end) || isFuture(start);
      });

      if (filteredSlots.length > 0) {
        if (search.trim()) {
          const q = search.toLowerCase();
          const nameMatch = group.name.toLowerCase().includes(q);
          const slotMatches = filteredSlots.filter((s) => {
            const playerNames = s.bookings.map((b) =>
              (b.profiles?.full_name || b.guest_players?.full_name || "").toLowerCase()
            );
            return playerNames.some((n) => n.includes(q));
          });
          if (nameMatch) {
            result.set(key, { name: group.name, slots: filteredSlots });
          } else if (slotMatches.length > 0) {
            result.set(key, { name: group.name, slots: slotMatches });
          }
        } else {
          result.set(key, { name: group.name, slots: filteredSlots });
        }
      }
    });

    return result;
  }, [grouped, tab, search]);

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSlot = (id: string) => {
    setExpandedSlots((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const getActiveBookings = (bookings: SlotWithBookings["bookings"]) =>
    bookings.filter((b) => b.status !== "cancelled");

  const getPaidCount = (bookings: SlotWithBookings["bookings"]) =>
    getActiveBookings(bookings).filter((b) => b.payment_status === "paid").length;

  const getUnpaidCount = (bookings: SlotWithBookings["bookings"]) =>
    getActiveBookings(bookings).filter((b) => b.payment_status !== "paid").length;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["trainer-schedule-overview"] });

  // Rename cycle
  const openRenameDialog = (cycleId: string, currentName: string) => {
    setRenameCycleId(cycleId);
    setRenameCycleName(currentName);
    setRenameDialogOpen(true);
  };

  const handleRenameCycle = async () => {
    if (!renameCycleId || !renameCycleName.trim()) return;
    setSavingRename(true);
    const { error } = await supabase
      .from("availability_slots")
      .update({ cyclus_name: renameCycleName.trim() })
      .eq("cyclus_id", renameCycleId);
    setSavingRename(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: t("scheduleOverview.cycleSaved", "Cycle name updated") });
      setRenameDialogOpen(false);
      invalidate();
    }
  };

  // Toggle payment
  const handleTogglePayment = async (bookingId: string, currentStatus: string) => {
    setTogglingPayment(bookingId);
    const newStatus = currentStatus === "paid" ? "pending" : "paid";
    const updates: Record<string, unknown> = {
      payment_status: newStatus,
      paid_at: newStatus === "paid" ? new Date().toISOString() : null,
      paid_externally: newStatus === "paid" ? true : false,
    };
    const { error } = await supabase.from("bookings").update(updates).eq("id", bookingId);
    setTogglingPayment(null);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: t("scheduleOverview.paymentUpdated", "Payment status updated") });
      invalidate();
    }
  };

  // Remove player
  const handleRemovePlayer = async () => {
    if (!removeBookingId) return;
    setRemovingBooking(true);
    const { error } = await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .eq("id", removeBookingId);
    setRemovingBooking(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: t("scheduleOverview.playerRemoved", "Player removed from session") });
      setRemoveBookingId(null);
      invalidate();
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">
          {t("scheduleOverview.title", "Schedule Overview")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("scheduleOverview.description", "All your sessions grouped by cycle with payment status.")}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList>
            <TabsTrigger value="current">
              {t("scheduleOverview.current", "Current")}
            </TabsTrigger>
            <TabsTrigger value="future">
              {t("scheduleOverview.future", "Future")}
            </TabsTrigger>
            <TabsTrigger value="past">
              {t("scheduleOverview.past", "Past")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative w-full sm:w-64">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("scheduleOverview.search", "Search...")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {filtered.size === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Calendar className="h-12 w-12 mx-auto mb-3 opacity-40" />
          <p>{t("scheduleOverview.noResults", "No sessions found.")}</p>
        </div>
      )}

      <div className="space-y-3">
        {Array.from(filtered.entries()).map(([key, group]) => {
          const isOpen = openGroups.has(key);
          const totalSlots = group.slots.length;
          const totalPaid = group.slots.reduce((acc, s) => acc + getPaidCount(s.bookings), 0);
          const totalUnpaid = group.slots.reduce((acc, s) => acc + getUnpaidCount(s.bookings), 0);

          return (
            <div key={key} className="border rounded-lg bg-card">
              {/* Group header */}
              <div className="flex items-center gap-2 w-full p-3 hover:bg-muted/50 transition-colors rounded-t-lg">
                <button
                  onClick={() => toggleGroup(key)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-semibold text-sm flex-1 truncate">
                    {key === "__individual__" ? (
                      group.name
                    ) : (
                      <>
                        {t("scheduleOverview.cycle", "Cycle")}: {group.name}
                      </>
                    )}
                  </span>
                </button>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {totalSlots} {t("scheduleOverview.sessions", "sessions")}
                </span>
                {totalPaid > 0 && (
                  <Badge variant="secondary" className="text-[10px] bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                    {totalPaid} {t("scheduleOverview.paid", "paid")}
                  </Badge>
                )}
                {totalUnpaid > 0 && (
                  <Badge variant="secondary" className="text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                    {totalUnpaid} {t("scheduleOverview.unpaid", "unpaid")}
                  </Badge>
                )}
                {key !== "__individual__" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRenameDialog(key, group.name);
                    }}
                    title={t("scheduleOverview.renameCycle", "Rename")}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              {/* Slot rows */}
              {isOpen && (
                <div className="border-t divide-y">
                  {group.slots.map((slot) => {
                    const active = getActiveBookings(slot.bookings);
                    const paid = getPaidCount(slot.bookings);
                    const unpaid = getUnpaidCount(slot.bookings);
                    const slotExpanded = expandedSlots.has(slot.id);
                    const startDate = parseISO(slot.start_time);
                    const endDate = parseISO(slot.end_time);
                    const isPastSlot = isPast(endDate);
                    const location = slot.locations;

                    return (
                      <div key={slot.id} className={isPastSlot ? "opacity-60" : ""}>
                        <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
                          {/* Date & time */}
                          <div className="min-w-[140px] shrink-0">
                            <span className="font-medium">
                              {format(startDate, "EEEEEE d MMM", { locale: dateFnsLocale })}
                            </span>
                            <span className="text-muted-foreground ml-2">
                              {format(startDate, "HH:mm")}-{format(endDate, "HH:mm")}
                            </span>
                          </div>

                          {/* Location */}
                          {location && (
                            <div className="hidden md:flex items-center gap-1 text-muted-foreground text-xs min-w-[100px]">
                              <MapPin className="h-3 w-3" />
                              <span className="truncate">{location.name}</span>
                            </div>
                          )}

                          {/* Players */}
                          <div className="flex items-center gap-1 text-xs">
                            <Users className="h-3.5 w-3.5 text-muted-foreground" />
                            <span>
                              {active.length}
                              {slot.max_participants ? `/${slot.max_participants}` : ""}
                            </span>
                          </div>

                          {/* Payment badges */}
                          <div className="flex items-center gap-1 flex-1">
                            {paid > 0 && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                {paid} {t("scheduleOverview.paid", "paid")}
                              </Badge>
                            )}
                            {unpaid > 0 && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                {unpaid} {t("scheduleOverview.unpaid", "unpaid")}
                              </Badge>
                            )}
                            {!slot.is_public && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {t("scheduleOverview.private", "Private")}
                              </Badge>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() =>
                                navigate(
                                  `/trainer/calendar?date=${format(startDate, "yyyy-MM-dd")}`
                                )
                              }
                              title={t("scheduleOverview.edit", "Edit")}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            {active.length > 0 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => toggleSlot(slot.id)}
                              >
                                {slotExpanded ? (
                                  <ChevronDown className="h-3.5 w-3.5" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* Expanded player list */}
                        {slotExpanded && active.length > 0 && (
                          <div className="px-6 pb-2 space-y-1">
                            {active.map((b) => {
                              const name =
                                b.profiles?.full_name ||
                                b.guest_players?.full_name ||
                                t("scheduleOverview.unknownPlayer", "Unknown");
                              const isToggling = togglingPayment === b.id;
                              return (
                                <div
                                  key={b.id}
                                  className="flex items-center justify-between text-xs py-1 group"
                                >
                                  <span>{name}</span>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      onClick={() => handleTogglePayment(b.id, b.payment_status)}
                                      disabled={isToggling}
                                      title={
                                        b.payment_status === "paid"
                                          ? t("scheduleOverview.markAsUnpaid", "Mark as unpaid")
                                          : t("scheduleOverview.markAsPaid", "Mark as paid")
                                      }
                                      className="cursor-pointer"
                                    >
                                      <Badge
                                        variant="secondary"
                                        className={
                                          b.payment_status === "paid"
                                            ? "text-[10px] bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                                            : "text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                                        }
                                      >
                                        {isToggling ? (
                                          <Loader2 className="h-3 w-3 animate-spin" />
                                        ) : b.payment_status === "paid" ? (
                                          t("scheduleOverview.paid", "paid")
                                        ) : (
                                          t("scheduleOverview.unpaid", "unpaid")
                                        )}
                                      </Badge>
                                    </button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                                      onClick={() => setRemoveBookingId(b.id)}
                                      title={t("scheduleOverview.removePlayer", "Remove player")}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Rename Cycle Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("scheduleOverview.renameCycleTitle", "Rename Cycle")}
            </DialogTitle>
          </DialogHeader>
          <Input
            value={renameCycleName}
            onChange={(e) => setRenameCycleName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleRenameCycle()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              {t("scheduleOverview.cancel", "Cancel")}
            </Button>
            <Button onClick={handleRenameCycle} disabled={savingRename || !renameCycleName.trim()}>
              {savingRename && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t("scheduleOverview.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Player Confirm */}
      <AlertDialog open={!!removeBookingId} onOpenChange={(open) => !open && setRemoveBookingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("scheduleOverview.removePlayer", "Remove player")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("scheduleOverview.removePlayerConfirm", "Are you sure you want to remove this player from the session?")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingBooking}>
              {t("scheduleOverview.cancel", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRemovePlayer} disabled={removingBooking}>
              {removingBooking && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {t("scheduleOverview.removePlayer", "Remove player")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
