import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useIsAdmin, useAdminAcademies, useInvalidateAdminData, type AcademyProfileAdmin } from "@/hooks/useAdminData";
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
  Loader2,
  Search,
  ArrowLeft,
  ShieldAlert,
  GraduationCap,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  CreditCard,
  Eye,
  ExternalLink,
} from "lucide-react";
import { format } from "date-fns";
import { AcademySubscriptionEditDialog } from "@/components/admin/AcademySubscriptionEditDialog";

export default function AdminAcademies() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { invalidateAcademies } = useInvalidateAdminData();

  const { data: isAdmin, isLoading: isAdminLoading } = useIsAdmin();
  const { data: academies = [], isLoading: academiesLoading } = useAdminAcademies();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editingAcademy, setEditingAcademy] = useState<AcademyProfileAdmin | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  const getSubscriptionStatus = (academy: AcademyProfileAdmin) => {
    if (academy.subscription_status === "active") return "active";
    if (academy.subscription_status === "trial") {
      if (!academy.trial_ends_at) return "trial";
      return new Date(academy.trial_ends_at) > new Date() ? "trial" : "expired";
    }
    return academy.subscription_status || "inactive";
  };

  const filteredAcademies = academies.filter((a) => {
    const matchesSearch =
      !searchQuery ||
      a.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.contact_email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.slug?.toLowerCase().includes(searchQuery.toLowerCase());

    const status = getSubscriptionStatus(a);
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "verified" && a.is_verified) ||
      (statusFilter === "unverified" && !a.is_verified) ||
      (statusFilter === "public" && a.is_public) ||
      (statusFilter === "private" && !a.is_public) ||
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

  const loading = authLoading || isAdminLoading || (isAdmin && academiesLoading);

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
            <h1 className="text-2xl font-bold">Academy Management</h1>
            <p className="text-sm text-muted-foreground">
              View and manage academies in the system
            </p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
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

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Academy</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Subscription</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAcademies.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-center py-8 text-muted-foreground"
                  >
                    No academies found
                  </TableCell>
                </TableRow>
              ) : (
                filteredAcademies.map((academy) => {
                  const subscriptionStatus = getSubscriptionStatus(academy);
                  return (
                    <TableRow key={academy.id}>
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
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditingAcademy(academy)}>
                              <CreditCard className="mr-2 h-4 w-4" />
                              Edit Academy
                            </DropdownMenuItem>
                            {academy.is_public && academy.is_verified && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => window.open(`/en/academies/${academy.slug}`, "_blank")}
                                >
                                  <ExternalLink className="mr-2 h-4 w-4" />
                                  View Public Page
                                </DropdownMenuItem>
                              </>
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

        <div className="mt-4 text-sm text-muted-foreground">
          Showing {filteredAcademies.length} of {academies.length} academies
        </div>
      </main>

      {editingAcademy && (
        <AcademySubscriptionEditDialog
          open={!!editingAcademy}
          onOpenChange={(open) => !open && setEditingAcademy(null)}
          academyId={editingAcademy.id}
          academyName={editingAcademy.name}
          currentData={{
            subscription_status: editingAcademy.subscription_status,
            subscription_tier: editingAcademy.subscription_tier,
            trial_ends_at: editingAcademy.trial_ends_at,
            is_verified: editingAcademy.is_verified,
            is_public: editingAcademy.is_public,
          }}
          onSuccess={() => invalidateAcademies()}
        />
      )}
    </div>
  );
}
