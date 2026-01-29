import { useState } from "react";
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
  CreditCard,
  Eye,
  EyeOff,
  ExternalLink,
  LogIn,
} from "lucide-react";
import { format } from "date-fns";
import { TrainerSubscriptionEditDialog } from "@/components/admin/TrainerSubscriptionEditDialog";
import { ImpersonateUserDialog } from "@/components/admin/ImpersonateUserDialog";

export default function AdminTrainers() {
  const { invalidateTrainers } = useInvalidateAdminData();
  const { data: trainers = [], isLoading: trainersLoading } = useAdminTrainers();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editingTrainer, setEditingTrainer] = useState<TrainerProfileAdmin | null>(null);
  const [impersonatingTrainer, setImpersonatingTrainer] = useState<TrainerProfileAdmin | null>(null);

  const getSubscriptionStatus = (trainer: TrainerProfileAdmin) => {
    if (trainer.subscription_status === "active") return "active";
    if (trainer.subscription_status === "trial") {
      if (!trainer.trial_ends_at) return "trial";
      return new Date(trainer.trial_ends_at) > new Date() ? "trial" : "expired";
    }
    return trainer.subscription_status || "inactive";
  };

  const filteredTrainers = trainers.filter((t) => {
    const matchesSearch =
      !searchQuery ||
      t.profile?.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.profile?.email?.toLowerCase().includes(searchQuery.toLowerCase());

    const status = getSubscriptionStatus(t);
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "public" && t.is_public) ||
      (statusFilter === "private" && !t.is_public) ||
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
              <TableHead>Trainer</TableHead>
              <TableHead>Visibility</TableHead>
              <TableHead>Subscription</TableHead>
              <TableHead>Joined</TableHead>
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
              filteredTrainers.map((trainer) => {
                const status = getSubscriptionStatus(trainer);
                return (
                  <TableRow 
                    key={trainer.id}
                    className="cursor-pointer"
                    onClick={() => setEditingTrainer(trainer)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-9 w-9">
                          <AvatarImage src={trainer.profile?.avatar_url || undefined} />
                          <AvatarFallback>
                            {trainer.profile?.full_name?.[0]?.toUpperCase() || "T"}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium">
                            {trainer.profile?.full_name || "Unknown"}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {trainer.profile?.email || "No email"}
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
                          <DropdownMenuItem onClick={() => setEditingTrainer(trainer)}>
                            <CreditCard className="mr-2 h-4 w-4" />
                            Edit Trainer
                          </DropdownMenuItem>
                          {trainer.is_public && (
                            <DropdownMenuItem
                              onClick={() => window.open(`/en/trainers/${trainer.id}`, "_blank")}
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
        <TrainerSubscriptionEditDialog
          open={!!editingTrainer}
          onOpenChange={(open) => !open && setEditingTrainer(null)}
          trainerId={editingTrainer.id}
          trainerName={editingTrainer.profile?.full_name || "Unknown"}
          currentData={{
            subscription_status: editingTrainer.subscription_status,
            trial_ends_at: editingTrainer.trial_ends_at,
            is_public: editingTrainer.is_public,
          }}
          onSuccess={() => invalidateTrainers()}
        />
      )}

      {impersonatingTrainer && (
        <ImpersonateUserDialog
          open={!!impersonatingTrainer}
          onOpenChange={(open) => !open && setImpersonatingTrainer(null)}
          targetUserId={impersonatingTrainer.user_id}
          targetUserName={impersonatingTrainer.profile?.full_name || "Unknown"}
          targetUserEmail={impersonatingTrainer.profile?.email}
        />
      )}
    </div>
  );
}
