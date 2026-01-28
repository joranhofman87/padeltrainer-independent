import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import {
  useIsAdmin,
  useAdminStats,
  usePendingClaimsCount,
  useInvalidateAdminData,
} from "@/hooks/useAdminData";
import { AdminStatsCards } from "@/components/admin/AdminStatsCards";
import { AdminCharts } from "@/components/admin/AdminCharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  RefreshCw,
  ShieldAlert,
  LogOut,
  Building2,
  MapPin,
  Award,
  Users,
  GraduationCap,
  Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { signOut } from "@/lib/auth";
import { scrapeAcademies, type ScrapeAcademiesParams } from "@/lib/admin";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<string | null>(null);

  const { data: isAdmin, isLoading: isAdminLoading } = useIsAdmin();
  const {
    data: stats,
    isLoading: statsLoading,
    isFetching: statsRefreshing,
  } = useAdminStats();
  const { data: pendingClaimsCount = 0 } = usePendingClaimsCount();
  const { invalidateAll } = useInvalidateAdminData();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  const handleRefresh = async () => {
    try {
      await invalidateAll();
      toast({
        title: "Refreshed",
        description: "Statistics updated successfully",
      });
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to refresh statistics",
        variant: "destructive",
      });
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate("/");
  };

  const handleScrapeAcademies = async () => {
    if (isScraping) return;
    
    setIsScraping(true);
    setScrapeProgress("Starting scrape...");

    try {
      // Run multiple pages
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

        // If no academies found on page, we've reached the end
        if (result.academies.length === 0) {
          break;
        }
      }

      toast({
        title: "Scrape complete",
        description: "Academy import finished successfully",
      });
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

  const loading = authLoading || isAdminLoading || (isAdmin && statsLoading);

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
        <div className="container mx-auto flex items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-2xl font-bold">Admin Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Platform overview and analytics
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={statsRefreshing}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${statsRefreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {stats ? (
          <div className="space-y-8">
            {/* Admin Actions */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div
                className="rounded-lg border bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate("/admin/users")}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">User Management</h3>
                    <p className="text-sm text-muted-foreground">
                      Manage users, roles, and access
                    </p>
                  </div>
                </div>
              </div>
              <div
                className="rounded-lg border bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate("/admin/trainers")}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <GraduationCap className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Trainer Management</h3>
                    <p className="text-sm text-muted-foreground">
                      Manage trainer subscriptions
                    </p>
                  </div>
                </div>
              </div>
              <div
                className="rounded-lg border bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate("/admin/clubs")}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Building2 className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Club Management</h3>
                    <p className="text-sm text-muted-foreground">
                      Manage club subscriptions
                    </p>
                  </div>
                </div>
              </div>
              <div
                className="rounded-lg border bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate("/admin/academies")}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-chart-4/10 flex items-center justify-center">
                    <GraduationCap className="h-5 w-5" style={{ color: "hsl(var(--chart-4))" }} />
                  </div>
                  <div>
                    <h3 className="font-semibold">Academy Management</h3>
                    <p className="text-sm text-muted-foreground">
                      Manage academies and verification
                    </p>
                  </div>
                </div>
              </div>
              <div
                className="rounded-lg border bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate("/admin/club-claims")}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                      <Building2 className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">Club Claims</h3>
                      <p className="text-sm text-muted-foreground">
                        Review pending club ownership requests
                      </p>
                    </div>
                  </div>
                  {pendingClaimsCount > 0 && (
                    <Badge variant="destructive">{pendingClaimsCount} pending</Badge>
                  )}
                </div>
              </div>
              <div
                className="rounded-lg border bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate("/admin/locations")}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <MapPin className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Locations</h3>
                    <p className="text-sm text-muted-foreground">
                      Manage tennis clubs and venues
                    </p>
                  </div>
                </div>
              </div>
              <div
                className="rounded-lg border bg-card p-4 cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => navigate("/admin/certifications")}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Award className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Certifications & Specializations</h3>
                    <p className="text-sm text-muted-foreground">
                      Manage trainer qualifications
                    </p>
                  </div>
                </div>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-chart-4/10 flex items-center justify-center">
                      <Download className="h-5 w-5" style={{ color: "hsl(var(--chart-4))" }} />
                    </div>
                    <div>
                      <h3 className="font-semibold">Scrape Academies</h3>
                      <p className="text-sm text-muted-foreground">
                        {scrapeProgress || "Import from padelgids.nl"}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={handleScrapeAcademies}
                    disabled={isScraping}
                  >
                    {isScraping ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Start"
                    )}
                  </Button>
                </div>
              </div>
            </div>

            <AdminStatsCards stats={stats} />
            <AdminCharts stats={stats} />

            {/* Fee Structure Info */}
            <div className="rounded-lg border bg-card p-6">
              <h2 className="text-lg font-semibold mb-4">Platform Fee Structure</h2>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-lg bg-muted/50 p-4">
                  <div className="text-2xl font-bold text-muted-foreground">10%</div>
                  <div className="text-sm font-medium">Starter Tier</div>
                  <div className="text-xs text-muted-foreground">Free plan</div>
                </div>
                <div className="rounded-lg bg-primary/10 p-4">
                  <div className="text-2xl font-bold text-primary">5%</div>
                  <div className="text-sm font-medium">Professional Tier</div>
                  <div className="text-xs text-muted-foreground">€29/month</div>
                </div>
                <div className="rounded-lg bg-chart-4/10 p-4">
                  <div
                    className="text-2xl font-bold"
                    style={{ color: "hsl(var(--chart-4))" }}
                  >
                    2.5%
                  </div>
                  <div className="text-sm font-medium">Academy Tier</div>
                  <div className="text-xs text-muted-foreground">€79/month</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16">
            <p className="text-muted-foreground">No data available</p>
            <Button variant="outline" onClick={handleRefresh} className="mt-4">
              Try Again
            </Button>
          </div>
        )}
      </main>
    </div>
  );
}
