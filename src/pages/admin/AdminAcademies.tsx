import { useState, useEffect } from "react";
import { useAdminAcademies, useInvalidateAdminData, type AcademyProfileAdmin } from "@/hooks/useAdminData";
import { logger } from '@/lib/logger';
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
  Loader2,
  Search,
  GraduationCap,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  Pencil,
  Eye,
  ExternalLink,
  LogIn,
  ShieldCheck,
  Trash2,
  Plus,
} from "lucide-react";
import { format } from "date-fns";
import { AcademyEditDialog } from "@/components/admin/AcademyEditDialog";
import { AddAcademyDialog } from "@/components/admin/AddAcademyDialog";
import { ImpersonateUserDialog } from "@/components/admin/ImpersonateUserDialog";
import { SortableTableHead } from "@/components/admin/SortableTableHead";
import { useTableSort } from "@/hooks/useTableSort";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/lib/supabaseClient";

// Extended type to include computed fields for sorting
interface AcademyWithComputedFields extends AcademyProfileAdmin {
  _subscriptionStatus: string;
}

export default function AdminAcademies() {
  const { toast } = useToast();
  const { invalidateAcademies } = useInvalidateAdminData();

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(0);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(0); // Reset to first page on new search
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Reset page when filter changes
  useEffect(() => {
    setPage(0);
  }, [statusFilter]);

  const { data, isLoading: academiesLoading } = useAdminAcademies(debouncedSearch, statusFilter, page);
  const academies = data?.academies ?? [];
  const totalCount = data?.totalCount ?? 0;
  const totalPages = Math.ceil(totalCount / 100);
  const [editingAcademy, setEditingAcademy] = useState<AcademyProfileAdmin | null>(null);
  const [impersonatingAcademy, setImpersonatingAcademy] = useState<AcademyProfileAdmin | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [deletingAcademy, setDeletingAcademy] = useState<AcademyProfileAdmin | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const getSubscriptionStatus = (academy: AcademyProfileAdmin) => {
    if (academy.subscription_status === "active") return "active";
    if (academy.subscription_status === "trial") {
      if (!academy.trial_ends_at) return "trial";
      return new Date(academy.trial_ends_at) > new Date() ? "trial" : "expired";
    }
    return academy.subscription_status || "inactive";
  };

  // Use server-side data directly with client-side sorting
  const { sortedData, sortConfig, handleSort } = useTableSort<AcademyWithComputedFields>(
    academies.map((a) => ({
      ...a,
      _subscriptionStatus: getSubscriptionStatus(a),
    })),
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


  const handleBulkVerify = async () => {
    if (isVerifying) return;

    const unverifiedPublic = academies.filter((a) => a.is_public && !a.is_verified);
    if (unverifiedPublic.length === 0) {
      toast({
        title: "No academies to verify",
        description: "All public academies are already verified.",
      });
      return;
    }

    setIsVerifying(true);
    try {
      const { error } = await supabase
        .from("academy_profiles")
        .update({ is_verified: true })
        .eq("is_public", true)
        .eq("is_verified", false);

      if (error) throw error;

      toast({
        title: "Bulk verify complete",
        description: `${unverifiedPublic.length} academies have been verified.`,
      });
      invalidateAcademies();
    } catch (error) {
      logger.error("Bulk verify error", error instanceof Error ? error : new Error(String(error)), { component: 'AdminAcademies' });
      toast({
        title: "Verification failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleDeleteAcademy = async () => {
    if (!deletingAcademy || isDeleting) return;

    setIsDeleting(true);
    try {
      // Delete related records first (academy_managers, academy_locations, academy_trainers, etc.)
      const { error: managersError } = await supabase
        .from("academy_managers")
        .delete()
        .eq("academy_profile_id", deletingAcademy.id);

      if (managersError) throw managersError;

      const { error: locationsError } = await supabase
        .from("academy_locations")
        .delete()
        .eq("academy_profile_id", deletingAcademy.id);

      if (locationsError) throw locationsError;

      const { error: trainersError } = await supabase
        .from("academy_trainers")
        .delete()
        .eq("academy_profile_id", deletingAcademy.id);

      if (trainersError) throw trainersError;

      const { error: invitationsError } = await supabase
        .from("academy_trainer_invitations")
        .delete()
        .eq("academy_profile_id", deletingAcademy.id);

      if (invitationsError) throw invitationsError;

      const { error: viewsError } = await supabase
        .from("academy_profile_views")
        .delete()
        .eq("academy_profile_id", deletingAcademy.id);

      if (viewsError) throw viewsError;

      const { error: followersError } = await supabase
        .from("academy_followers")
        .delete()
        .eq("academy_profile_id", deletingAcademy.id);

      if (followersError) throw followersError;

      const { error: mollieError } = await supabase
        .from("academy_mollie_accounts")
        .delete()
        .eq("academy_profile_id", deletingAcademy.id);

      if (mollieError) throw mollieError;

      // Finally delete the academy profile
      const { error: profileError } = await supabase
        .from("academy_profiles")
        .delete()
        .eq("id", deletingAcademy.id);

      if (profileError) throw profileError;

      toast({
        title: "Academy deleted",
        description: `${deletingAcademy.name} has been deleted successfully.`,
      });
      invalidateAcademies();
      setDeletingAcademy(null);
    } catch (error) {
      logger.error("Delete academy error", error instanceof Error ? error : new Error(String(error)), { component: 'AdminAcademies' });
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  if (academiesLoading) {
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
          <h1 className="text-2xl font-bold tracking-tight">Academy Management</h1>
          <p className="text-muted-foreground">
            View and manage academies in the system
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={handleBulkVerify}
            disabled={isVerifying}
          >
            {isVerifying ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Verifying...
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4 mr-2" />
                Verify All Public
              </>
            )}
          </Button>
          <Button onClick={() => setIsAddDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Academy
          </Button>
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
            <SelectItem value="all">All academies</SelectItem>
            <SelectItem value="verified">Verified</SelectItem>
            <SelectItem value="unverified">Unverified</SelectItem>
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
                sortKey="name"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof AcademyWithComputedFields)}
              >
                Academy
              </SortableTableHead>
              <SortableTableHead
                sortKey="is_verified"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof AcademyWithComputedFields)}
              >
                Status
              </SortableTableHead>
              <SortableTableHead
                sortKey="_subscriptionStatus"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof AcademyWithComputedFields)}
              >
                Subscription
              </SortableTableHead>
              <SortableTableHead
                sortKey="created_at"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof AcademyWithComputedFields)}
              >
                Created
              </SortableTableHead>
              <TableHead className="w-[50px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedData.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-8 text-muted-foreground"
                >
                  No academies found
                </TableCell>
              </TableRow>
            ) : (
              sortedData.map((academy) => {
                const subscriptionStatus = academy._subscriptionStatus;
                return (
                  <TableRow
                    key={academy.id}
                    className="cursor-pointer"
                    onClick={() => setEditingAcademy(academy)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                          {academy.logo_url ? (
                            <img
                              src={academy.logo_url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <GraduationCap className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        <div>
                          <div className="font-medium">{academy.name}</div>
                          <div className="text-sm text-muted-foreground">
                            {academy.contact_email || academy.slug}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {academy.is_verified ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                        ) : (
                          <XCircle className="h-4 w-4 text-muted-foreground" />
                        )}
                        {academy.is_public ? (
                          <Badge variant="secondary" className="text-xs">
                            <Eye className="h-3 w-3 mr-1" />
                            Public
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">
                            Private
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusBadgeVariant(subscriptionStatus)}>
                        {subscriptionStatus}
                      </Badge>
                      {academy.subscription_tier && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          ({academy.subscription_tier})
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(academy.created_at), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" onClick={(e) => e.stopPropagation()}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditingAcademy(academy)}>
                            <Pencil className="mr-2 h-4 w-4" />
                            Edit Academy
                          </DropdownMenuItem>
                          {academy.is_public && academy.is_verified && (
                            <DropdownMenuItem
                              onClick={() => window.open(`/en/academies/${academy.slug}`, "_blank")}
                            >
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Public Page
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          {academy.owner_user_id ? (
                            <DropdownMenuItem onClick={() => setImpersonatingAcademy(academy)}>
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
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeletingAcademy(academy)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete Academy
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

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {page * 100 + 1}–{Math.min((page + 1) * 100, totalCount)} of {totalCount} academies
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={page + 1 >= totalPages}
          >
            Next
          </Button>
        </div>
      </div>

      {editingAcademy && (
        <AcademyEditDialog
          open={!!editingAcademy}
          onOpenChange={(open) => !open && setEditingAcademy(null)}
          academy={{
            id: editingAcademy.id,
            name: editingAcademy.name,
            slug: editingAcademy.slug,
            description: editingAcademy.description,
            contact_email: editingAcademy.contact_email,
            phone: editingAcademy.phone,
            website_url: editingAcademy.website_url,
            logo_url: editingAcademy.logo_url,
            banner_url: editingAcademy.banner_url,
            social_instagram: editingAcademy.social_instagram,
            social_facebook: editingAcademy.social_facebook,
            social_tiktok: editingAcademy.social_tiktok,
            social_youtube: editingAcademy.social_youtube,
            social_linkedin: editingAcademy.social_linkedin,
            subscription_status: editingAcademy.subscription_status,
            subscription_tier: editingAcademy.subscription_tier,
            trial_ends_at: editingAcademy.trial_ends_at,
            is_verified: editingAcademy.is_verified,
            is_public: editingAcademy.is_public,
            owner_user_id: editingAcademy.owner_user_id,
          }}
          onSuccess={() => invalidateAcademies()}
        />
      )}

      <AddAcademyDialog
        open={isAddDialogOpen}
        onOpenChange={setIsAddDialogOpen}
        onSuccess={() => invalidateAcademies()}
      />

      {impersonatingAcademy && impersonatingAcademy.owner_user_id && (
        <ImpersonateUserDialog
          open={!!impersonatingAcademy}
          onOpenChange={(open) => !open && setImpersonatingAcademy(null)}
          targetUserId={impersonatingAcademy.owner_user_id}
          targetUserName={impersonatingAcademy.name}
          targetUserEmail={impersonatingAcademy.contact_email}
        />
      )}

      <AlertDialog open={!!deletingAcademy} onOpenChange={(open) => !open && setDeletingAcademy(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Academy</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete <strong>{deletingAcademy?.name}</strong>? This will permanently remove the academy and all associated data including trainers, locations, and managers. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAcademy}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete Academy"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
