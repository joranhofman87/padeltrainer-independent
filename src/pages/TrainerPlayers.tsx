import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { logger } from '@/lib/logger';
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  UserPlus,
  Search,
  MoreVertical,
  Pencil,
  Trash2,
  Calendar,
  Mail,
  Phone,
  Upload,
} from "lucide-react";
import { format } from "date-fns";
import { AddPlayerDialog, GuestPlayer } from "@/components/trainer/AddPlayerDialog";
import { EditPlayerDialog } from "@/components/trainer/EditPlayerDialog";
import { ImportPlayersDialog } from "@/components/trainer/ImportPlayersDialog";

// Computed player status
type PlayerStatus = "waiting_list" | "active" | "available" | "prospect" | "registered";

// Unified player type for the list
type UnifiedPlayer = {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  skill_rating: number | null;
  rating_system: string;
  has_trained: boolean;
  notes: string | null;
  created_at: string;
  type: "guest" | "registered";
  computedStatus: PlayerStatus;
  // Only for guest players
  originalGuest?: GuestPlayer;
};

export default function TrainerPlayers() {
  const { t } = useTranslation("trainer");
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [guestPlayers, setGuestPlayers] = useState<GuestPlayer[]>([]);
  const [registeredPlayers, setRegisteredPlayers] = useState<UnifiedPlayer[]>([]);
  const [filteredPlayers, setFilteredPlayers] = useState<UnifiedPlayer[]>([]);
  const [allPlayers, setAllPlayers] = useState<UnifiedPlayer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<PlayerStatus | "all">("all");
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showImportPlayers, setShowImportPlayers] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<GuestPlayer | null>(null);
  const [deletingPlayer, setDeletingPlayer] = useState<GuestPlayer | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeGuestIds, setActiveGuestIds] = useState<Set<string>>(new Set());
  const [waitingListGuestIds, setWaitingListGuestIds] = useState<Set<string>>(new Set());

  // Auth is now handled by TrainerLayout

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

  // Compute status for a guest player
  const computeGuestStatus = (g: GuestPlayer): PlayerStatus => {
    if (waitingListGuestIds.has(g.id)) return "waiting_list";
    if (activeGuestIds.has(g.id)) return "active";
    if ((g as any).has_trained) return "available";
    return "prospect";
  };

  // Convert guest player to unified format
  const guestToUnified = (g: GuestPlayer): UnifiedPlayer => ({
    id: g.id,
    full_name: g.full_name,
    email: g.email || "",
    phone: g.phone || "",
    skill_rating: g.skill_rating ?? null,
    rating_system: (g as any).rating_system || "knltb",
    has_trained: (g as any).has_trained ?? true,
    notes: g.notes || null,
    created_at: g.created_at,
    type: "guest",
    computedStatus: computeGuestStatus(g),
    originalGuest: g,
  });

  useEffect(() => {
    const fetchPlayers = async () => {
      if (!trainerId) return;

      setIsLoading(true);
      try {
        // Fetch guest players
        const { data: guestData, error: guestError } = await supabase
          .from("guest_players")
          .select("*")
          .eq("trainer_id", trainerId)
          .order("full_name");

        if (guestError) throw guestError;
        setGuestPlayers(guestData as GuestPlayer[]);

        // Fetch slot IDs for this trainer
        const { data: slotIds } = await supabase
          .from("availability_slots")
          .select("id")
          .eq("trainer_id", trainerId);

        const allSlotIds = (slotIds || []).map(s => s.id);

        // Fetch future bookings for guest players to determine active status
        const now = new Date().toISOString();
        if (allSlotIds.length > 0) {
          const { data: futureBookings } = await supabase
            .from("bookings")
            .select("guest_player_id, availability_slots!inner(start_time)")
            .in("slot_id", allSlotIds)
            .not("guest_player_id", "is", null)
            .neq("status", "cancelled")
            .gte("availability_slots.start_time", now);

          const activeIds = new Set<string>();
          (futureBookings || []).forEach(b => {
            if (b.guest_player_id) activeIds.add(b.guest_player_id);
          });
          setActiveGuestIds(activeIds);
        }

        // Check waiting list entries for guest players
        const guestEmails = (guestData as GuestPlayer[]).filter(g => g.email).map(g => g.email!);
        if (guestEmails.length > 0) {
          const { data: waitingEntries } = await supabase
            .from("waiting_list_entries")
            .select("email")
            .eq("trainer_id", trainerId)
            .eq("status", "active")
            .in("email", guestEmails);

          const waitingEmails = new Set((waitingEntries || []).map(w => (w as any).email));
          const wlIds = new Set<string>();
          (guestData as GuestPlayer[]).forEach(g => {
            if (g.email && waitingEmails.has(g.email)) wlIds.add(g.id);
          });
          setWaitingListGuestIds(wlIds);
        }

        // Fetch registered players who booked with this trainer
        let regPlayers: UnifiedPlayer[] = [];
        if (allSlotIds.length > 0) {
          const { data: bookings } = await supabase
            .from("bookings")
            .select("player_id, created_at")
            .in("slot_id", allSlotIds)
            .not("player_id", "is", null);

          if (bookings && bookings.length > 0) {
            const playerMap = new Map<string, string>();
            bookings.forEach(b => {
              if (b.player_id && !playerMap.has(b.player_id)) {
                playerMap.set(b.player_id, b.created_at);
              }
            });

            const playerIds = Array.from(playerMap.keys());
            const { data: profiles } = await supabase
              .from("profiles")
              .select("id, full_name, email, phone, skill_rating, rating_system")
              .in("id", playerIds);

            if (profiles) {
              const linkedIds = new Set(
                (guestData as GuestPlayer[])
                  .filter(g => (g as any).linked_profile_id)
                  .map(g => (g as any).linked_profile_id)
              );

              regPlayers = profiles
                .filter(p => !linkedIds.has(p.id))
                .map(p => ({
                  id: `reg-${p.id}`,
                  full_name: p.full_name || "Unknown",
                  email: p.email || "",
                  phone: (p as any).phone || "",
                  skill_rating: (p as any).skill_rating ?? null,
                  rating_system: (p as any).rating_system || "knltb",
                  has_trained: true,
                  notes: null,
                  created_at: playerMap.get(p.id) || new Date().toISOString(),
                  type: "registered" as const,
                  computedStatus: "registered" as PlayerStatus,
                }));
            }
          }
        }

        setRegisteredPlayers(regPlayers);
      } catch (error: any) {
        logger.error("Error fetching players", error instanceof Error ? error : new Error(String(error)), { component: 'TrainerPlayers' });
        toast({
          title: t("common:error"),
          description: error.message,
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    if (trainerId) fetchPlayers();
  }, [trainerId]);

  // Merge guest + registered players
  useEffect(() => {
    const unified = [
      ...guestPlayers.map(guestToUnified),
      ...registeredPlayers,
    ].sort((a, b) => a.full_name.localeCompare(b.full_name));
    setAllPlayers(unified);
  }, [guestPlayers, registeredPlayers]);

  // Filter
  useEffect(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) {
      setFilteredPlayers(allPlayers);
    } else {
      setFilteredPlayers(
        allPlayers.filter(
          (player) =>
            player.full_name.toLowerCase().includes(query) ||
            player.email.toLowerCase().includes(query) ||
            player.phone.includes(query)
        )
      );
    }
  }, [searchQuery, allPlayers]);

  const handlePlayerCreated = (player: GuestPlayer) => {
    setGuestPlayers(prev => [...prev, player].sort((a, b) =>
      a.full_name.localeCompare(b.full_name)
    ));
    setShowAddPlayer(false);
  };

  const handlePlayersImported = (importedPlayers: GuestPlayer[]) => {
    setGuestPlayers(prev =>
      [...prev, ...importedPlayers].sort((a, b) =>
        a.full_name.localeCompare(b.full_name)
      )
    );
  };

  const handlePlayerUpdated = (updatedPlayer: GuestPlayer) => {
    setGuestPlayers(prev =>
      prev
        .map((p) => (p.id === updatedPlayer.id ? updatedPlayer : p))
        .sort((a, b) => a.full_name.localeCompare(b.full_name))
    );
    setEditingPlayer(null);
  };

  const handleDeletePlayer = async () => {
    if (!deletingPlayer) return;

    setIsDeleting(true);
    try {
      const { error } = await supabase
        .from("guest_players")
        .delete()
        .eq("id", deletingPlayer.id);

      if (error) throw error;

      setGuestPlayers(prev => prev.filter((p) => p.id !== deletingPlayer.id));
      toast({
        title: t("players.playerDeleted"),
        description: t("players.playerDeletedDescription"),
      });
    } catch (error: any) {
      logger.error("Error deleting player", error instanceof Error ? error : new Error(String(error)), { component: 'TrainerPlayers' });
      toast({
        title: t("common:error"),
        description: error.message,
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
      setDeletingPlayer(null);
    }
  };

  if (loading || isLoading) {
    return (
      <div className="container mx-auto px-4 py-6">
        <Skeleton className="h-8 w-48 mb-6" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/app/trainer")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold">{t("players.title")}</h1>
              <p className="text-muted-foreground hidden sm:block">{t("players.subtitle")}</p>
            </div>
          </div>
          <div className="flex gap-2 w-full sm:w-auto">
            <Button variant="outline" className="flex-1 sm:flex-none" onClick={() => setShowImportPlayers(true)}>
              <Upload className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{t("players.import.button")}</span>
              <span className="sm:hidden">Import</span>
            </Button>
            <Button className="flex-1 sm:flex-none" onClick={() => setShowAddPlayer(true)}>
              <UserPlus className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{t("players.addPlayer")}</span>
              <span className="sm:hidden">Add</span>
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("players.searchPlayers")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Players Table */}
        <Card>
          <CardHeader>
            <CardTitle>{t("players.guestPlayers")}</CardTitle>
            <CardDescription>
              {t("players.guestPlayersDescription", { count: filteredPlayers.length })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {filteredPlayers.length === 0 ? (
              <div className="text-center py-12">
                <div className="mx-auto h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                  <UserPlus className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="font-semibold mb-1">
                  {searchQuery ? t("players.noPlayersFound") : t("players.noPlayers")}
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  {searchQuery
                    ? t("players.tryDifferentSearch")
                    : t("players.createFirst")}
                </p>
                {!searchQuery && (
                  <Button onClick={() => setShowAddPlayer(true)}>
                    <UserPlus className="mr-2 h-4 w-4" />
                    {t("players.addPlayer")}
                  </Button>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("players.name")}</TableHead>
                    <TableHead>{t("players.contact")}</TableHead>
                    <TableHead>{t("players.skillRating")}</TableHead>
                    <TableHead>{t("players.status")}</TableHead>
                    <TableHead>{t("players.addedOn")}</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPlayers.map((player) => (
                    <TableRow key={player.id}>
                      <TableCell>
                        <div className="font-medium">{player.full_name}</div>
                        {player.notes && (
                          <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {player.notes}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-1 text-sm">
                            <Mail className="h-3 w-3 text-muted-foreground" />
                            <span>{player.email}</span>
                          </div>
                          <div className="flex items-center gap-1 text-sm">
                            <Phone className="h-3 w-3 text-muted-foreground" />
                            <span>{player.phone}</span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {player.skill_rating ? (
                          <div className="flex items-center gap-1">
                            <Badge variant="secondary">
                              {player.skill_rating.toFixed(1)}
                            </Badge>
                            <span className="text-xs text-muted-foreground uppercase">
                              {player.rating_system || 'knltb'}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {player.type === "registered" ? (
                          <Badge variant="default">
                            {t("players.registered", "Registered")}
                          </Badge>
                        ) : player.has_trained === false ? (
                          <Badge variant="outline">
                            {t("players.prospect")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">
                            {t("players.active")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(player.created_at), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        {player.type === "guest" && player.originalGuest ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setEditingPlayer(player.originalGuest!)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                {t("players.edit")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => navigate(`/trainer/calendar`)}
                              >
                                <Calendar className="mr-2 h-4 w-4" />
                                {t("players.bookLesson")}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setDeletingPlayer(player.originalGuest!)}
                                className="text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                {t("players.delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

      {/* Add Player Dialog */}
      {trainerId && (
        <AddPlayerDialog
          open={showAddPlayer}
          onOpenChange={setShowAddPlayer}
          trainerId={trainerId}
          onPlayerCreated={handlePlayerCreated}
        />
      )}

      {/* Edit Player Dialog */}
      {editingPlayer && (
        <EditPlayerDialog
          open={!!editingPlayer}
          onOpenChange={(open) => !open && setEditingPlayer(null)}
          player={editingPlayer}
          onPlayerUpdated={handlePlayerUpdated}
        />
      )}

      {/* Import Players Dialog */}
      {trainerId && (
        <ImportPlayersDialog
          open={showImportPlayers}
          onOpenChange={setShowImportPlayers}
          trainerId={trainerId}
          onPlayersImported={handlePlayersImported}
        />
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingPlayer} onOpenChange={(open) => !open && setDeletingPlayer(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("players.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("players.deleteConfirmDescription", { name: deletingPlayer?.full_name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeletePlayer}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t("common:deleting") : t("players.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
