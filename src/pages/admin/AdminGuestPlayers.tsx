import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Registrations</h1>
        <p className="text-muted-foreground">Guest players from intake forms and manual registrations</p>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Registrations</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Converted to Account</CardTitle>
            <UserCheck className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{convertedCount}</div>
            <p className="text-xs text-muted-foreground">
              {totalCount > 0 ? ((convertedCount / totalCount) * 100).toFixed(1) : 0}% conversion rate
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Has Trained</CardTitle>
            <UserCheck className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{trainedCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
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
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
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
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    Loading...
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                    No registrations found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((gp: any) => (
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
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
