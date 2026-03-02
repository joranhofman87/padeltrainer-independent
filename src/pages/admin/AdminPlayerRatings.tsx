import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { format, eachMonthOfInterval, startOfMonth, isSameMonth } from "date-fns";
import { Search } from "lucide-react";

interface PlayerRow {
  id: string;
  full_name: string | null;
  rating_member_id: string | null;
  skill_rating: number | null;
}

interface RatingEntry {
  id: string;
  profile_id: string;
  rating: number;
  scraped_at: string;
}

const START_DATE = new Date(2025, 0, 1);

function getMonthColumns(): Date[] {
  const now = new Date();
  if (now < START_DATE) return [];
  return eachMonthOfInterval({ start: START_DATE, end: startOfMonth(now) });
}

function monthKey(date: Date): string {
  return format(date, "yyyy-MM");
}

export default function AdminPlayerRatings() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [editingCell, setEditingCell] = useState<{ profileId: string; month: string } | null>(null);
  const [editValue, setEditValue] = useState("");

  const months = [...getMonthColumns()].reverse();

  const { data: players = [], isLoading: loadingPlayers } = useQuery({
    queryKey: ["admin-rating-players"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, rating_member_id, skill_rating")
        .eq("rating_system", "knltb")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as PlayerRow[];
    },
  });

  const { data: ratingHistory = [] } = useQuery({
    queryKey: ["admin-rating-history"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("player_rating_history")
        .select("id, profile_id, rating, scraped_at")
        .eq("rating_system", "knltb");
      if (error) throw error;
      return (data ?? []) as RatingEntry[];
    },
  });

  // Build lookup: profileId -> monthKey -> rating entry
  const ratingMap = new Map<string, Map<string, RatingEntry>>();
  for (const entry of ratingHistory) {
    if (!ratingMap.has(entry.profile_id)) {
      ratingMap.set(entry.profile_id, new Map());
    }
    const mk = monthKey(new Date(entry.scraped_at));
    ratingMap.get(entry.profile_id)!.set(mk, entry);
  }

  const saveMutation = useMutation({
    mutationFn: async ({ profileId, month, rating }: { profileId: string; month: Date; rating: number }) => {
      const scrapedAt = format(startOfMonth(month), "yyyy-MM-dd");
      const mk = monthKey(month);
      const existing = ratingMap.get(profileId)?.get(mk);

      if (existing) {
        const { error } = await supabase
          .from("player_rating_history")
          .update({ rating })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("player_rating_history")
          .insert({
            profile_id: profileId,
            rating,
            rating_system: "knltb",
            scraped_at: scrapedAt,
            source: "manual",
          });
        if (error) throw error;
      }

      // If this is the latest month (first in reversed array), also update the profile's current rating
      const latestMonth = months[0];
      if (latestMonth && isSameMonth(month, latestMonth)) {
        const { error } = await supabase
          .from("profiles")
          .update({ skill_rating: rating })
          .eq("id", profileId);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-rating-players"] });
      queryClient.invalidateQueries({ queryKey: ["admin-rating-history"] });
      toast.success("Rating saved");
    },
    onError: (err: Error) => {
      toast.error("Failed to save rating: " + err.message);
    },
  });

  const handleCellClick = (profileId: string, month: Date) => {
    const mk = monthKey(month);
    const existing = ratingMap.get(profileId)?.get(mk);
    setEditingCell({ profileId, month: mk });
    setEditValue(existing ? String(existing.rating) : "");
  };

  const handleSave = useCallback(() => {
    if (!editingCell) return;
    const { profileId, month: mk } = editingCell;

    if (editValue.trim() === "") {
      setEditingCell(null);
      return;
    }

    const rating = parseFloat(editValue);
    if (isNaN(rating) || rating < 0.1 || rating > 12) {
      toast.error("Invalid rating (0.1 – 12)");
      return;
    }

    const [year, monthStr] = mk.split("-");
    const monthDate = new Date(parseInt(year), parseInt(monthStr) - 1, 1);

    saveMutation.mutate({ profileId, month: monthDate, rating });
    setEditingCell(null);
  }, [editingCell, editValue, saveMutation]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") setEditingCell(null);
  };

  const filtered = players.filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (p.full_name?.toLowerCase().includes(q)) ||
      (p.rating_member_id?.toLowerCase().includes(q))
    );
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Player Ratings</h1>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name or KNLTB number..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {loadingPlayers ? (
        <p className="text-muted-foreground">Loading players...</p>
      ) : (
        <div className="border rounded-lg overflow-auto max-h-[75vh]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-20 bg-background min-w-[180px]">Name</TableHead>
                <TableHead className="min-w-[120px]">KNLTB #</TableHead>
                <TableHead className="min-w-[90px]">Current</TableHead>
                {months.map((m) => (
                  <TableHead key={monthKey(m)} className="min-w-[90px] text-center">
                    {format(m, "MMM yyyy")}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3 + months.length} className="text-center text-muted-foreground py-8">
                    No players found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((player) => (
                  <TableRow key={player.id}>
                    <TableCell className="sticky left-0 z-10 bg-background font-medium">
                      {player.full_name || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {player.rating_member_id || "—"}
                    </TableCell>
                    <TableCell className="font-mono">
                      {player.skill_rating != null ? player.skill_rating.toFixed(1) : "—"}
                    </TableCell>
                    {months.map((m) => {
                      const mk2 = monthKey(m);
                      const entry = ratingMap.get(player.id)?.get(mk2);
                      const isEditing = editingCell?.profileId === player.id && editingCell?.month === mk2;

                      return (
                        <TableCell key={mk2} className="text-center p-1">
                          {isEditing ? (
                            <Input
                              type="number"
                              step="0.0001"
                              min="0.1"
                              max="12"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onBlur={handleSave}
                              onKeyDown={handleKeyDown}
                              autoFocus
                              className="h-8 w-20 mx-auto text-center"
                            />
                          ) : (
                            <button
                              onClick={() => handleCellClick(player.id, m)}
                              className="w-full h-8 flex items-center justify-center rounded hover:bg-muted/50 transition-colors cursor-pointer font-mono text-sm"
                            >
                              {entry ? entry.rating.toFixed(4) : "—"}
                            </button>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
