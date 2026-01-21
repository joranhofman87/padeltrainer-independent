import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { getAdminStats, isUserAdmin, type AdminStats } from "@/lib/admin";
import { AdminStatsCards } from "@/components/admin/AdminStatsCards";
import { AdminCharts } from "@/components/admin/AdminCharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, ShieldAlert, LogOut, Building2, MapPin, Award } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { signOut } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingClaimsCount, setPendingClaimsCount] = useState(0);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [authLoading, user, navigate]);

  useEffect(() => {
    async function checkAdminAndFetch() {
      if (!user) return;

      const adminStatus = await isUserAdmin(user.id);
      setIsAdmin(adminStatus);

      if (!adminStatus) {
        setLoading(false);
        return;
      }

      try {
        const [data, claimsData] = await Promise.all([
          getAdminStats(),
          supabase
            .from("club_profiles")
            .select("id", { count: "exact", head: true })
            .eq("is_verified", false),
        ]);
        setStats(data);
        setPendingClaimsCount(claimsData.count || 0);
      } catch (error) {
        console.error("Failed to fetch admin stats:", error);
        toast({
          title: "Error",
          description: "Failed to load admin statistics",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    }

    if (user) {
      checkAdminAndFetch();
    }
  }, [user, toast]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await getAdminStats();
      setStats(data);
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
    } finally {
      setRefreshing(false);
    }
  };

  const handleLogout = async () => {
    await signOut();
    navigate("/");
  };

  if (authLoading || loading) {
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
            <p className="text-sm text-muted-foreground">Platform overview and analytics</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
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
            <div className="grid gap-4 md:grid-cols-2">
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
                      <p className="text-sm text-muted-foreground">Review pending club ownership requests</p>
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
                    <p className="text-sm text-muted-foreground">Manage tennis clubs and venues</p>
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
                    <p className="text-sm text-muted-foreground">Manage trainer qualifications</p>
                  </div>
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
                  <div className="text-2xl font-bold" style={{ color: "hsl(var(--chart-4))" }}>2.5%</div>
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
