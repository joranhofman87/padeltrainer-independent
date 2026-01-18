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

export default function TrainerPlayers() {
  const { t } = useTranslation("trainer");
  const { user, role, loading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [players, setPlayers] = useState<GuestPlayer[]>([]);
  const [filteredPlayers, setFilteredPlayers] = useState<GuestPlayer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [trainerId, setTrainerId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showImportPlayers, setShowImportPlayers] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<GuestPlayer | null>(null);
  const [deletingPlayer, setDeletingPlayer] = useState<GuestPlayer | null>(null);
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
    const fetchPlayers = async () => {
      if (!trainerId) return;

      setIsLoading(true);
      try {
        const { data, error } = await supabase
          .from("guest_players")
          .select("*")
          .eq("trainer_id", trainerId)
          .order("full_name");

        if (error) throw error;
        setPlayers(data as GuestPlayer[]);
        setFilteredPlayers(data as GuestPlayer[]);
      } catch (error: any) {
        console.error("Error fetching players:", error);
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

  useEffect(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) {
      setFilteredPlayers(players);
    } else {
      setFilteredPlayers(
        players.filter(
          (player) =>
            player.full_name.toLowerCase().includes(query) ||
            player.email.toLowerCase().includes(query) ||
            player.phone.includes(query)
        )
      );
    }
  }, [searchQuery, players]);

  const handlePlayerCreated = (player: GuestPlayer) => {
    setPlayers([...players, player].sort((a, b) =>
      a.full_name.localeCompare(b.full_name)
    ));
    setShowAddPlayer(false);
  };

  const handlePlayersImported = (importedPlayers: GuestPlayer[]) => {
    setPlayers(
      [...players, ...importedPlayers].sort((a, b) =>
        a.full_name.localeCompare(b.full_name)
      )
    );
  };

  const handlePlayerUpdated = (updatedPlayer: GuestPlayer) => {
    setPlayers(
      players
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

      setPlayers(players.filter((p) => p.id !== deletingPlayer.id));
      toast({
        title: t("players.playerDeleted"),
        description: t("players.playerDeletedDescription"),
      });
    } catch (error: any) {
      console.error("Error deleting player:", error);
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
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-6">
          <Skeleton className="h-8 w-48 mb-6" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate("/trainer")}>
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
                              {(player as any).rating_system || 'knltb'}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format(new Date(player.created_at), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditingPlayer(player)}>
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
                              onClick={() => setDeletingPlayer(player)}
                              className="text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              {t("players.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

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
