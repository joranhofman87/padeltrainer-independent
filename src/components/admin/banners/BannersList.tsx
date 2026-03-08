import { useState, useEffect } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Loader2, Plus, Pencil, Trash2, MoreHorizontal, Image as ImageIcon,
  ExternalLink, Eye, Upload,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import type { PartnerBanner, LocationOption, BannerPlacement } from "@/pages/admin/AdminBanners";

interface Props {
  banners: PartnerBanner[];
  locations: LocationOption[];
  placements: BannerPlacement[];
}

export function BannersList({ banners, locations, placements }: Props) {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingBanner, setEditingBanner] = useState<PartnerBanner | null>(null);
  const [deletingBanner, setDeletingBanner] = useState<PartnerBanner | null>(null);
  const [uploading, setUploading] = useState(false);

  const [formData, setFormData] = useState({
    name: "", image_url: "", link_url: "", location_id: "",
    is_active: true, display_order: 0, start_date: "", end_date: "",
    sponsor_name: "", sponsor_logo_url: "",
    budget_type: "unlimited" as string, budget_cap: "",
    placement_ids: [] as string[],
  });

  // Fetch current assignments when editing
  const { data: currentAssignments = [] } = useQuery({
    queryKey: ["banner-assignments", editingBanner?.id],
    queryFn: async () => {
      if (!editingBanner) return [];
      const { data } = await supabase
        .from("banner_placement_assignments")
        .select("placement_id")
        .eq("banner_id", editingBanner.id);
      return (data || []).map(a => a.placement_id);
    },
    enabled: !!editingBanner,
  });

  useEffect(() => {
    if (editingBanner) {
      setFormData({
        name: editingBanner.name,
        image_url: editingBanner.image_url,
        link_url: editingBanner.link_url || "",
        location_id: editingBanner.location_id || "",
        is_active: editingBanner.is_active,
        display_order: editingBanner.display_order,
        start_date: editingBanner.start_date || "",
        end_date: editingBanner.end_date || "",
        sponsor_name: editingBanner.sponsor_name || "",
        sponsor_logo_url: editingBanner.sponsor_logo_url || "",
        budget_type: editingBanner.budget_type || "unlimited",
        budget_cap: editingBanner.budget_cap?.toString() || "",
        placement_ids: currentAssignments,
      });
    } else {
      setFormData({
        name: "", image_url: "", link_url: "", location_id: "",
        is_active: true, display_order: banners.length, start_date: "", end_date: "",
        sponsor_name: "", sponsor_logo_url: "",
        budget_type: "unlimited", budget_cap: "",
        placement_ids: [],
      });
    }
  }, [editingBanner, isDialogOpen, banners.length, currentAssignments]);

  const saveMutation = useMutation({
    mutationFn: async (data: typeof formData & { id?: string }) => {
      const payload = {
        name: data.name,
        image_url: data.image_url,
        link_url: data.link_url || null,
        location_id: data.location_id || null,
        is_active: data.is_active,
        display_order: data.display_order,
        start_date: data.start_date || null,
        end_date: data.end_date || null,
        sponsor_name: data.sponsor_name || null,
        sponsor_logo_url: data.sponsor_logo_url || null,
        budget_type: data.budget_type,
        budget_cap: data.budget_cap ? parseInt(data.budget_cap) : null,
      };

      let bannerId = data.id;

      if (data.id) {
        const { error } = await supabase.from("partner_banners").update(payload).eq("id", data.id);
        if (error) throw error;
      } else {
        const { data: inserted, error } = await supabase.from("partner_banners").insert(payload).select("id").single();
        if (error) throw error;
        bannerId = inserted.id;
      }

      // Sync placement assignments
      if (bannerId) {
        await supabase.from("banner_placement_assignments").delete().eq("banner_id", bannerId);
        if (data.placement_ids.length > 0) {
          const assignments = data.placement_ids.map(pid => ({
            banner_id: bannerId!,
            placement_id: pid,
            is_active: true,
            weight: 1,
            priority: 0,
          }));
          const { error } = await supabase.from("banner_placement_assignments").insert(assignments);
          if (error) throw error;
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-banners"] });
      setIsDialogOpen(false);
      setEditingBanner(null);
      toast.success(editingBanner ? "Banner updated" : "Banner created");
    },
    onError: (error) => toast.error("Failed to save banner: " + error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("partner_banners").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-banners"] });
      setDeletingBanner(null);
      toast.success("Banner deleted");
    },
    onError: (error) => toast.error("Failed to delete: " + error.message),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("partner_banners").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-banners"] }),
  });

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fileName = `${Date.now()}.${file.name.split(".").pop()}`;
      const { error: uploadError } = await supabase.storage.from("partner-banners").upload(fileName, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data: { publicUrl } } = supabase.storage.from("partner-banners").getPublicUrl(fileName);
      setFormData(prev => ({ ...prev, image_url: publicUrl }));
      toast.success("Image uploaded");
    } catch (error: any) {
      toast.error("Upload failed: " + error.message);
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.image_url) {
      toast.error("Name and image are required");
      return;
    }
    saveMutation.mutate(editingBanner ? { ...formData, id: editingBanner.id } : formData);
  };

  const getCTR = (b: PartnerBanner) => {
    if (!b.impression_count) return "0%";
    return ((b.click_count / b.impression_count) * 100).toFixed(1) + "%";
  };

  const getBudgetProgress = (b: PartnerBanner) => {
    if (b.budget_type === "unlimited" || !b.budget_cap) return null;
    const current = b.budget_type === "impression_cap" ? b.impression_count : b.click_count;
    const pct = Math.round((current / b.budget_cap) * 100);
    return { current, cap: b.budget_cap, pct };
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>All Banners</CardTitle>
              <CardDescription>Banners rotate on pages based on placement assignments</CardDescription>
            </div>
            <Button onClick={() => { setEditingBanner(null); setIsDialogOpen(true); }}>
              <Plus className="mr-2 h-4 w-4" /> Add Banner
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {banners.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <ImageIcon className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No banners yet. Create your first banner to get started.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">Preview</TableHead>
                  <TableHead>Name / Sponsor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Budget</TableHead>
                  <TableHead className="text-right">Performance</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {banners.map((banner) => {
                  const budget = getBudgetProgress(banner);
                  return (
                    <TableRow key={banner.id}>
                      <TableCell>
                        <div className="w-16 h-10 rounded border overflow-hidden bg-muted">
                          <img src={banner.image_url} alt={banner.name} className="w-full h-full object-cover" />
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{banner.name}</div>
                        {banner.sponsor_name && (
                          <div className="text-xs text-muted-foreground">{banner.sponsor_name}</div>
                        )}
                        {banner.link_url && (
                          <a href={banner.link_url} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1">
                            <ExternalLink className="h-3 w-3" />
                            {new URL(banner.link_url).hostname}
                          </a>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={banner.is_active}
                          onCheckedChange={(checked) => toggleActiveMutation.mutate({ id: banner.id, is_active: checked })}
                        />
                      </TableCell>
                      <TableCell>
                        {budget ? (
                          <div className="space-y-1">
                            <div className="text-xs">{budget.current.toLocaleString()} / {budget.cap.toLocaleString()}</div>
                            <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full ${budget.pct >= 80 ? "bg-destructive" : "bg-primary"}`}
                                style={{ width: `${Math.min(budget.pct, 100)}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unlimited</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="text-sm">
                          <span className="font-medium">{banner.click_count.toLocaleString()}</span>
                          <span className="text-muted-foreground"> clicks</span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {banner.impression_count.toLocaleString()} views · {getCTR(banner)} CTR
                        </div>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => { setEditingBanner(banner); setIsDialogOpen(true); }}>
                              <Pencil className="mr-2 h-4 w-4" /> Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => window.open(banner.image_url, "_blank")}>
                              <Eye className="mr-2 h-4 w-4" /> View Image
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive" onClick={() => setDeletingBanner(banner)}>
                              <Trash2 className="mr-2 h-4 w-4" /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[550px] max-h-[85vh] overflow-y-auto">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{editingBanner ? "Edit Banner" : "Add Banner"}</DialogTitle>
              <DialogDescription>
                {editingBanner ? "Update the banner details" : "Create a new sponsor banner"}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              {/* Name */}
              <div className="grid gap-2">
                <Label htmlFor="name">Name *</Label>
                <Input id="name" value={formData.name} onChange={(e) => setFormData(p => ({ ...p, name: e.target.value }))} placeholder="Banner name" />
              </div>

              {/* Sponsor details */}
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Sponsor Name</Label>
                  <Input value={formData.sponsor_name} onChange={(e) => setFormData(p => ({ ...p, sponsor_name: e.target.value }))} placeholder="Company name" />
                </div>
                <div className="grid gap-2">
                  <Label>Sponsor Logo URL</Label>
                  <Input value={formData.sponsor_logo_url} onChange={(e) => setFormData(p => ({ ...p, sponsor_logo_url: e.target.value }))} placeholder="https://..." />
                </div>
              </div>

              {/* Image upload */}
              <div className="grid gap-2">
                <Label>Banner Image *</Label>
                {formData.image_url ? (
                  <div className="relative">
                    <img src={formData.image_url} alt="Preview" className="w-full h-32 object-cover rounded-md border" />
                    <Button type="button" variant="secondary" size="sm" className="absolute bottom-2 right-2"
                      onClick={() => setFormData(p => ({ ...p, image_url: "" }))}>Change</Button>
                  </div>
                ) : (
                  <div className="border-2 border-dashed rounded-lg p-6 text-center">
                    <Input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" id="banner-upload" disabled={uploading} />
                    <Label htmlFor="banner-upload" className="cursor-pointer flex flex-col items-center gap-2">
                      {uploading ? <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /> : <Upload className="h-8 w-8 text-muted-foreground" />}
                      <span className="text-sm text-muted-foreground">{uploading ? "Uploading..." : "Click to upload"}</span>
                    </Label>
                  </div>
                )}
              </div>

              {/* Link URL */}
              <div className="grid gap-2">
                <Label>Link URL</Label>
                <Input type="url" value={formData.link_url} onChange={(e) => setFormData(p => ({ ...p, link_url: e.target.value }))} placeholder="https://..." />
              </div>

              {/* Placements */}
              <div className="grid gap-2">
                <Label>Placements</Label>
                <div className="space-y-2 rounded-md border p-3">
                  {placements.map(p => (
                    <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={formData.placement_ids.includes(p.id)}
                        onCheckedChange={(checked) => {
                          setFormData(prev => ({
                            ...prev,
                            placement_ids: checked
                              ? [...prev.placement_ids, p.id]
                              : prev.placement_ids.filter(id => id !== p.id),
                          }));
                        }}
                      />
                      <span>{p.label}</span>
                      <span className="text-muted-foreground">({p.slug})</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Budget */}
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Budget Type</Label>
                  <Select value={formData.budget_type} onValueChange={(v) => setFormData(p => ({ ...p, budget_type: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unlimited">Unlimited</SelectItem>
                      <SelectItem value="impression_cap">Impression Cap</SelectItem>
                      <SelectItem value="click_cap">Click Cap</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {formData.budget_type !== "unlimited" && (
                  <div className="grid gap-2">
                    <Label>Budget Cap</Label>
                    <Input type="number" min={1} value={formData.budget_cap} onChange={(e) => setFormData(p => ({ ...p, budget_cap: e.target.value }))} />
                  </div>
                )}
              </div>

              {/* Location + Schedule */}
              <div className="grid gap-2">
                <Label>Target Location</Label>
                <Select value={formData.location_id} onValueChange={(v) => setFormData(p => ({ ...p, location_id: v === "none" ? "" : v }))}>
                  <SelectTrigger><SelectValue placeholder="All locations" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">All locations</SelectItem>
                    {locations.map(loc => (
                      <SelectItem key={loc.id} value={loc.id}>{loc.name} ({loc.city})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Start Date</Label>
                  <Input type="date" value={formData.start_date} onChange={(e) => setFormData(p => ({ ...p, start_date: e.target.value }))} />
                </div>
                <div className="grid gap-2">
                  <Label>End Date</Label>
                  <Input type="date" value={formData.end_date} onChange={(e) => setFormData(p => ({ ...p, end_date: e.target.value }))} />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <Label>Active</Label>
                <Switch checked={formData.is_active} onCheckedChange={(v) => setFormData(p => ({ ...p, is_active: v }))} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingBanner ? "Save Changes" : "Create Banner"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingBanner} onOpenChange={() => setDeletingBanner(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Banner</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deletingBanner?.name}"? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingBanner && deleteMutation.mutate(deletingBanner.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
