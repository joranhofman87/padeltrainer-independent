import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { PartnerBanner, BannerPlacement } from "@/pages/admin/AdminBanners";

interface Props {
  banners: PartnerBanner[];
  placements: BannerPlacement[];
}

export function BannerAnalytics({ banners, placements }: Props) {
  const [selectedBannerId, setSelectedBannerId] = useState<string>("all");
  const [dateRange, setDateRange] = useState<string>("7d");

  const daysBack = dateRange === "7d" ? 7 : dateRange === "30d" ? 30 : 90;
  const sinceDate = new Date(Date.now() - daysBack * 86400000).toISOString();

  const { data: eventStats = [] } = useQuery({
    queryKey: ["banner-event-stats", selectedBannerId, dateRange],
    queryFn: async () => {
      let query = supabase
        .from("banner_events")
        .select("banner_id, event_type, created_at, placement_id, session_id")
        .gte("created_at", sinceDate);

      if (selectedBannerId !== "all") {
        query = query.eq("banner_id", selectedBannerId);
      }

      const { data, error } = await query.order("created_at", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  // Aggregate by day
  const dailyData: Record<string, { date: string; impressions: number; clicks: number }> = {};
  for (const event of eventStats) {
    const day = event.created_at.slice(0, 10);
    if (!dailyData[day]) dailyData[day] = { date: day, impressions: 0, clicks: 0 };
    if (event.event_type === "impression") dailyData[day].impressions++;
    else dailyData[day].clicks++;
  }
  const chartData = Object.values(dailyData).sort((a, b) => a.date.localeCompare(b.date));

  // Per-placement stats
  const placementStats: Record<string, { impressions: number; clicks: number }> = {};
  for (const event of eventStats) {
    const pid = event.placement_id || "unknown";
    if (!placementStats[pid]) placementStats[pid] = { impressions: 0, clicks: 0 };
    if (event.event_type === "impression") placementStats[pid].impressions++;
    else placementStats[pid].clicks++;
  }

  const totalImpressions = eventStats.filter(e => e.event_type === "impression").length;
  const totalClicks = eventStats.filter(e => e.event_type === "click").length;
  const ctr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : "0";

  // Unique sessions
  const uniqueSessions = new Set(eventStats.map(e => e.session_id).filter(Boolean)).size;

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex gap-4">
        <Select value={selectedBannerId} onValueChange={setSelectedBannerId}>
          <SelectTrigger className="w-[250px]"><SelectValue placeholder="All banners" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All banners</SelectItem>
            {banners.map(b => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={dateRange} onValueChange={setDateRange}>
          <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="90d">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Summary stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Impressions</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{totalImpressions.toLocaleString()}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Clicks</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{totalClicks.toLocaleString()}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">CTR</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{ctr}%</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Unique Viewers</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{uniqueSessions.toLocaleString()}</div></CardContent>
        </Card>
      </div>

      {/* Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Daily Performance</CardTitle>
        </CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">No data for the selected period</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                <YAxis tick={{ fontSize: 12 }} className="fill-muted-foreground" />
                <Tooltip />
                <Legend />
                <Bar dataKey="impressions" fill="hsl(var(--primary))" name="Impressions" radius={[2, 2, 0, 0]} />
                <Bar dataKey="clicks" fill="hsl(var(--accent))" name="Clicks" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Per-placement breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Performance by Placement</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Object.entries(placementStats).map(([pid, stats]) => {
              const placement = placements.find(p => p.id === pid);
              const pCtr = stats.impressions > 0 ? ((stats.clicks / stats.impressions) * 100).toFixed(1) : "0";
              return (
                <div key={pid} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                  <div>
                    <div className="font-medium text-sm">{placement?.label || "Unknown"}</div>
                    <div className="text-xs text-muted-foreground">{placement?.slug || pid}</div>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span>{stats.impressions.toLocaleString()} views</span>
                    <span>{stats.clicks.toLocaleString()} clicks</span>
                    <Badge variant="secondary">{pCtr}% CTR</Badge>
                  </div>
                </div>
              );
            })}
            {Object.keys(placementStats).length === 0 && (
              <p className="text-center py-4 text-muted-foreground">No placement data yet</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
