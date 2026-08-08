import { useState, useEffect } from "react";
import { subscriptionStatusVariant } from '@/lib/adminStatus';
import { useAdminAcademies, useInvalidateAdminData, type AcademyProfileAdmin } from "@/hooks/useAdminData";
import { logger } from '@/lib/logger';
import {
  fetchAcademyDeletionPreview, confirmAcademyDeletion, isPreviewBlocked, isStalePreview,
  nonZeroEntries, totalDeleted, totalDetached, totalMutated, type AcademyDeletionPreview,
} from '@/lib/academyDeletion';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ListPageShell } from "@/components/ui/list-page-shell";
import { TableToolbar } from "@/components/ui/table-toolbar";
import { compactDataTableClass, DataTableCard } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SelectFilter } from "@/components/ui/select-filter";
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Loader2,
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
import { SortableTableHead } from "@/components/ui/sortable-table-head";
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
  const [preview, setPreview] = useState<AcademyDeletionPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
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

  /**
   * Ask the server what deleting this academy would do. The eight client-side deletes this replaces
   * were not a transaction: an academy with a single invoice failed on the LAST of them, after the
   * other seven had committed — leaving it alive with its payment credentials already destroyed.
   */
  const openDeleteDialog = async (academy: AcademyProfileAdmin) => {
    setDeletingAcademy(academy);
    setPreview(null);
    setPreviewError(null);
    setIsPreviewing(true);
    try {
      setPreview(await fetchAcademyDeletionPreview(supabase, academy.id));
    } catch (error) {
      logger.error("Academy deletion preview failed", error instanceof Error ? error : new Error(String(error)), { component: 'AdminAcademies' });
      setPreviewError(error instanceof Error ? error.message : "Could not load the deletion preview.");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleDeleteAcademy = async () => {
    if (!deletingAcademy || !preview || isDeleting || isPreviewBlocked(preview)) return;

    setIsDeleting(true);
    try {
      // Only the server-issued digest and version travel back. Counts are never sent — the server
      // recomputes them under its own locks and would not trust ours.
      await confirmAcademyDeletion(supabase, preview);
      toast({
        title: "Academy deleted",
        description: `${deletingAcademy.name} has been deleted successfully.`,
      });
      invalidateAcademies();
      setDeletingAcademy(null);
      setPreview(null);
    } catch (error) {
      logger.error("Delete academy error", error instanceof Error ? error : new Error(String(error)), { component: 'AdminAcademies' });

      if (isStalePreview(error)) {
        // What the operator was shown is no longer true. Clear the confirmation and make them look
        // at a fresh preview — never retry a destructive action on their behalf.
        setPreview(null);
        setPreviewError("The academy changed while you were reviewing it. Load a fresh preview before deleting.");
        void openDeleteDialog(deletingAcademy);
      }

      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <ListPageShell
      isLoading={academiesLoading}
      title="Academy Management"
      description="View and manage academies in the system"
      actions={
          <>
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
          </>
        }
    >

      <TableToolbar
        searchPlaceholder="Search by name or email..."
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
      >
        <SelectFilter
          value={statusFilter}
          onValueChange={setStatusFilter}
          allLabel="All academies"
          options={[
            { value: "verified", label: "Verified" },
            { value: "unverified", label: "Unverified" },
            { value: "public", label: "Public" },
            { value: "private", label: "Private" },
            { value: "active", label: "Subscribed" },
            { value: "trial", label: "Trial" },
            { value: "expired", label: "Expired" },
          ]}
          placeholder="Filter by status"
          triggerClassName="w-[180px]"
        />
      </TableToolbar>

      {sortedData.length === 0 ? (
        <Card className="overflow-hidden border-border/80 shadow-sm">
          <EmptyState icon={GraduationCap} title="No academies found" />
        </Card>
      ) : (
        <DataTableCard>
          <Table className={compactDataTableClass}>
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
            {sortedData.map((academy) => {
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
                      <Badge variant={subscriptionStatusVariant(subscriptionStatus)}>
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
                          <Button variant="ghost" size="icon" aria-label="Open actions menu" onClick={(e) => e.stopPropagation()}>
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
                            onClick={() => void openDeleteDialog(academy)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete Academy
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
        </DataTableCard>
      )}

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

      <ConfirmDialog
        open={!!deletingAcademy}
        onOpenChange={(open) => { if (!open) { setDeletingAcademy(null); setPreview(null); setPreviewError(null); } }}
        title="Delete Academy"
        description={
          <div className="space-y-3" data-testid="academy-deletion-preview">
            <p>
              Deleting <strong>{deletingAcademy?.name}</strong> cannot be undone.
            </p>

            {isPreviewing && <p data-testid="preview-loading">Checking what this would affect…</p>}

            {previewError && (
              <p className="text-destructive" data-testid="preview-error">{previewError}</p>
            )}

            {preview && isPreviewBlocked(preview) && (
              <div data-testid="preview-blockers">
                <p className="font-medium text-destructive">This academy cannot be deleted yet:</p>
                <ul className="list-disc pl-5">
                  {preview.blockers.map((b) => (
                    <li key={b.code}>{b.code} ({b.count})</li>
                  ))}
                </ul>
              </div>
            )}

            {preview && !isPreviewBlocked(preview) && (
              <div className="space-y-2">
                <div data-testid="preview-deleted">
                  <p className="font-medium">Will be deleted ({totalDeleted(preview)}):</p>
                  <ul className="list-disc pl-5">
                    {nonZeroEntries(preview.deleted).map(([rel, n]) => (
                      <li key={rel}>{rel}: {n}</li>
                    ))}
                  </ul>
                </div>
                <div data-testid="preview-mutated">
                  <p className="font-medium">Will be changed, not deleted ({totalMutated(preview)}):</p>
                  <ul className="ml-4 list-disc">
                    {nonZeroEntries(preview.mutated ?? {}).map(([rel, n]) => (
                      <li key={rel}>{rel}: {n}</li>
                    ))}
                  </ul>
                </div>

                <div data-testid="preview-detached">
                  <p className="font-medium">Will be detached, not deleted ({totalDetached(preview)}):</p>
                  <ul className="list-disc pl-5">
                    {nonZeroEntries(preview.detached).map(([rel, n]) => (
                      <li key={rel}>{rel}: {n}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        }
        confirmLabel={isDeleting ? "Deleting..." : "Delete Academy"}
        cancelLabel="Cancel"
        loading={isDeleting}
        confirmDisabled={!preview || isPreviewing || isPreviewBlocked(preview)}
        onConfirm={handleDeleteAcademy}
      />
    </ListPageShell>
  );
}
