import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin, useAdminClubs, useInvalidateAdminData, ClubProfileAdmin } from "@/hooks/useAdminData";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  Search,
  ArrowLeft,
  ShieldAlert,
  Building2,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  CreditCard,
} from "lucide-react";
import { format } from "date-fns";
import { ClubSubscriptionEditDialog } from "@/components/admin/ClubSubscriptionEditDialog";

export default function AdminClubs() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { invalidateClubs } = useInvalidateAdminData();

  const { data: isAdmin, isLoading: isAdminLoading } = useIsAdmin();
  const { data: clubs = [], isLoading: clubsLoading } = useAdminClubs();

  const [searchQuery, setSearchQuery] = useState("");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [cityFilter, setCityFilter] = useState<string>("all");
  const [verifiedFilter, setVerifiedFilter] = useState<string>("all");
  const [paidFilter, setPaidFilter] = useState<string>("all");
  const [editingClub, setEditingClub] = useState<ClubProfileAdmin | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  // Extract unique countries and cities for filter dropdowns
  const { countries, cities } = useMemo(() => {
    const countrySet = new Set<string>();
    const citySet = new Set<string>();
    clubs.forEach((c) => {
      if (c.location?.country) countrySet.add(c.location.country);
      if (c.location?.city) citySet.add(c.location.city);
    });
    return {
      countries: Array.from(countrySet).sort(),
      cities: Array.from(citySet).sort(),
    };
  }, [clubs]);

  // Filter cities based on selected country
  const filteredCities = useMemo(() => {
    if (countryFilter === "all") return cities;
    return clubs
      .filter((c) => c.location?.country === countryFilter)
      .map((c) => c.location?.city)
      .filter((city): city is string => !!city)
      .filter((city, index, arr) => arr.indexOf(city) === index)
      .sort();
  }, [clubs, countryFilter, cities]);

  const getSubscriptionStatus = (club: ClubProfileAdmin) => {
    if (club.subscription_status === "active") return "active";
    if (club.subscription_status === "trial") {
      if (!club.trial_ends_at) return "trial";
      return new Date(club.trial_ends_at) > new Date() ? "trial" : "expired";
    }
    return club.subscription_status || "inactive";
  };

  const isPaid = (club: ClubProfileAdmin) => {
    return club.subscription_status === "active";
  };

  const filteredClubs = clubs.filter((c) => {
    // Search filter
    const matchesSearch =
      !searchQuery ||
      c.location?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.location?.city?.toLowerCase().includes(searchQuery.toLowerCase());

    // Country filter
    const matchesCountry =
      countryFilter === "all" || c.location?.country === countryFilter;

    // City filter
    const matchesCity =
      cityFilter === "all" || c.location?.city === cityFilter;

    // Verified filter
    const matchesVerified =
      verifiedFilter === "all" ||
      (verifiedFilter === "yes" && c.is_verified) ||
      (verifiedFilter === "no" && !c.is_verified);

    // Paid filter
    const matchesPaid =
      paidFilter === "all" ||
      (paidFilter === "yes" && isPaid(c)) ||
      (paidFilter === "no" && !isPaid(c));

    return matchesSearch && matchesCountry && matchesCity && matchesVerified && matchesPaid;
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
        {/* Filters */}
        <div className="mb-6 space-y-4">
          {/* Search */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by club or city name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Filter row */}
          <div className="flex flex-wrap gap-3">
            {/* Country filter */}
            <Select value={countryFilter} onValueChange={(val) => {
              setCountryFilter(val);
              setCityFilter("all"); // Reset city when country changes
            }}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Country" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All countries</SelectItem>
                {countries.map((country) => (
                  <SelectItem key={country} value={country}>
                    {country}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* City filter */}
            <Select value={cityFilter} onValueChange={setCityFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="City" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All cities</SelectItem>
                {filteredCities.map((city) => (
                  <SelectItem key={city} value={city}>
                    {city}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Verified filter */}
            <Select value={verifiedFilter} onValueChange={setVerifiedFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Verified" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="yes">Verified</SelectItem>
                <SelectItem value="no">Unverified</SelectItem>
              </SelectContent>
            </Select>

            {/* Paid filter */}
            <Select value={paidFilter} onValueChange={setPaidFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Paid" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="yes">Paid</SelectItem>
                <SelectItem value="no">Unpaid</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Club</TableHead>
                <TableHead>Verified</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredClubs.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
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
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditingClub(club)}>
                              <CreditCard className="mr-2 h-4 w-4" />
                              Edit Subscription
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
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

      {editingClub && (
        <ClubSubscriptionEditDialog
          open={!!editingClub}
          onOpenChange={(open) => !open && setEditingClub(null)}
          clubId={editingClub.id}
          clubName={editingClub.location?.name || "Unknown"}
          currentData={{
            subscription_status: editingClub.subscription_status,
            subscription_tier: editingClub.subscription_tier,
            trial_ends_at: editingClub.trial_ends_at,
          }}
          onSuccess={() => invalidateClubs()}
        />
      )}
    </div>
  );
}
