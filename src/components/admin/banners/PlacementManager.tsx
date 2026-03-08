import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { PartnerBanner, BannerPlacement } from "@/pages/admin/AdminBanners";

interface Props {
  placements: BannerPlacement[];
  banners: PartnerBanner[];
}

interface Assignment {
  id: string;
  banner_id: string;
  placement_id: string;
  weight: number;
  priority: number;
  is_active: boolean;
  banner?: { id: string; name: string; image_url: string } | null;
}

export function PlacementManager({ placements, banners }: Props) {
  const queryClient = useQueryClient();
  const [selectedPlacement, setSelectedPlacement] = useState<string>(placements[0]?.id || "");
  const [addBannerId, setAddBannerId] = useState("");

  const { data: assignments = [], isLoading } = useQuery({
    queryKey: ["placement-assignments", selectedPlacement],
    queryFn: async () => {
      if (!selectedPlacement) return [];
      const { data, error } = await supabase
        .from("banner_placement_assignments")
        .select("*, banner:partner_banners(id, name, image_url)")
        .eq("placement_id", selectedPlacement)
        .order("priority", { ascending: false });
      if (error) throw error;
      return data as Assignment[];
    },
    enabled: !!selectedPlacement,
  });

  const addMutation = useMutation({
    mutationFn: async (bannerId: string) => {
      const { error } = await supabase.from("banner_placement_assignments").insert({
        banner_id: bannerId,
        placement_id: selectedPlacement,
        weight: 1,
        priority: 0,
        is_active: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["placement-assignments", selectedPlacement] });
      setAddBannerId("");
      toast.success("Banner assigned to placement");
    },
    onError: (e) => toast.error(e.message),
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("banner_placement_assignments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["placement-assignments", selectedPlacement] });
      toast.success("Assignment removed");
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, weight, priority }: { id: string; weight?: number; priority?: number }) => {
      const payload: Record<string, number> = {};
      if (weight !== undefined) payload.weight = weight;
      if (priority !== undefined) payload.priority = priority;
      const { error } = await supabase.from("banner_placement_assignments").update(payload).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["placement-assignments", selectedPlacement] }),
  });

  const currentPlacement = placements.find(p => p.id === selectedPlacement);
  const assignedBannerIds = new Set(assignments.map(a => a.banner_id));
  const availableBanners = banners.filter(b => !assignedBannerIds.has(b.id));

  return (
    <div className="space-y-6">
      {/* Placement selector */}
      <Card>
        <CardHeader>
          <CardTitle>Placement Configuration</CardTitle>
          <CardDescription>Assign banners to specific placements and configure rotation weights</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <Select value={selectedPlacement} onValueChange={setSelectedPlacement}>
                <SelectTrigger><SelectValue placeholder="Select placement" /></SelectTrigger>
                <SelectContent>
                  {placements.map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.label} ({p.slug})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {currentPlacement && (
              <div className="text-sm text-muted-foreground">
                {currentPlacement.width}×{currentPlacement.height}px · {currentPlacement.rotation_interval_seconds}s rotation
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Assignments */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Assigned Banners</CardTitle>
            <div className="flex gap-2">
              <Select value={addBannerId} onValueChange={setAddBannerId}>
                <SelectTrigger className="w-[200px]"><SelectValue placeholder="Add banner..." /></SelectTrigger>
                <SelectContent>
                  {availableBanners.map(b => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={!addBannerId || addMutation.isPending}
                onClick={() => addBannerId && addMutation.mutate(addBannerId)}>
                {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
          ) : assignments.length === 0 ? (
            <p className="text-center py-8 text-muted-foreground">No banners assigned to this placement</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[60px]">Preview</TableHead>
                  <TableHead>Banner</TableHead>
                  <TableHead className="w-[100px]">Weight</TableHead>
                  <TableHead className="w-[100px]">Priority</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignments.map(a => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <div className="w-12 h-8 rounded border overflow-hidden bg-muted">
                        <img src={a.banner?.image_url || ""} alt="" className="w-full h-full object-cover" />
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">{a.banner?.name}</TableCell>
                    <TableCell>
                      <Input type="number" min={1} max={100} value={a.weight}
                        className="w-16 h-8"
                        onChange={(e) => updateMutation.mutate({ id: a.id, weight: parseInt(e.target.value) || 1 })} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" min={0} value={a.priority}
                        className="w-16 h-8"
                        onChange={(e) => updateMutation.mutate({ id: a.id, priority: parseInt(e.target.value) || 0 })} />
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => removeMutation.mutate(a.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* All placements overview */}
      <Card>
        <CardHeader>
          <CardTitle>All Placements</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3">
            {placements.map(p => (
              <div key={p.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div>
                  <div className="font-medium text-sm">{p.label}</div>
                  <div className="text-xs text-muted-foreground">{p.description}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{p.slug}</Badge>
                  <Badge variant="secondary">{p.width}×{p.height}</Badge>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
