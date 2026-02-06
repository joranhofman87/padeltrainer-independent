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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2 } from "lucide-react";
import type { ReviewTag } from "@/lib/reviews";
import { logger } from "@/lib/logger";

interface ReviewTagFormData {
  name: string;
  name_nl: string;
  category: string;
  display_order: number;
  is_active: boolean;
}

const defaultFormData: ReviewTagFormData = {
  name: "",
  name_nl: "",
  category: "teaching_style",
  display_order: 0,
  is_active: true,
};

const CATEGORIES = [
  { value: "teaching_style", label: "Teaching Style", labelNl: "Lesstijl" },
  { value: "skill_focus", label: "Skill Focus", labelNl: "Vaardigheden" },
  { value: "specialties", label: "Specialties", labelNl: "Specialisaties" },
];

export default function AdminReviewTags() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation("admin");

  const [reviewTags, setReviewTags] = useState<ReviewTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<ReviewTag | null>(null);
  const [formData, setFormData] = useState<ReviewTagFormData>(defaultFormData);
  const [saving, setSaving] = useState(false);

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [tagToDelete, setTagToDelete] = useState<ReviewTag | null>(null);

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

    const { data: adminCheck } = await supabase.rpc("is_admin", { _user_id: user.id });
    setIsAdmin(adminCheck === true);

    if (adminCheck) {
      fetchReviewTags();
    } else {
      setLoading(false);
    }
  };

  const fetchReviewTags = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("review_tags")
        .select("*")
        .order("category")
        .order("display_order");

      if (error) throw error;
      setReviewTags(data as ReviewTag[]);
    } catch (error: any) {
      logger.error("Error fetching review tags", error as Error, { component: "AdminReviewTags" });
      toast({
        title: "Error",
        description: "Failed to load review tags",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const openAddDialog = () => {
    setEditingTag(null);
    setFormData(defaultFormData);
    setDialogOpen(true);
  };

  const openEditDialog = (tag: ReviewTag) => {
    setEditingTag(tag);
    setFormData({
      name: tag.name,
      name_nl: tag.name_nl,
      category: tag.category,
      display_order: tag.display_order,
      is_active: tag.is_active,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formData.name || !formData.name_nl) {
      toast({
        title: "Validation Error",
        description: "Name (EN) and Name (NL) are required",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: formData.name.trim(),
        name_nl: formData.name_nl.trim(),
        category: formData.category,
        display_order: formData.display_order,
        is_active: formData.is_active,
      };

      if (editingTag) {
        const { error } = await supabase
          .from("review_tags")
          .update(payload)
          .eq("id", editingTag.id);

        if (error) throw error;

        toast({
          title: "Tag Updated",
          description: `${formData.name} has been updated.`,
        });
      } else {
        const { error } = await supabase.from("review_tags").insert(payload);

        if (error) throw error;

        toast({
          title: "Tag Created",
          description: `${formData.name} has been added.`,
        });
      }

      setDialogOpen(false);
      fetchReviewTags();
    } catch (error: any) {
      logger.error("Error saving review tag", error as Error, { component: "AdminReviewTags", tagId: editingTag?.id });
      toast({
        title: "Error",
        description: error.message || "Failed to save tag",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (tag: ReviewTag) => {
    try {
      const { error } = await supabase
        .from("review_tags")
        .update({ is_active: !tag.is_active })
        .eq("id", tag.id);

      if (error) throw error;

      fetchReviewTags();

      toast({
        title: tag.is_active ? "Tag Disabled" : "Tag Enabled",
        description: `${tag.name} is now ${tag.is_active ? "inactive" : "active"}.`,
      });
    } catch (error: any) {
      logger.error("Error toggling review tag", error as Error, { component: "AdminReviewTags", tagId: tag.id });
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const openDeleteDialog = (tag: ReviewTag) => {
    setTagToDelete(tag);
    setDeleteDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!tagToDelete) return;

    try {
      const { error } = await supabase
        .from("review_tags")
        .delete()
        .eq("id", tagToDelete.id);

      if (error) throw error;

      setDeleteDialogOpen(false);
      setTagToDelete(null);
      fetchReviewTags();

      toast({
        title: "Tag Deleted",
        description: `${tagToDelete.name} has been removed.`,
      });
    } catch (error: any) {
      logger.error("Error deleting review tag", error as Error, { component: "AdminReviewTags", tagId: tagToDelete?.id });
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  // Group tags by category
  const tagsByCategory = reviewTags.reduce((acc, tag) => {
    const category = tag.category;
    if (!acc[category]) acc[category] = [];
    acc[category].push(tag);
    return acc;
  }, {} as Record<string, ReviewTag[]>);

  const getCategoryLabel = (category: string) => {
    const cat = CATEGORIES.find(c => c.value === category);
    return cat?.label || category;
  };

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center py-12">
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Review Tags</h1>
          <p className="text-muted-foreground">
            Manage tags that players can select when leaving reviews
          </p>
        </div>
        <Button onClick={openAddDialog}>
          <Plus className="h-4 w-4 mr-2" />
          Add Tag
        </Button>
      </div>

      {/* Tags by Category */}
      <div className="space-y-6">
        {CATEGORIES.map(category => {
          const tags = tagsByCategory[category.value] || [];
          return (
            <Card key={category.value}>
              <CardHeader>
                <CardTitle className="text-lg">{category.label}</CardTitle>
                <CardDescription>{tags.length} tag(s)</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {tags.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No tags in this category</p>
                ) : (
                  tags.map((tag) => (
                    <div
                      key={tag.id}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{tag.name}</span>
                          <Badge variant="outline" className="text-xs">
                            {tag.name_nl}
                          </Badge>
                          {!tag.is_active && (
                            <Badge variant="secondary" className="text-xs">
                              Inactive
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          Order: {tag.display_order}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={tag.is_active}
                          onCheckedChange={() => handleToggleActive(tag)}
                        />
                        <Button variant="ghost" size="icon" onClick={() => openEditDialog(tag)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openDeleteDialog(tag)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          );
        })}

        {reviewTags.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground">
              <p>No review tags configured yet.</p>
              <Button className="mt-4" onClick={openAddDialog}>
                <Plus className="h-4 w-4 mr-2" />
                Add First Tag
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingTag ? "Edit Tag" : "Add Tag"}
            </DialogTitle>
            <DialogDescription>
              Configure the review tag properties.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name (English) *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Patient"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="name_nl">Name (Dutch) *</Label>
              <Input
                id="name_nl"
                value={formData.name_nl}
                onChange={(e) => setFormData({ ...formData, name_nl: e.target.value })}
                placeholder="e.g., Geduldig"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select
                value={formData.category}
                onValueChange={(value) => setFormData({ ...formData, category: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(cat => (
                    <SelectItem key={cat.value} value={cat.value}>
                      {cat.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Active</Label>
                <p className="text-xs text-muted-foreground">Show this tag to players</p>
              </div>
              <Switch
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
            </div>

            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)} className="flex-1">
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving} className="flex-1">
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Tag</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{tagToDelete?.name}"? This will also remove it from all existing reviews.
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
