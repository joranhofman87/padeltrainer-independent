import { useState } from "react";
import { useAdminAcademies, useInvalidateAdminData, type AcademyProfileAdmin } from "@/hooks/useAdminData";
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
  GraduationCap,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  Pencil,
  Eye,
  ExternalLink,
  Download,
  LogIn,
  ShieldCheck,
} from "lucide-react";
import { format } from "date-fns";
import { AcademyEditDialog } from "@/components/admin/AcademyEditDialog";
import { ImpersonateUserDialog } from "@/components/admin/ImpersonateUserDialog";
import { scrapeAcademies } from "@/lib/admin";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

export default function AdminAcademies() {
  const { toast } = useToast();
  const { invalidateAcademies } = useInvalidateAdminData();

  const { data: academies = [], isLoading: academiesLoading } = useAdminAcademies();

  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editingAcademy, setEditingAcademy] = useState<AcademyProfileAdmin | null>(null);
  const [impersonatingAcademy, setImpersonatingAcademy] = useState<AcademyProfileAdmin | null>(null);
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

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

  const handleScrapeAcademies = async () => {
    if (isScraping) return;
    
    setIsScraping(true);
    setScrapeProgress("Starting scrape...");

    try {
      for (let page = 1; page <= 10; page++) {
        setScrapeProgress(`Scraping page ${page}/10...`);
        
        const result = await scrapeAcademies({
          batch_size: 10,
          page_offset: page,
          dry_run: false,
        });

        toast({
          title: `Page ${page} complete`,
          description: `Created: ${result.created}, Skipped: ${result.skipped}, Errors: ${result.errors.length}`,
        });

        if (result.academies.length === 0) {
          break;
        }
      }

      toast({
        title: "Scrape complete",
        description: "Academy import finished successfully",
      });
      invalidateAcademies();
    } catch (error) {
      console.error("Scrape error:", error);
      toast({
        title: "Scrape failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsScraping(false);
      setScrapeProgress(null);
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
      console.error("Bulk verify error:", error);
      toast({
        title: "Verification failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsVerifying(false);
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
            disabled={isVerifying || isScraping}
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
          <Button
            variant="outline"
            onClick={handleScrapeAcademies}
            disabled={isScraping || isVerifying}
          >
            {isScraping ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {scrapeProgress || "Scraping..."}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                Scrape from PadelGids
              </>
            )}
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
        Showing {filteredAcademies.length} of {academies.length} academies
      </p>

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

      {impersonatingAcademy && impersonatingAcademy.owner_user_id && (
        <ImpersonateUserDialog
          open={!!impersonatingAcademy}
          onOpenChange={(open) => !open && setImpersonatingAcademy(null)}
          targetUserId={impersonatingAcademy.owner_user_id}
          targetUserName={impersonatingAcademy.name}
          targetUserEmail={impersonatingAcademy.contact_email}
        />
      )}
    </div>
  );
}
