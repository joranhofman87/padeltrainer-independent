import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";

interface ClubEditData {
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  is_verified: boolean;
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  logo_url: string | null;
  banner_url: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
}

interface ClubEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clubId: string;
  clubName: string;
  currentData: ClubEditData;
  onSuccess: () => void;
}

export function ClubEditDialog({
  open,
  onOpenChange,
  clubId,
  clubName,
  currentData,
  onSuccess,
}: ClubEditDialogProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<ClubEditData>(currentData);

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const updates: Record<string, unknown> = {
        subscription_status: formData.subscription_status,
        subscription_tier: formData.subscription_tier,
        is_verified: formData.is_verified,
        description: formData.description,
        contact_email: formData.contact_email,
        phone: formData.phone,
        logo_url: formData.logo_url,
        banner_url: formData.banner_url,
        social_instagram: formData.social_instagram,
        social_facebook: formData.social_facebook,
        social_tiktok: formData.social_tiktok,
        social_youtube: formData.social_youtube,
        social_linkedin: formData.social_linkedin,
      };

      // Clear trial_ends_at if subscription is active
      if (formData.subscription_status === "active") {
        updates.trial_ends_at = null;
      } else {
        updates.trial_ends_at = formData.trial_ends_at || null;
      }

      const { error } = await supabase
        .from("club_profiles")
        .update(updates)
        .eq("id", clubId);

      if (error) throw error;

      toast({
        title: "Club updated",
        description: `${clubName} has been updated successfully.`,
      });
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      logger.error("Error updating club", err instanceof Error ? err : new Error(String(err)), { component: 'ClubEditDialog' });
      toast({
        title: "Update failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateField = <K extends keyof ClubEditData>(
    field: K,
    value: ClubEditData[K]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Club: {clubName}</DialogTitle>
          <DialogDescription>
            Update all club details including profile, subscription, and social links.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="status" className="mt-4">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="media">Media</TabsTrigger>
            <TabsTrigger value="social">Social</TabsTrigger>
          </TabsList>

          <TabsContent value="status" className="space-y-4 pt-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Verified</Label>
                <p className="text-sm text-muted-foreground">
                  Mark this club as verified
                </p>
              </div>
              <Switch
                checked={formData.is_verified}
                onCheckedChange={(checked) => updateField("is_verified", checked)}
              />
            </div>

            <div className="space-y-2">
              <Label>Subscription Status</Label>
              <Select
                value={formData.subscription_status || "inactive"}
                onValueChange={(val) => updateField("subscription_status", val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="trial">Trial</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Subscription Tier</Label>
              <Select
                value={formData.subscription_tier || "starter"}
                onValueChange={(val) => updateField("subscription_tier", val)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="pro">Pro</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {formData.subscription_status !== "active" && (
              <div className="space-y-2">
                <Label>Trial Ends At</Label>
                <Input
                  type="datetime-local"
                  value={formData.trial_ends_at?.slice(0, 16) || ""}
                  onChange={(e) =>
                    updateField(
                      "trial_ends_at",
                      e.target.value ? new Date(e.target.value).toISOString() : null
                    )
                  }
                />
              </div>
            )}
          </TabsContent>

          <TabsContent value="profile" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                placeholder="Club description..."
                value={formData.description || ""}
                onChange={(e) => updateField("description", e.target.value || null)}
                rows={4}
              />
            </div>

            <div className="space-y-2">
              <Label>Contact Email</Label>
              <Input
                type="email"
                placeholder="contact@club.com"
                value={formData.contact_email || ""}
                onChange={(e) => updateField("contact_email", e.target.value || null)}
              />
            </div>

            <div className="space-y-2">
              <Label>Phone</Label>
              <Input
                type="tel"
                placeholder="+31 6 12345678"
                value={formData.phone || ""}
                onChange={(e) => updateField("phone", e.target.value || null)}
              />
            </div>
          </TabsContent>

          <TabsContent value="media" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Logo URL</Label>
              <Input
                type="url"
                placeholder="https://..."
                value={formData.logo_url || ""}
                onChange={(e) => updateField("logo_url", e.target.value || null)}
              />
              {formData.logo_url && (
                <div className="mt-2 h-16 w-16 rounded-md border overflow-hidden">
                  <img
                    src={formData.logo_url}
                    alt="Logo preview"
                    className="h-full w-full object-cover"
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Banner URL</Label>
              <Input
                type="url"
                placeholder="https://..."
                value={formData.banner_url || ""}
                onChange={(e) => updateField("banner_url", e.target.value || null)}
              />
              {formData.banner_url && (
                <div className="mt-2 h-24 w-full rounded-md border overflow-hidden">
                  <img
                    src={formData.banner_url}
                    alt="Banner preview"
                    className="h-full w-full object-cover"
                    onError={(e) => (e.currentTarget.style.display = "none")}
                  />
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="social" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label>Instagram</Label>
              <Input
                placeholder="https://instagram.com/..."
                value={formData.social_instagram || ""}
                onChange={(e) => updateField("social_instagram", e.target.value || null)}
              />
            </div>

            <div className="space-y-2">
              <Label>Facebook</Label>
              <Input
                placeholder="https://facebook.com/..."
                value={formData.social_facebook || ""}
                onChange={(e) => updateField("social_facebook", e.target.value || null)}
              />
            </div>

            <div className="space-y-2">
              <Label>TikTok</Label>
              <Input
                placeholder="https://tiktok.com/..."
                value={formData.social_tiktok || ""}
                onChange={(e) => updateField("social_tiktok", e.target.value || null)}
              />
            </div>

            <div className="space-y-2">
              <Label>YouTube</Label>
              <Input
                placeholder="https://youtube.com/..."
                value={formData.social_youtube || ""}
                onChange={(e) => updateField("social_youtube", e.target.value || null)}
              />
            </div>

            <div className="space-y-2">
              <Label>LinkedIn</Label>
              <Input
                placeholder="https://linkedin.com/..."
                value={formData.social_linkedin || ""}
                onChange={(e) => updateField("social_linkedin", e.target.value || null)}
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
