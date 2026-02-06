import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import {
  useAdminStats,
  useInvalidateAdminData,
} from "@/hooks/useAdminData";
import { AdminStatsCards } from "@/components/admin/AdminStatsCards";
import { AdminCharts } from "@/components/admin/AdminCharts";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function AdminDashboard() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();

  const {
    data: stats,
    isLoading: statsLoading,
    isFetching: statsRefreshing,
    error: statsError,
  } = useAdminStats();
  const { invalidateAll } = useInvalidateAdminData();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/app/auth");
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

  if (statsLoading) {
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
          <h1 className="text-2xl font-bold tracking-tight">Platform Overview</h1>
          <p className="text-muted-foreground">
            Analytics and key metrics at a glance
          </p>
        </div>
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
      </div>

      {stats ? (
        <div className="space-y-8">
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
          <p className="text-destructive font-medium">
            {statsError instanceof Error ? statsError.message : "Failed to load statistics"}
          </p>
          <p className="text-muted-foreground text-sm mt-1">
            {statsError instanceof Error && statsError.message}
          </p>
          <Button variant="outline" onClick={handleRefresh} className="mt-4">
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}
