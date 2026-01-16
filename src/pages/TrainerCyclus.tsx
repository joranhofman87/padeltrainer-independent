import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  ArrowLeft,
  Plus,
  Search,
  MoreVertical,
  Repeat,
  Calendar,
  Users,
  ChevronDown,
  ChevronRight,
  Copy,
  Pencil,
  Trash2,
  UserPlus,
  UserMinus,
} from "lucide-react";
import { format, parseISO, isPast } from "date-fns";

interface CyclusInfo {
  cyclus_id: string;
  cyclus_name: string;
  first_session: string;
  last_session: string;
  total_sessions: number;
  future_sessions: number;
  players: {
    id: string;
    name: string;
    booking_count: number;
  }[];
  lesson_title: string | null;
}

export default function TrainerCyclus() {
  const { t } = useTranslation("trainer");
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [cyclusList, setCyclusList] = useState<CyclusInfo[]>([]);
  const [filteredCyclus, setFilteredCyclus] = useState<CyclusInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedCyclus, setExpandedCyclus] = useState<string | null>(null);
  const [deletingCyclus, setDeletingCyclus] = useState<CyclusInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate("/auth");
    } else if (!loading && role !== "trainer") {
      navigate("/");
    }
  }, [user, role, loading, navigate]);

  useEffect(() => {
    const fetchTrainerId = async () => {
      if (!user) return;

      const { data } = await supabase
        .from("trainer_profiles")
        .select("id")
        .eq("user_id", user.id)
        .single();

      if (data) {
        setTrainerId(data.id);
      }
    };

    if (user) fetchTrainerId();
  }, [user]);

  useEffect(() => {
    if (trainerId) {
      fetchCyclusList();
    }
  }, [trainerId]);

  useEffect(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) {
      setFilteredCyclus(cyclusList);
    } else {
      setFilteredCyclus(
        cyclusList.filter(
          (c) =>
            c.cyclus_name.toLowerCase().includes(query) ||
            (c.lesson_title && c.lesson_title.toLowerCase().includes(query))
        )
      );
    }
  }, [searchQuery, cyclusList]);

  const fetchCyclusList = async () => {
    if (!trainerId) return;

    setIsLoading(true);
    try {
      // Get all slots with cyclus_id
      const { data: slots, error: slotsError } = await supabase
        .from("availability_slots")
        .select(`
          id,
          start_time,
          cyclus_id,
          cyclus_name,
          lessons(title)
        `)
        .eq("trainer_id", trainerId)
        .not("cyclus_id", "is", null)
        .order("start_time");

      if (slotsError) throw slotsError;

      if (!slots || slots.length === 0) {
        setCyclusList([]);
        setFilteredCyclus([]);
        setIsLoading(false);
        return;
      }

      // Get bookings for these slots
      const slotIds = slots.map((s) => s.id);
      const { data: bookings, error: bookingsError } = await supabase
        .from("bookings")
        .select(`
          id,
          slot_id,
          guest_player_id,
          status,
          guest_players(id, full_name)
        `)
        .in("slot_id", slotIds)
        .in("status", ["confirmed", "pending"]);

      if (bookingsError) throw bookingsError;

      // Group by cyclus
      const cyclusMap = new Map<string, CyclusInfo>();

      for (const slot of slots) {
        if (!slot.cyclus_id) continue;

        const existing = cyclusMap.get(slot.cyclus_id);
        const slotDate = new Date(slot.start_time);
        const isFuture = !isPast(slotDate);

        if (existing) {
          existing.total_sessions++;
          if (isFuture) existing.future_sessions++;
          if (slotDate > new Date(existing.last_session)) {
            existing.last_session = slot.start_time;
          }
          if (slotDate < new Date(existing.first_session)) {
            existing.first_session = slot.start_time;
          }
        } else {
          cyclusMap.set(slot.cyclus_id, {
            cyclus_id: slot.cyclus_id,
            cyclus_name: slot.cyclus_name || "Unnamed Cyclus",
            first_session: slot.start_time,
            last_session: slot.start_time,
            total_sessions: 1,
            future_sessions: isFuture ? 1 : 0,
            players: [],
            lesson_title: (slot.lessons as any)?.title || null,
          });
        }
      }

      // Add player info
      const playerMap = new Map<string, Map<string, { name: string; count: number }>>();

      for (const booking of bookings || []) {
        const slot = slots.find((s) => s.id === booking.slot_id);
        if (!slot?.cyclus_id || !booking.guest_player_id) continue;

        const cyclusPlayers = playerMap.get(slot.cyclus_id) || new Map();
        const player = cyclusPlayers.get(booking.guest_player_id);
        
        if (player) {
          player.count++;
        } else {
          cyclusPlayers.set(booking.guest_player_id, {
            name: (booking.guest_players as any)?.full_name || "Unknown",
            count: 1,
          });
        }
        
        playerMap.set(slot.cyclus_id, cyclusPlayers);
      }

      // Merge player info
      for (const [cyclusId, players] of playerMap) {
        const cyclus = cyclusMap.get(cyclusId);
        if (cyclus) {
          cyclus.players = Array.from(players.entries()).map(([id, p]) => ({
            id,
            name: p.name,
            booking_count: p.count,
          }));
        }
      }

      const list = Array.from(cyclusMap.values()).sort(
        (a, b) => new Date(b.first_session).getTime() - new Date(a.first_session).getTime()
      );

      setCyclusList(list);
      setFilteredCyclus(list);
    } catch (error: any) {
      console.error("Error fetching cyclus list:", error);
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteCyclus = async () => {
    if (!deletingCyclus) return;

    setIsDeleting(true);
    try {
      // Get all slot IDs for this cyclus
      const { data: slots, error: fetchError } = await supabase
        .from("availability_slots")
        .select("id")
        .eq("cyclus_id", deletingCyclus.cyclus_id);

      if (fetchError) throw fetchError;

      const slotIds = slots?.map((s) => s.id) || [];

      if (slotIds.length > 0) {
        // Cancel all bookings
        await supabase
          .from("bookings")
          .update({ status: "cancelled" })
          .in("slot_id", slotIds);

        // Delete all slots
        const { error: deleteError } = await supabase
          .from("availability_slots")
          .delete()
          .in("id", slotIds);

        if (deleteError) throw deleteError;
      }

      toast({
        title: t("cyclus.cyclusDeleted", "Cyclus deleted"),
        description: t("cyclus.cyclusDeletedDescription", "Deleted {{count}} sessions", { count: slotIds.length }),
      });

      fetchCyclusList();
    } catch (error: any) {
      console.error("Error deleting cyclus:", error);
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setDeletingCyclus(null);
    }
  };

  if (loading || isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-6">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-4">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/trainer")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">{t("cyclus.title", "Training Cycles")}</h1>
              <p className="text-muted-foreground">{t("cyclus.subtitle", "Manage your recurring training groups")}</p>
            </div>
          </div>
          <Button onClick={() => navigate("/trainer/calendar")}>
            <Plus className="mr-2 h-4 w-4" />
            {t("calendar.createCyclus")}
          </Button>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("cyclus.searchCyclus", "Search cycles...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Cyclus List */}
        {filteredCyclus.length === 0 ? (
          <Card className="p-8 text-center">
            <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <Repeat className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold mb-1">
              {searchQuery ? t("cyclus.noCyclusFound", "No cycles found") : t("cyclus.noCyclus", "No training cycles yet")}
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              {searchQuery
                ? t("cyclus.tryDifferentSearch", "Try a different search term")
                : t("cyclus.createFirst", "Create your first training cycle from the calendar")}
            </p>
            {!searchQuery && (
              <Button onClick={() => navigate("/trainer/calendar")}>
                <Plus className="mr-2 h-4 w-4" />
                {t("calendar.createCyclus")}
              </Button>
            )}
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredCyclus.map((cyclus) => (
              <Card key={cyclus.cyclus_id}>
                <Collapsible
                  open={expandedCyclus === cyclus.cyclus_id}
                  onOpenChange={(open) =>
                    setExpandedCyclus(open ? cyclus.cyclus_id : null)
                  }
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            {expandedCyclus === cyclus.cyclus_id ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </Button>
                        </CollapsibleTrigger>
                        <div>
                          <CardTitle className="text-lg flex items-center gap-2">
                            <Repeat className="h-4 w-4 text-primary" />
                            {cyclus.cyclus_name}
                          </CardTitle>
                          <CardDescription className="flex items-center gap-4 mt-1">
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {format(parseISO(cyclus.first_session), "MMM d")} -{" "}
                              {format(parseISO(cyclus.last_session), "MMM d, yyyy")}
                            </span>
                            {cyclus.lesson_title && (
                              <Badge variant="secondary" className="text-xs">
                                {cyclus.lesson_title}
                              </Badge>
                            )}
                          </CardDescription>
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="flex items-center gap-4">
                            <div className="text-center">
                              <p className="text-2xl font-bold">{cyclus.future_sessions}</p>
                              <p className="text-xs text-muted-foreground">{t("cyclus.upcoming", "upcoming")}</p>
                            </div>
                            <div className="text-center">
                              <p className="text-2xl font-bold">{cyclus.players.length}</p>
                              <p className="text-xs text-muted-foreground">{t("cyclus.players", "players")}</p>
                            </div>
                          </div>
                        </div>

                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate("/trainer/calendar")}>
                              <Calendar className="mr-2 h-4 w-4" />
                              {t("cyclus.viewInCalendar", "View in Calendar")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => navigate("/trainer/calendar")}>
                              <Copy className="mr-2 h-4 w-4" />
                              {t("calendar.duplicateCyclus")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => setDeletingCyclus(cyclus)}
                              className="text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              {t("cyclus.deleteCyclus", "Delete Cyclus")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </CardHeader>

                  <CollapsibleContent>
                    <CardContent className="pt-0">
                      <div className="border-t pt-4 mt-2">
                        <div className="flex items-center gap-2 mb-3">
                          <Users className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{t("cyclus.enrolledPlayers", "Enrolled Players")}</span>
                        </div>
                        
                        {cyclus.players.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-2">
                            {t("cyclus.noPlayersEnrolled", "No players enrolled in this cycle")}
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {cyclus.players.map((player) => (
                              <div
                                key={player.id}
                                className="flex items-center justify-between p-2 bg-muted rounded-lg"
                              >
                                <span className="font-medium">{player.name}</span>
                                <Badge variant="secondary">
                                  {player.booking_count} / {cyclus.total_sessions} {t("cyclus.sessions", "sessions")}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Collapsible>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingCyclus} onOpenChange={(open) => !open && setDeletingCyclus(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cyclus.deleteConfirmTitle", "Delete Training Cycle?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("cyclus.deleteConfirmDescription", "This will delete all {{count}} sessions in '{{name}}' and cancel any associated bookings. This action cannot be undone.", {
                count: deletingCyclus?.future_sessions || 0,
                name: deletingCyclus?.cyclus_name || "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteCyclus}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t("common:deleting", "Deleting...") : t("cyclus.deleteCyclus", "Delete Cyclus")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
