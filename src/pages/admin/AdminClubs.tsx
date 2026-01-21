import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin, useAdminClubs } from "@/hooks/useAdminData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Search,
  ArrowLeft,
  ShieldAlert,
  Building2,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { format } from "date-fns";

interface ClubProfile {
  id: string;
  is_verified: boolean;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  created_at: string;
  location: {
    name: string;
    city: string;
  } | null;
}

export default function AdminClubs() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const { data: isAdmin, isLoading: isAdminLoading } = useIsAdmin();
  const { data: clubs = [], isLoading: clubsLoading } = useAdminClubs();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  const getSubscriptionStatus = (club: ClubProfile) => {
    if (club.subscription_status === "active") return "active";
    if (club.subscription_status === "trial") {
      if (!club.trial_ends_at) return "trial";
      return new Date(club.trial_ends_at) > new Date() ? "trial" : "expired";
    }
    return club.subscription_status || "inactive";
  };

  const filteredClubs = clubs.filter((c) => {
    const matchesSearch =
      !searchQuery ||
      c.location?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.location?.city?.toLowerCase().includes(searchQuery.toLowerCase());

    const status = getSubscriptionStatus(c);
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "verified" && c.is_verified) ||
      (statusFilter === "unverified" && !c.is_verified) ||
      status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const getStatusBadgeVariant = (status: string) => {
    switch (status) {
      case "active":
        return "default";
      case "trial":
        return "secondary";
      case "expired":
        return "destructive";
      default:
        return "outline";
    }
  };

  const loading = authLoading || isAdminLoading || (isAdmin && clubsLoading);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <ShieldAlert className="h-16 w-16 text-destructive" />
        <h1 className="text-2xl font-bold">Access Denied</h1>
        <p className="text-muted-foreground">You don't have admin privileges.</p>
        <Button onClick={() => navigate("/")}>Go Home</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto flex items-center gap-4 px-4 py-4">
          <Button variant="ghost" size="icon" onClick={() => navigate("/admin")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Club Management</h1>
            <p className="text-sm text-muted-foreground">
              View and manage clubs in the system
            </p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by club or city name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clubs</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
              <SelectItem value="unverified">Unverified</SelectItem>
              <SelectItem value="active">Subscribed</SelectItem>
              <SelectItem value="trial">Trial</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Club</TableHead>
                <TableHead>Verified</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredClubs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No clubs found
                  </TableCell>
                </TableRow>
              ) : (
                filteredClubs.map((club) => {
                  const status = getSubscriptionStatus(club);
                  return (
                    <TableRow key={club.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center">
                            <Building2 className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <div>
                            <div className="font-medium">
                              {club.location?.name || "Unknown"}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              {club.location?.city || "Unknown city"}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {club.is_verified ? (
                          <CheckCircle2 className="h-5 w-5 text-green-500" />
                        ) : (
                          <XCircle className="h-5 w-5 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={getStatusBadgeVariant(status)}>{status}</Badge>
                        {club.subscription_tier && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ({club.subscription_tier})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {format(new Date(club.created_at), "MMM d, yyyy")}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <div className="mt-4 text-sm text-muted-foreground">
          Showing {filteredClubs.length} of {clubs.length} clubs
        </div>
      </main>
    </div>
  );
}
