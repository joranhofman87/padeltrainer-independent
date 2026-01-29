import { useState, useMemo } from "react";
import { useAdminClubs, useInvalidateAdminData, ClubProfileAdmin } from "@/hooks/useAdminData";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Loader2,
  Search,
  Building2,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  CreditCard,
  ExternalLink,
  LogIn,
} from "lucide-react";
import { format } from "date-fns";
import { ClubEditDialog } from "@/components/admin/ClubEditDialog";
import { ImpersonateUserDialog } from "@/components/admin/ImpersonateUserDialog";
import { SortableTableHead } from "@/components/admin/SortableTableHead";
import { useTableSort } from "@/hooks/useTableSort";

// Extended type to include computed fields for sorting
interface ClubWithComputedFields extends ClubProfileAdmin {
  _name: string;
  _city: string;
  _subscriptionStatus: string;
}

export default function AdminClubs() {
  const { invalidateClubs } = useInvalidateAdminData();
  const { data: clubs = [], isLoading: clubsLoading } = useAdminClubs();

  const [searchQuery, setSearchQuery] = useState("");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [cityFilter, setCityFilter] = useState<string>("all");
  const [verifiedFilter, setVerifiedFilter] = useState<string>("all");
  const [paidFilter, setPaidFilter] = useState<string>("all");
  const [editingClub, setEditingClub] = useState<ClubProfileAdmin | null>(null);
  const [impersonatingClub, setImpersonatingClub] = useState<ClubProfileAdmin | null>(null);

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

  // Prepare data with computed fields for sorting
  const clubsWithComputed = useMemo(() => {
    return clubs.map((c) => ({
      ...c,
      _name: c.location?.name?.toLowerCase() || "",
      _city: c.location?.city?.toLowerCase() || "",
      _subscriptionStatus: getSubscriptionStatus(c),
    }));
  }, [clubs]);

  const filteredClubs = clubsWithComputed.filter((c) => {
    const matchesSearch =
      !searchQuery ||
      c.location?.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.location?.city?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesCountry =
      countryFilter === "all" || c.location?.country === countryFilter;

    const matchesCity =
      cityFilter === "all" || c.location?.city === cityFilter;

    const matchesVerified =
      verifiedFilter === "all" ||
      (verifiedFilter === "yes" && c.is_verified) ||
      (verifiedFilter === "no" && !c.is_verified);

    const matchesPaid =
      paidFilter === "all" ||
      (paidFilter === "yes" && isPaid(c)) ||
      (paidFilter === "no" && !isPaid(c));

    return matchesSearch && matchesCountry && matchesCity && matchesVerified && matchesPaid;
  });

  const { sortedData, sortConfig, handleSort } = useTableSort<ClubWithComputedFields>(
    filteredClubs,
    "_name"
  );

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

  if (clubsLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Club Management</h1>
          <p className="text-muted-foreground">
            View and manage clubs in the system
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="space-y-4">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by club or city name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <Select value={countryFilter} onValueChange={(val) => {
            setCountryFilter(val);
            setCityFilter("all");
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

      {/* Data Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                sortKey="_name"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof ClubWithComputedFields)}
              >
                Club
              </SortableTableHead>
              <SortableTableHead
                sortKey="is_verified"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof ClubWithComputedFields)}
              >
                Verified
              </SortableTableHead>
              <SortableTableHead
                sortKey="_subscriptionStatus"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof ClubWithComputedFields)}
              >
                Subscription
              </SortableTableHead>
              <SortableTableHead
                sortKey="created_at"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof ClubWithComputedFields)}
              >
                Created
              </SortableTableHead>
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
              sortedData.map((club) => {
                const status = club._subscriptionStatus;
                return (
                  <TableRow
                    key={club.id}
                    className="cursor-pointer"
                    onClick={() => setEditingClub(club)}
                  >
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
                          <Button variant="ghost" size="icon" onClick={(e) => e.stopPropagation()}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditingClub(club)}>
                            <CreditCard className="mr-2 h-4 w-4" />
                            Edit Club
                          </DropdownMenuItem>
                          {club.location?.slug && (
                            <DropdownMenuItem
                              onClick={() => window.open(`/en/locations/${club.location?.slug}`, "_blank")}
                            >
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Profile
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {club.owner_user_id ? (
                            <DropdownMenuItem onClick={() => setImpersonatingClub(club)}>
                              <LogIn className="mr-2 h-4 w-4" />
                              Login as Manager
                            </DropdownMenuItem>
                          ) : (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <DropdownMenuItem disabled className="opacity-50">
                                    <LogIn className="mr-2 h-4 w-4" />
                                    Login as Manager
                                  </DropdownMenuItem>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p>No manager assigned</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
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

      {/* Footer */}
      <p className="text-sm text-muted-foreground">
        Showing {filteredClubs.length} of {clubs.length} clubs
      </p>

      {editingClub && (
        <ClubEditDialog
          open={!!editingClub}
          onOpenChange={(open) => !open && setEditingClub(null)}
          clubId={editingClub.id}
          clubName={editingClub.location?.name || "Unknown"}
          currentData={{
            subscription_status: editingClub.subscription_status,
            subscription_tier: editingClub.subscription_tier,
            trial_ends_at: editingClub.trial_ends_at,
            is_verified: editingClub.is_verified,
            description: editingClub.description,
            contact_email: editingClub.contact_email,
            phone: editingClub.phone,
            logo_url: editingClub.logo_url,
            banner_url: editingClub.banner_url,
            social_instagram: editingClub.social_instagram,
            social_facebook: editingClub.social_facebook,
            social_tiktok: editingClub.social_tiktok,
            social_youtube: editingClub.social_youtube,
            social_linkedin: editingClub.social_linkedin,
          }}
          onSuccess={() => invalidateClubs()}
        />
      )}

      {impersonatingClub && impersonatingClub.owner_user_id && (
        <ImpersonateUserDialog
          open={!!impersonatingClub}
          onOpenChange={(open) => !open && setImpersonatingClub(null)}
          targetUserId={impersonatingClub.owner_user_id}
          targetUserName={impersonatingClub.location?.name || "Unknown"}
        />
      )}
    </div>
  );
}
