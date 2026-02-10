import { useState, useMemo } from "react";
import { useAdminTrainers, useInvalidateAdminData, type TrainerProfileAdmin } from "@/hooks/useAdminData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  Loader2,
  Search,
  MoreHorizontal,
  Pencil,
  Eye,
  EyeOff,
  ExternalLink,
  LogIn,
  Plus,
} from "lucide-react";
import { format } from "date-fns";
import { TrainerEditDialog, type TrainerEditData } from "@/components/admin/TrainerEditDialog";
import { ImpersonateUserDialog } from "@/components/admin/ImpersonateUserDialog";
import { AddTrainerDialog } from "@/components/admin/AddTrainerDialog";
import { SortableTableHead } from "@/components/admin/SortableTableHead";
import { useTableSort } from "@/hooks/useTableSort";

// Extended type to include computed fields for sorting
interface TrainerWithComputedFields extends TrainerProfileAdmin {
  _name: string;
  _subscriptionStatus: string;
}

export default function AdminTrainers() {
  const { invalidateTrainers } = useInvalidateAdminData();
  const { data: trainers = [], isLoading: trainersLoading } = useAdminTrainers();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editingTrainer, setEditingTrainer] = useState<TrainerEditData | null>(null);
  const [impersonatingTrainer, setImpersonatingTrainer] = useState<TrainerProfileAdmin | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const getSubscriptionStatus = (trainer: TrainerProfileAdmin) => {
    if (trainer.subscription_status === "active") return "active";
    if (trainer.subscription_status === "trial") {
      if (!trainer.trial_ends_at) return "trial";
      return new Date(trainer.trial_ends_at) > new Date() ? "trial" : "expired";
    }
    return trainer.subscription_status || "inactive";
  };

  // Convert TrainerProfileAdmin to TrainerEditData
  const toEditData = (trainer: TrainerProfileAdmin): TrainerEditData => ({
    id: trainer.id,
    user_id: trainer.user_id,
    full_name: trainer.full_name,
    email: trainer.email,
    avatar_url: trainer.avatar_url,
    bio: trainer.bio,
    phone: trainer.phone,
    skill_rating: trainer.skill_rating,
    rating_system: trainer.rating_system,
    rating_member_id: trainer.rating_member_id,
    hourly_rate: trainer.hourly_rate,
    coaching_since_year: (trainer as any).coaching_since_year,
    coaching_method: trainer.coaching_method,
    favourite_quote: trainer.favourite_quote,
    video_url: trainer.video_url,
    website_url: trainer.website_url,
    social_instagram: trainer.social_instagram,
    social_tiktok: trainer.social_tiktok,
    social_youtube: trainer.social_youtube,
    social_linkedin: trainer.social_linkedin,
    business_name: trainer.business_name,
    business_address: trainer.business_address,
    kvk_number: trainer.kvk_number,
    btw_number: trainer.btw_number,
    iban: trainer.iban,
    subscription_status: trainer.subscription_status,
    trial_ends_at: trainer.trial_ends_at,
    is_public: trainer.is_public,
    is_verified: trainer.is_verified,
  });

  // Prepare data with computed fields for sorting
  const trainersWithComputed = useMemo(() => {
    return trainers.map((t) => ({
      ...t,
      _name: t.full_name?.toLowerCase() || "",
      _subscriptionStatus: getSubscriptionStatus(t),
    }));
  }, [trainers]);

  const filteredTrainers = trainersWithComputed.filter((t) => {
    const matchesSearch =
      !searchQuery ||
      t.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.email?.toLowerCase().includes(searchQuery.toLowerCase());

    const status = t._subscriptionStatus;
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "public" && t.is_public) ||
      (statusFilter === "private" && !t.is_public) ||
      status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  const { sortedData, sortConfig, handleSort } = useTableSort<TrainerWithComputedFields>(
    filteredTrainers,
    "created_at",
    "desc"
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

  if (trainersLoading) {
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
          <h1 className="text-2xl font-bold tracking-tight">Trainer Management</h1>
          <p className="text-muted-foreground">
            View and manage trainer subscriptions
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Trainer
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
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
            <SelectItem value="all">All trainers</SelectItem>
            <SelectItem value="public">Public</SelectItem>
            <SelectItem value="private">Private</SelectItem>
            <SelectItem value="active">Subscribed</SelectItem>
            <SelectItem value="trial">Trial</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
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
                onSort={(key) => handleSort(key as keyof TrainerWithComputedFields)}
              >
                Trainer
              </SortableTableHead>
              <SortableTableHead
                sortKey="is_public"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof TrainerWithComputedFields)}
              >
                Visibility
              </SortableTableHead>
              <SortableTableHead
                sortKey="_subscriptionStatus"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof TrainerWithComputedFields)}
              >
                Subscription
              </SortableTableHead>
              <SortableTableHead
                sortKey="created_at"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof TrainerWithComputedFields)}
              >
                Joined
              </SortableTableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTrainers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-8 text-muted-foreground"
                >
                  No trainers found
                </TableCell>
              </TableRow>
            ) : (
              sortedData.map((trainer) => {
                const status = trainer._subscriptionStatus;
                return (
                  <TableRow
                    key={trainer.id}
                    className="cursor-pointer"
                    onClick={() => setEditingTrainer(toEditData(trainer))}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-10 w-10 shrink-0">
                          <AvatarImage 
                            src={trainer.avatar_url || undefined} 
                            alt={trainer.full_name || "Trainer"}
                            className="object-cover"
                          />
                          <AvatarFallback className="text-sm font-medium">
                            {trainer.full_name?.[0]?.toUpperCase() || "T"}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {trainer.full_name || "Unknown"}
                          </div>
                          <div className="text-sm text-muted-foreground truncate">
                            {trainer.email || "No email"}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {trainer.is_public ? (
                        <div className="flex items-center gap-1 text-green-600">
                          <Eye className="h-4 w-4" />
                          <span className="text-sm">Public</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <EyeOff className="h-4 w-4" />
                          <span className="text-sm">Private</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(status)}>{status}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(trainer.created_at), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" onClick={(e) => e.stopPropagation()}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditingTrainer(toEditData(trainer))}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit Trainer
                          </DropdownMenuItem>
                          {trainer.is_public && (
                            <DropdownMenuItem
                              onClick={() => window.open(`/en/trainers/${trainer.slug || trainer.id}`, "_blank")}
                            >
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Profile
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => setImpersonatingTrainer(trainer)}>
                            <LogIn className="mr-2 h-4 w-4" />
                            Login as Trainer
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

      {/* Footer */}
      <p className="text-sm text-muted-foreground">
        Showing {filteredTrainers.length} of {trainers.length} trainers
      </p>

      {editingTrainer && (
        <TrainerEditDialog
          open={!!editingTrainer}
          onOpenChange={(open) => !open && setEditingTrainer(null)}
          trainer={editingTrainer}
          onSuccess={() => invalidateTrainers()}
        />
      )}

      {impersonatingTrainer && (
        <ImpersonateUserDialog
          open={!!impersonatingTrainer}
          onOpenChange={(open) => !open && setImpersonatingTrainer(null)}
          targetUserId={impersonatingTrainer.user_id}
          targetUserName={impersonatingTrainer.full_name || "Unknown"}
          targetUserEmail={impersonatingTrainer.email}
        />
      )}

      <AddTrainerDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onSuccess={() => invalidateTrainers()}
      />
    </div>
  );
}
