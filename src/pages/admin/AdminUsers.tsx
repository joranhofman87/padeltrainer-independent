import { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useAdminUsers, useInvalidateAdminData } from "@/hooks/useAdminData";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Loader2,
  Search,
  LogIn,
  Trash2,
  Pencil,
  Percent,
} from "lucide-react";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useAuth } from "@/hooks/useAuth";
import { SortableTableHead } from "@/components/admin/SortableTableHead";
import { useTableSort } from "@/hooks/useTableSort";
import { logger } from "@/lib/logger";

interface UserDiscount {
  id: string;
  discount_percent: number;
  duration_months: number;
  months_remaining: number;
  source: string;
  is_active: boolean;
  first_payment_at: string | null;
}

interface UserWithRole {
  user_id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  created_at: string;
  role: string | null;
  discount: UserDiscount | null;
}

// Extended type for sorting
interface UserWithComputedFields extends UserWithRole {
  _name: string;
}

export default function AdminUsers() {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { toast } = useToast();

  const { data: users = [], isLoading: usersLoading } = useAdminUsers();
  const { invalidateUsers } = useInvalidateAdminData();

  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>(
    searchParams.get("role") || "all"
  );
  const [selectedUser, setSelectedUser] = useState<UserWithRole | null>(null);
  const [newRole, setNewRole] = useState<string>("");
  const [impersonateDialogOpen, setImpersonateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Bulk selection state
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [bulkDeleteConfirmText, setBulkDeleteConfirmText] = useState("");
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState<{ current: number; total: number } | null>(null);

  // Discount state
  const [discountPercent, setDiscountPercent] = useState("");
  const [discountMonths, setDiscountMonths] = useState("");

  const handleChangeRole = async () => {
    if (!selectedUser || !newRole) return;

    setActionLoading(true);
    try {
      if (newRole === "none") {
        const { error } = await supabase
          .from("user_roles")
          .delete()
          .eq("user_id", selectedUser.user_id);

        if (error) throw error;
      } else {
        const { data: existingRole } = await supabase
          .from("user_roles")
          .select("id")
          .eq("user_id", selectedUser.user_id)
          .single();

        if (existingRole) {
          const { error } = await supabase
            .from("user_roles")
            .update({
              role: newRole as "admin" | "player" | "trainer" | "club_manager",
            })
            .eq("user_id", selectedUser.user_id);

          if (error) throw error;
        } else {
          const { error } = await supabase.from("user_roles").insert({
            user_id: selectedUser.user_id,
            role: newRole as "admin" | "player" | "trainer" | "club_manager",
          });

          if (error) throw error;
        }
      }

      toast({
        title: "Role updated",
        description: `${selectedUser.full_name || selectedUser.email}'s role has been updated.`,
      });

      await invalidateUsers();
    } catch (error: any) {
      logger.error("Failed to update role", error as Error, { component: "AdminUsers", userId: selectedUser?.user_id });
      toast({
        title: "Error",
        description: error.message || "Failed to update role",
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleImpersonate = async () => {
    if (!selectedUser) return;

    setActionLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("impersonate-user", {
        body: { target_user_id: selectedUser.user_id },
      });

      if (error) throw error;

      if (data?.url) {
        localStorage.setItem("impersonation_admin_id", user?.id || "");
        window.open(data.url, "_blank");

        toast({
          title: "Impersonation link generated",
          description: "A new tab has been opened with the impersonation session.",
        });
      }

      setImpersonateDialogOpen(false);
      setSelectedUser(null);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to generate impersonation link";
      logger.error("Failed to impersonate", error as Error, { component: "AdminUsers", targetUserId: selectedUser?.user_id });
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!selectedUser || deleteConfirmText !== "DELETE") return;

    setActionLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("delete-user", {
        body: { target_user_id: selectedUser.user_id },
      });

      if (error) throw error;

      toast({
        title: "User deleted",
        description: `${selectedUser.full_name || selectedUser.email} has been permanently deleted.`,
      });

      await invalidateUsers();
      setDeleteDialogOpen(false);
      setSelectedUser(null);
      setDeleteConfirmText("");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to delete user";
      logger.error("Failed to delete user", error as Error, { component: "AdminUsers", userId: selectedUser?.user_id });
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    if (bulkDeleteConfirmText !== "DELETE" || selectedUserIds.size === 0) return;

    setActionLoading(true);
    setBulkDeleteProgress({ current: 0, total: selectedUserIds.size });

    const userIdsArray = Array.from(selectedUserIds);
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < userIdsArray.length; i++) {
      const userId = userIdsArray[i];
      try {
        const { error } = await supabase.functions.invoke("delete-user", {
          body: { target_user_id: userId },
        });
        if (error) throw error;
        successCount++;
      } catch (error) {
        logger.error("Failed to delete user in bulk", error as Error, { component: "AdminUsers", userId });
        failCount++;
      }
      setBulkDeleteProgress({ current: i + 1, total: userIdsArray.length });
    }

    toast({
      title: "Bulk delete complete",
      description: `${successCount} users deleted${failCount > 0 ? `, ${failCount} failed` : ""}.`,
      variant: failCount > 0 ? "destructive" : "default",
    });

    await invalidateUsers();
    setSelectedUserIds(new Set());
    setBulkDeleteDialogOpen(false);
    setBulkDeleteConfirmText("");
    setBulkDeleteProgress(null);
    setActionLoading(false);
  };

  const toggleUserSelection = (userId: string) => {
    setSelectedUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    const selectableUsers = sortedData.filter((u) => u.role !== "admin");
    if (selectedUserIds.size === selectableUsers.length) {
      setSelectedUserIds(new Set());
    } else {
      setSelectedUserIds(new Set(selectableUsers.map((u) => u.user_id)));
    }
  };

  const handleEditUser = async () => {
    if (!selectedUser) return;

    setActionLoading(true);
    try {
      const { error } = await supabase.functions.invoke("update-user", {
        body: {
          target_user_id: selectedUser.user_id,
          email: editEmail !== selectedUser.email ? editEmail : undefined,
          full_name: editName,
        },
      });

      if (error) throw error;

      toast({
        title: "User updated",
        description: "User details have been updated successfully.",
      });

      await invalidateUsers();
      setEditDialogOpen(false);
      setSelectedUser(null);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to update user";
      logger.error("Failed to update user", error as Error, { component: "AdminUsers", userId: selectedUser?.user_id });
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!selectedUser || !newPassword) return;

    if (newPassword.length < 6) {
      toast({
        title: "Error",
        description: "Password must be at least 6 characters",
        variant: "destructive",
      });
      return;
    }

    setActionLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("admin-reset-password", {
        body: { target_user_id: selectedUser.user_id, new_password: newPassword },
      });

      if (error) throw error;

      toast({
        title: "Password updated",
        description: `Password has been updated for ${data?.email || selectedUser.email}.`,
      });

      setNewPassword("");
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to update password";
      logger.error("Failed to reset password", error as Error, { component: "AdminUsers", userId: selectedUser?.user_id });
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveDiscount = async () => {
    if (!selectedUser) return;
    const percent = parseInt(discountPercent);
    const months = parseInt(discountMonths);
    if (!percent || !months || percent < 1 || percent > 100 || months < 1) {
      toast({ title: "Error", description: "Enter valid percentage (1-100) and months (≥1)", variant: "destructive" });
      return;
    }

    setActionLoading(true);
    try {
      const existing = selectedUser.discount;
      if (existing) {
        const { error } = await supabase
          .from("user_discounts")
          .update({ discount_percent: percent, duration_months: months, months_remaining: months, is_active: true, first_payment_at: null })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("user_discounts")
          .insert({ user_id: selectedUser.user_id, discount_percent: percent, duration_months: months, months_remaining: months, created_by: user?.id || null });
        if (error) throw error;
      }

      toast({ title: "Discount saved", description: `${percent}% for ${months} months` });
      await invalidateUsers();
      await invalidateUsers();
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Failed to save discount", variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  const handleRemoveDiscount = async () => {
    if (!selectedUser?.discount) return;
    setActionLoading(true);
    try {
      const { error } = await supabase.from("user_discounts").delete().eq("id", selectedUser.discount.id);
      if (error) throw error;
      toast({ title: "Discount removed" });
      await invalidateUsers();
      await invalidateUsers();
    } catch (error: any) {
      toast({ title: "Error", description: error.message || "Failed to remove discount", variant: "destructive" });
    } finally {
      setActionLoading(false);
    }
  };

  // Prepare data with computed fields for sorting
  const usersWithComputed = useMemo(() => {
    return users.map((u) => ({
      ...u,
      _name: (u.full_name || u.email || "").toLowerCase(),
    }));
  }, [users]);

  const filteredUsers = usersWithComputed.filter((u) => {
    const matchesSearch =
      !searchQuery ||
      u.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.full_name?.toLowerCase().includes(searchQuery.toLowerCase());

    const matchesRole =
      roleFilter === "all" ||
      (roleFilter === "none" && !u.role) ||
      u.role === roleFilter;

    return matchesSearch && matchesRole;
  });

  const { sortedData, sortConfig, handleSort } = useTableSort<UserWithComputedFields>(
    filteredUsers,
    "created_at",
    "desc"
  );

  const getRoleBadgeVariant = (role: string | null) => {
    switch (role) {
      case "admin":
        return "destructive";
      case "trainer":
        return "default";
      case "player":
        return "secondary";
      default:
        return "outline";
    }
  };

  if (usersLoading) {
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
          <h1 className="text-2xl font-bold tracking-tight">User Management</h1>
          <p className="text-muted-foreground">
            Manage users, roles, and access
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
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="trainer">Trainer</SelectItem>
            <SelectItem value="player">Player</SelectItem>
            <SelectItem value="none">No role</SelectItem>
          </SelectContent>
        </Select>
        {selectedUserIds.size > 0 && (
          <Button
            variant="destructive"
            onClick={() => setBulkDeleteDialogOpen(true)}
            className="ml-auto"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete {selectedUserIds.size} users
          </Button>
        )}
      </div>

      {/* Data Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">
                <Checkbox
                  checked={
                    sortedData.filter((u) => u.role !== "admin").length > 0 &&
                    selectedUserIds.size === sortedData.filter((u) => u.role !== "admin").length
                  }
                  onCheckedChange={toggleSelectAll}
                />
              </TableHead>
              <SortableTableHead
                sortKey="_name"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof UserWithComputedFields)}
              >
                User
              </SortableTableHead>
              <SortableTableHead
                sortKey="role"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof UserWithComputedFields)}
              >
                Role
              </SortableTableHead>
              <TableHead>Discount</TableHead>
              <SortableTableHead
                sortKey="created_at"
                currentSortKey={sortConfig.key as string}
                currentDirection={sortConfig.direction}
                onSort={(key) => handleSort(key as keyof UserWithComputedFields)}
              >
                Joined
              </SortableTableHead>
              <TableHead className="w-[70px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredUsers.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center py-8 text-muted-foreground"
                >
                  No users found
                </TableCell>
              </TableRow>
            ) : (
              sortedData.map((u) => (
                <TableRow 
                  key={u.user_id} 
                  className={`cursor-pointer ${selectedUserIds.has(u.user_id) ? "bg-muted/50" : ""}`}
                  onClick={() => {
                    setSelectedUser(u);
                    setEditName(u.full_name || "");
                    setEditEmail(u.email || "");
                    setNewRole(u.role || "none");
                    setNewPassword("");
                    setDiscountPercent(u.discount?.discount_percent?.toString() || "");
                    setDiscountMonths(u.discount?.duration_months?.toString() || "");
                    setEditDialogOpen(true);
                  }}
                >
                  <TableCell>
                    {u.role !== "admin" ? (
                      <Checkbox
                        checked={selectedUserIds.has(u.user_id)}
                        onCheckedChange={() => toggleUserSelection(u.user_id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center overflow-hidden">
                        {u.avatar_url ? (
                          <img
                            src={u.avatar_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="text-sm font-medium">
                            {(u.full_name || u.email || "?")[0].toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div>
                        <div className="font-medium">{u.full_name || "No name"}</div>
                        <div className="text-sm text-muted-foreground">{u.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={getRoleBadgeVariant(u.role)}>
                      {u.role || "No role"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {u.discount?.is_active ? (
                      <Badge variant="outline" className="text-xs">
                        {u.discount.discount_percent}% / {u.discount.months_remaining}mo left
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format(new Date(u.created_at), "MMM d, yyyy")}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedUser(u);
                        setEditName(u.full_name || "");
                        setEditEmail(u.email || "");
                        setNewRole(u.role || "none");
                        setNewPassword("");
                        setDiscountPercent(u.discount?.discount_percent?.toString() || "");
                        setDiscountMonths(u.discount?.duration_months?.toString() || "");
                        setEditDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Footer */}
      <p className="text-sm text-muted-foreground">
        Showing {filteredUsers.length} of {users.length} users
      </p>

      {/* Combined Edit User Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              {selectedUser?.full_name || selectedUser?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {/* User Details Section */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Details</h4>
              <div className="space-y-2">
                <Label htmlFor="edit-name">Full Name</Label>
                <Input
                  id="edit-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-email">Email</Label>
                <Input
                  id="edit-email"
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                />
              </div>
              <Button onClick={handleEditUser} disabled={actionLoading} size="sm">
                {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Details
              </Button>
            </div>

            <div className="border-t" />

            {/* Role Section */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Role</h4>
              <div className="flex items-center gap-2">
                <Select value={newRole} onValueChange={setNewRole}>
                  <SelectTrigger className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Admin</SelectItem>
                    <SelectItem value="trainer">Trainer</SelectItem>
                    <SelectItem value="player">Player</SelectItem>
                    <SelectItem value="none">No role</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={handleChangeRole} disabled={actionLoading} size="sm">
                  {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Update
                </Button>
              </div>
            </div>

            <div className="border-t" />

            {/* Discount Section */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Discount</h4>
              {selectedUser?.discount?.is_active && (
                <p className="text-xs text-muted-foreground">
                  Current: {selectedUser.discount.discount_percent}% — {selectedUser.discount.months_remaining}/{selectedUser.discount.duration_months} months remaining
                  {selectedUser.discount.first_payment_at && ` (started ${format(new Date(selectedUser.discount.first_payment_at), "MMM d, yyyy")})`}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="discount-percent" className="text-xs">Percentage</Label>
                  <Input
                    id="discount-percent"
                    type="number"
                    min="1"
                    max="100"
                    value={discountPercent}
                    onChange={(e) => setDiscountPercent(e.target.value)}
                    placeholder="e.g. 20"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="discount-months" className="text-xs">Months</Label>
                  <Input
                    id="discount-months"
                    type="number"
                    min="1"
                    value={discountMonths}
                    onChange={(e) => setDiscountMonths(e.target.value)}
                    placeholder="e.g. 6"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={handleSaveDiscount} disabled={actionLoading} size="sm">
                  {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Discount
                </Button>
                {selectedUser?.discount && (
                  <Button variant="outline" size="sm" onClick={handleRemoveDiscount} disabled={actionLoading}>
                    Remove
                  </Button>
                )}
              </div>
            </div>

            <div className="border-t" />

            {/* Reset Password Section */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Reset Password</h4>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (min 6 chars)"
                  className="flex-1"
                />
                <Button onClick={handleResetPassword} disabled={actionLoading || newPassword.length < 6} size="sm">
                  {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Reset
                </Button>
              </div>
            </div>

            {selectedUser?.role !== "admin" && (
              <>
                <div className="border-t" />

                {/* Actions Section */}
                <div className="space-y-3">
                  <h4 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Actions</h4>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setImpersonateDialogOpen(true)}
                    >
                      <LogIn className="mr-2 h-4 w-4" />
                      Login as user
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteDialogOpen(true)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete user
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Impersonate Dialog */}
      <AlertDialog open={impersonateDialogOpen} onOpenChange={setImpersonateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Login as User</AlertDialogTitle>
            <AlertDialogDescription>
              This will generate a secure link to access the platform as {selectedUser?.full_name || selectedUser?.email}.
              All actions will be logged for audit purposes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setImpersonateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleImpersonate} disabled={actionLoading}>
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate Link
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete User Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              This action is permanent and cannot be undone. Type DELETE to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-4">
            <Input
              placeholder="Type DELETE to confirm"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => {
              setDeleteDialogOpen(false);
              setDeleteConfirmText("");
            }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteUser}
              disabled={actionLoading || deleteConfirmText !== "DELETE"}
            >
              {actionLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete User
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
