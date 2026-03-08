import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
import { BannersList } from "@/components/admin/banners/BannersList";
import { BannerAnalytics } from "@/components/admin/banners/BannerAnalytics";
import { PlacementManager } from "@/components/admin/banners/PlacementManager";

export interface PartnerBanner {
  id: string;
  name: string;
  image_url: string;
  link_url: string | null;
  location_id: string | null;
  is_active: boolean;
  display_order: number;
  start_date: string | null;
  end_date: string | null;
  click_count: number;
  impression_count: number;
  sponsor_name: string | null;
  sponsor_logo_url: string | null;
  budget_type: string;
  budget_cap: number | null;
  format: string;
  created_at: string;
  updated_at: string;
  location?: { id: string; name: string; city: string } | null;
}

export interface LocationOption {
  id: string;
  name: string;
  city: string;
}

export interface BannerPlacement {
  id: string;
  slug: string;
  label: string;
  description: string | null;
  width: number | null;
  height: number | null;
  rotation_interval_seconds: number;
  created_at: string;
}

export default function AdminBanners() {
  const [activeTab, setActiveTab] = useState("banners");

  const { data: banners = [], isLoading } = useQuery({
    queryKey: ["admin-banners"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("partner_banners")
        .select(`*, location:locations (id, name, city)`)
        .order("display_order", { ascending: true });
      if (error) throw error;
      return data as PartnerBanner[];
    },
  });

  const { data: locations = [] } = useQuery({
    queryKey: ["admin-locations-for-banners"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("locations")
        .select("id, name, city")
        .order("name", { ascending: true })
        .limit(500);
      if (error) throw error;
      return data as LocationOption[];
    },
  });

  const { data: placements = [] } = useQuery({
    queryKey: ["admin-banner-placements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("banner_placements")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as BannerPlacement[];
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sponsor Banners</h1>
        <p className="text-muted-foreground">
          Manage banner advertisements, placements, and track performance
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Banners</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{banners.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{banners.filter(b => b.is_active).length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Impressions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{banners.reduce((s, b) => s + b.impression_count, 0).toLocaleString()}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Clicks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{banners.reduce((s, b) => s + b.click_count, 0).toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="banners">Banners</TabsTrigger>
          <TabsTrigger value="placements">Placements</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
        </TabsList>

        <TabsContent value="banners" className="mt-4">
          <BannersList banners={banners} locations={locations} placements={placements} />
        </TabsContent>

        <TabsContent value="placements" className="mt-4">
          <PlacementManager placements={placements} banners={banners} />
        </TabsContent>

        <TabsContent value="analytics" className="mt-4">
          <BannerAnalytics banners={banners} placements={placements} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
