import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ListPageShell, ListPageState } from "@/components/ui/list-page-shell";
import { TableToolbar } from "@/components/ui/table-toolbar";
import { compactDataTableClass, DataTableCard } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { StatTile } from "@/components/ui/stat-tile";
import { Search, UserCheck, UserX, Users } from "lucide-react";
import { format } from "date-fns";

export default function AdminGuestPlayers() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");

  const { data: guestPlayers = [], isLoading } = useQuery({
    queryKey: ["admin-guest-players"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("guest_players")
        .select(`
          *,
          trainer_profiles:trainer_id (id, business_name, user_id, profiles:user_id (full_name)),
          academy_profiles:academy_profile_id (id, name)
        `)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },
  });

  // Get unique sources for filter
  const sources = [...new Set(guestPlayers.map((g: any) => g.source).filter(Boolean))];

  const filtered = guestPlayers.filter((gp: any) => {
    // Search
    if (search) {
      const q = search.toLowerCase();
      const matchesName = gp.full_name?.toLowerCase().includes(q);
      const matchesEmail = gp.email?.toLowerCase().includes(q);
      if (!matchesName && !matchesEmail) return false;
    }

    // Status filter
    if (statusFilter === "converted" && !gp.linked_profile_id) return false;
    if (statusFilter === "not_converted" && gp.linked_profile_id) return false;

    // Source filter
    if (sourceFilter !== "all" && gp.source !== sourceFilter) return false;

    return true;
  });

  const totalCount = guestPlayers.length;
  const convertedCount = guestPlayers.filter((g: any) => g.linked_profile_id).length;
  const trainedCount = guestPlayers.filter((g: any) => g.has_trained).length;

  const getTrainerName = (gp: any) => {
    if (!gp.trainer_profiles) return "—";
    const tp = gp.trainer_profiles;
    if (tp.business_name) return tp.business_name;
    if (tp.profiles?.full_name) return tp.profiles.full_name;
    return "—";
  };

  const getAcademyName = (gp: any) => {
    return gp.academy_profiles?.name || "—";
  };

  return (
    <ListPageShell
      isLoading={isLoading}
      title="Registrations"
      description="Guest players from intake forms and manual registrations"
    >

      <div className="grid gap-4 md:grid-cols-3">
        <StatTile
          label="Total Registrations"
          value={String(totalCount)}
          icon={Users}
        />
        <StatTile
          label="Converted to Account"
          value={String(convertedCount)}
          icon={UserCheck}
          subtext={
            totalCount > 0
              ? `${((convertedCount / totalCount) * 100).toFixed(1)}% conversion rate`
              : undefined
          }
        />
        <StatTile
          label="Has Trained"
          value={String(trainedCount)}
          icon={UserCheck}
        />
      </div>

      <TableToolbar
        searchPlaceholder="Search by name or email..."
        searchValue={search}
        onSearchChange={setSearch}
      >
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="converted">Converted</SelectItem>
            <SelectItem value="not_converted">Not converted</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {sources.map((s: string) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableToolbar>

      <ListPageState
        isEmpty={filtered.length === 0}
        empty={
          <Card className="overflow-hidden border-border/80 shadow-sm">
            <EmptyState icon={Search} title="No registrations found" />
          </Card>
        }
      >
        <DataTableCard>
          <Table className={compactDataTableClass}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Trainer</TableHead>
                <TableHead>Academy</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((gp: any) => (
                <TableRow key={gp.id}>
                  <TableCell className="font-medium">{gp.full_name}</TableCell>
                  <TableCell>{gp.email || "—"}</TableCell>
                  <TableCell>{gp.phone || "—"}</TableCell>
                  <TableCell>
                    {gp.skill_rating ? (
                      <span>{gp.skill_rating} ({gp.rating_system})</span>
                    ) : "—"}
                  </TableCell>
                  <TableCell>{getTrainerName(gp)}</TableCell>
                  <TableCell>{getAcademyName(gp)}</TableCell>
                  <TableCell>
                    {gp.source ? (
                      <Badge variant="outline" className="text-xs">{gp.source}</Badge>
                    ) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {gp.linked_profile_id ? (
                        <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-200">
                          <UserCheck className="h-3 w-3 mr-1" />
                          Converted
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <UserX className="h-3 w-3 mr-1" />
                          Guest
                        </Badge>
                      )}
                      {gp.has_trained && (
                        <Badge variant="outline" className="text-blue-600 border-blue-200">
                          Trained
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {format(new Date(gp.created_at), "dd MMM yyyy")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTableCard>
      </ListPageState>
    </ListPageShell>
  );
}
