import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { RatingSystemConfig, COUNTRY_NAMES, clearRatingSystemsCache } from "@/lib/ratingSystems";

interface RatingSystemFormData {
  code: string;
  name: string;
  country: string;
  min_rating: number;
  max_rating: number;
  step: number;
  lower_is_better: boolean;
  member_id_label: string;
  member_id_placeholder: string;
  display_order: number;
  is_active: boolean;
}

const defaultFormData: RatingSystemFormData = {
  code: "",
  name: "",
  country: "INT",
  min_rating: 0.1,
  max_rating: 10,
  step: 0.1,
  lower_is_better: false,
  member_id_label: "",
  member_id_placeholder: "",
  display_order: 0,
  is_active: true,
};

export default function AdminRatingSystems() {
  const { user, role, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation("admin");

  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSystem, setEditingSystem] = useState<RatingSystemConfig | null>(null);
  const [formData, setFormData] = useState<RatingSystemFormData>(defaultFormData);
  const [saving, setSaving] = useState(false);

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [systemToDelete, setSystemToDelete] = useState<RatingSystemConfig | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      checkAdminAndFetchData();
    }
  }, [user]);

  const checkAdminAndFetchData = async () => {
    if (!user) return;

    // Check if user is admin
    const { data: adminCheck } = await supabase.rpc("is_admin", { _user_id: user.id });
    setIsAdmin(adminCheck === true);

    if (adminCheck) {
      fetchRatingSystems();
    } else {
      setLoading(false);
    }
  };

  const fetchRatingSystems = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("rating_systems")
        .select("*")
        .order("display_order", { ascending: true });

      if (error) throw error;
      setRatingSystems(data as RatingSystemConfig[]);
    } catch (error: any) {
      console.error("Error fetching rating systems:", error);
      toast({
        title: t("common:toasts.errorTitle"),
        description: t("ratingSystems.failedToLoad"),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const openAddDialog = () => {
    setEditingSystem(null);
    setFormData(defaultFormData);
    setDialogOpen(true);
  };

  const openEditDialog = (system: RatingSystemConfig) => {
    setEditingSystem(system);
    setFormData({
      code: system.code,
      name: system.name,
      country: system.country,
      min_rating: system.min_rating,
      max_rating: system.max_rating,
      step: system.step,
      lower_is_better: system.lower_is_better,
      member_id_label: system.member_id_label || "",
      member_id_placeholder: system.member_id_placeholder || "",
      display_order: system.display_order,
      is_active: system.is_active,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.code || !formData.name) {
      toast({
        title: t("ratingSystems.validationError"),
        description: t("ratingSystems.codeNameRequired"),
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        code: formData.code.toLowerCase().trim(),
        name: formData.name.trim(),
        country: formData.country,
        min_rating: formData.min_rating,
        max_rating: formData.max_rating,
        step: formData.step,
        lower_is_better: formData.lower_is_better,
        member_id_label: formData.member_id_label.trim() || null,
        member_id_placeholder: formData.member_id_placeholder.trim() || null,
        display_order: formData.display_order,
        is_active: formData.is_active,
      };

      if (editingSystem) {
        const { error } = await supabase
          .from("rating_systems")
          .update(payload)
          .eq("id", editingSystem.id);

        if (error) throw error;

        toast({
          title: t("ratingSystems.updated"),
          description: t("ratingSystems.updatedDesc", { name: formData.name }),
        });
      } else {
        const { error } = await supabase.from("rating_systems").insert(payload);

        if (error) throw error;

        toast({
          title: t("ratingSystems.created"),
          description: t("ratingSystems.createdDesc", { name: formData.name }),
        });
      }

      clearRatingSystemsCache();
      setDialogOpen(false);
      fetchRatingSystems();
    } catch (error: any) {
      console.error("Error saving rating system:", error);
      toast({
        title: t("common:toasts.errorTitle"),
        description: error.message || t("common:toasts.errorDescription"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (system: RatingSystemConfig) => {
    try {
      const { error } = await supabase
        .from("rating_systems")
        .update({ is_active: !system.is_active })
        .eq("id", system.id);

      if (error) throw error;

      clearRatingSystemsCache();
      fetchRatingSystems();

      toast({
        title: system.is_active ? t("ratingSystems.disabled") : t("ratingSystems.enabled"),
        description: t("ratingSystems.statusChanged", { 
          name: system.name, 
          status: system.is_active ? t("pricing.inactive").toLowerCase() : t("pricing.active").toLowerCase() 
        }),
      });
    } catch (error: any) {
      console.error("Error toggling rating system:", error);
      toast({
        title: t("common:toasts.errorTitle"),
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const openDeleteDialog = (system: RatingSystemConfig) => {
    setSystemToDelete(system);
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!systemToDelete) return;

    try {
      const { error } = await supabase
        .from("rating_systems")
        .delete()
        .eq("id", systemToDelete.id);

      if (error) throw error;

      clearRatingSystemsCache();
      setDeleteDialogOpen(false);
      setSystemToDelete(null);
      fetchRatingSystems();

      toast({
        title: t("ratingSystems.deleted"),
        description: t("ratingSystems.deletedDesc", { name: systemToDelete.name }),
      });
    } catch (error: any) {
      console.error("Error deleting rating system:", error);
      toast({
        title: t("common:toasts.errorTitle"),
        description: error.message,
        variant: "destructive",
      });
    }
  };

  // Group systems by country
  const systemsByCountry = ratingSystems.reduce((acc, system) => {
    const country = system.country;
    if (!acc[country]) acc[country] = [];
    acc[country].push(system);
    return acc;
  }, {} as Record<string, RatingSystemConfig[]>);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>{t("accessDenied")}</CardTitle>
            <CardDescription>{t("noPermission")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate(-1)}>{t("goBack")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/5">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate("/admin")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="font-bold text-xl">{t("ratingSystems.title")}</span>
          </div>
          <Button onClick={openAddDialog}>
            <Plus className="h-4 w-4 mr-2" />
            {t("ratingSystems.addSystem")}
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="space-y-6">
          {Object.entries(systemsByCountry).map(([country, systems]) => (
            <Card key={country}>
              <CardHeader>
                <CardTitle>{COUNTRY_NAMES[country] || country}</CardTitle>
                <CardDescription>{t("ratingSystems.systemCount", { count: systems.length })}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {systems.map((system) => (
                  <div
                    key={system.id}
                    className="flex items-center justify-between p-4 border rounded-lg"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{system.name}</span>
                        <Badge variant="outline" className="text-xs">
                          {system.code}
                        </Badge>
                        {!system.is_active && (
                          <Badge variant="secondary" className="text-xs">
                            Inactive
                          </Badge>
                        )}
                        {system.lower_is_better && (
                          <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-900/20">
                            {t("ratingSystems.lowerIsBetter")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {t("ratingSystems.range")}: {system.min_rating} - {system.max_rating} ({t("ratingSystems.step")}: {system.step})
                        {system.member_id_label && ` • ${system.member_id_label}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={system.is_active}
                        onCheckedChange={() => handleToggleActive(system)}
                      />
                      <Button variant="ghost" size="icon" onClick={() => openEditDialog(system)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openDeleteDialog(system)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}

          {ratingSystems.length === 0 && (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                <p>{t("ratingSystems.noSystems")}</p>
                <Button className="mt-4" onClick={openAddDialog}>
                  <Plus className="h-4 w-4 mr-2" />
                  {t("ratingSystems.addFirst")}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </main>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingSystem ? t("ratingSystems.editTitle") : t("ratingSystems.addTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("ratingSystems.configureProps")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="code">Code *</Label>
                <Input
                  id="code"
                  value={formData.code}
                  onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                  placeholder="knltb"
                  disabled={!!editingSystem}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="KNLTB"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="country">Country</Label>
                <Input
                  id="country"
                  value={formData.country}
                  onChange={(e) => setFormData({ ...formData, country: e.target.value.toUpperCase() })}
                  placeholder="NL"
                  maxLength={3}
                />
                <p className="text-xs text-muted-foreground">Use INT for international</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="display_order">Display Order</Label>
                <Input
                  id="display_order"
                  type="number"
                  value={formData.display_order}
                  onChange={(e) => setFormData({ ...formData, display_order: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="min_rating">Min Rating</Label>
                <Input
                  id="min_rating"
                  type="number"
                  step="0.1"
                  value={formData.min_rating}
                  onChange={(e) => setFormData({ ...formData, min_rating: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="max_rating">Max Rating</Label>
                <Input
                  id="max_rating"
                  type="number"
                  step="0.1"
                  value={formData.max_rating}
                  onChange={(e) => setFormData({ ...formData, max_rating: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="step">Step</Label>
                <Input
                  id="step"
                  type="number"
                  step="0.01"
                  value={formData.step}
                  onChange={(e) => setFormData({ ...formData, step: parseFloat(e.target.value) || 0.1 })}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Lower is Better</Label>
                <p className="text-xs text-muted-foreground">e.g., KNLTB where 1.0 is best</p>
              </div>
              <Switch
                checked={formData.lower_is_better}
                onCheckedChange={(checked) => setFormData({ ...formData, lower_is_better: checked })}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="member_id_label">Member ID Label</Label>
                <Input
                  id="member_id_label"
                  value={formData.member_id_label}
                  onChange={(e) => setFormData({ ...formData, member_id_label: e.target.value })}
                  placeholder="KNLTB Number"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="member_id_placeholder">Placeholder</Label>
                <Input
                  id="member_id_placeholder"
                  value={formData.member_id_placeholder}
                  onChange={(e) => setFormData({ ...formData, member_id_placeholder: e.target.value })}
                  placeholder="12345678"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Label>Active</Label>
              <Switch
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
            </div>

            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingSystem ? "Update" : "Create"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Rating System</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{systemToDelete?.name}"? This action cannot be undone.
              Players using this rating system will keep their data but won't be able to select it anymore.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
