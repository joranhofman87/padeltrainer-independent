import { useState, useEffect } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  CalendarIcon,
  Loader2,
  MapPin,
  Users,
  Building2,
  ExternalLink,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface AcademyEditData {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  website_url: string | null;
  logo_url: string | null;
  banner_url: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  is_verified: boolean;
  is_public: boolean;
  owner_user_id?: string | null;
}

interface AcademyLocation {
  id: string;
  location: {
    id: string;
    name: string;
    city: string;
  };
  is_active: boolean;
  show_on_academy_page: boolean;
}

interface AcademyTrainer {
  id: string;
  payment_percentage: number;
  status: string;
  trainer_profile: {
    id: string;
    user_id: string;
    profile?: {
      full_name: string | null;
      email: string | null;
    } | null;
  };
}

interface AcademyEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  academy: AcademyEditData;
  onSuccess: () => void;
}

const ACADEMY_STATUSES = ["trial", "active", "cancelled", "expired"];
const ACADEMY_TIERS = ["starter", "pro"];

export function AcademyEditDialog({
  open,
  onOpenChange,
  academy,
  onSuccess,
}: AcademyEditDialogProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("profile");

  // Profile state
  const [name, setName] = useState(academy.name);
  const [description, setDescription] = useState(academy.description || "");
  const [contactEmail, setContactEmail] = useState(academy.contact_email || "");
  const [phone, setPhone] = useState(academy.phone || "");
  const [websiteUrl, setWebsiteUrl] = useState(academy.website_url || "");
  const [logoUrl, setLogoUrl] = useState(academy.logo_url || "");
  const [bannerUrl, setBannerUrl] = useState(academy.banner_url || "");

  // Social state
  const [socialInstagram, setSocialInstagram] = useState(academy.social_instagram || "");
  const [socialFacebook, setSocialFacebook] = useState(academy.social_facebook || "");
  const [socialTiktok, setSocialTiktok] = useState(academy.social_tiktok || "");
  const [socialYoutube, setSocialYoutube] = useState(academy.social_youtube || "");
  const [socialLinkedin, setSocialLinkedin] = useState(academy.social_linkedin || "");

  // Subscription state
  const [status, setStatus] = useState(academy.subscription_status || "trial");
  const [tier, setTier] = useState(academy.subscription_tier || "starter");
  const [trialEndsAt, setTrialEndsAt] = useState<Date | undefined>(
    academy.trial_ends_at ? new Date(academy.trial_ends_at) : undefined
  );
  const [isVerified, setIsVerified] = useState(academy.is_verified);
  const [isPublic, setIsPublic] = useState(academy.is_public);

  // Related data
  const [locations, setLocations] = useState<AcademyLocation[]>([]);
  const [trainers, setTrainers] = useState<AcademyTrainer[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(false);

  useEffect(() => {
    if (open) {
      loadRelatedData();
    }
  }, [open, academy.id]);

  const loadRelatedData = async () => {
    setLoadingRelated(true);
    try {
      // Load locations
      const { data: locationData } = await supabase
        .from("academy_locations")
        .select(`
          id,
          is_active,
          show_on_academy_page,
          location:locations(id, name, city)
        `)
        .eq("academy_profile_id", academy.id);

      if (locationData) {
        setLocations(locationData as unknown as AcademyLocation[]);
      }

      // Load trainers
      const { data: trainerData } = await supabase
        .from("academy_trainers")
        .select(`
          id,
          payment_percentage,
          status,
          trainer_profile:trainer_profiles(
            id,
            user_id
          )
        `)
        .eq("academy_profile_id", academy.id);

      if (trainerData) {
        // Fetch profile info separately
        const userIds = trainerData
          .map((t: any) => t.trainer_profile?.user_id)
          .filter(Boolean);

        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from("profiles")
            .select("user_id, full_name, email")
            .in("user_id", userIds);

          const profileMap = new Map(
            profiles?.map((p) => [p.user_id, p]) || []
          );

          const enrichedTrainers = trainerData.map((t: any) => ({
            ...t,
            trainer_profile: {
              ...t.trainer_profile,
              profile: profileMap.get(t.trainer_profile?.user_id) || null,
            },
          }));

          setTrainers(enrichedTrainers as AcademyTrainer[]);
        } else {
          setTrainers(trainerData as unknown as AcademyTrainer[]);
        }
      }
    } catch (error) {
      console.error("Error loading related data:", error);
    } finally {
      setLoadingRelated(false);
    }
  };

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    if (newStatus === "active") {
      setTrialEndsAt(undefined);
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      const { error } = await supabase
        .from("academy_profiles")
        .update({
          name,
          description: description || null,
          contact_email: contactEmail || null,
          phone: phone || null,
          website_url: websiteUrl || null,
          logo_url: logoUrl || null,
          banner_url: bannerUrl || null,
          social_instagram: socialInstagram || null,
          social_facebook: socialFacebook || null,
          social_tiktok: socialTiktok || null,
          social_youtube: socialYoutube || null,
          social_linkedin: socialLinkedin || null,
          subscription_status: status,
          subscription_tier: tier,
          trial_ends_at: status === "active" ? null : (trialEndsAt?.toISOString() || null),
          is_verified: isVerified,
          is_public: isPublic,
        })
        .eq("id", academy.id);

      if (error) throw error;

      toast({
        title: "Academy updated",
        description: `${name} has been updated successfully.`,
      });

      onSuccess();
      onOpenChange(false);
    } catch (error) {
      console.error("Error updating academy:", error);
      toast({
        title: "Error",
        description: "Failed to update academy. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Academy</DialogTitle>
          <DialogDescription>
            Manage all settings for {academy.name}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="locations">
              <MapPin className="h-4 w-4 mr-1" />
              Locations ({locations.length})
            </TabsTrigger>
            <TabsTrigger value="trainers">
              <Users className="h-4 w-4 mr-1" />
              Trainers ({trainers.length})
            </TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="space-y-4 mt-4">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="name">Academy Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="contactEmail">Contact Email</Label>
                  <Input
                    id="contactEmail"
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="websiteUrl">Website URL</Label>
                <Input
                  id="websiteUrl"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="logoUrl">Logo URL</Label>
                  <Input
                    id="logoUrl"
                    value={logoUrl}
                    onChange={(e) => setLogoUrl(e.target.value)}
                  />
                  {logoUrl && (
                    <img
                      src={logoUrl}
                      alt="Logo preview"
                      className="h-12 w-12 rounded object-cover"
                    />
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="bannerUrl">Banner URL</Label>
                  <Input
                    id="bannerUrl"
                    value={bannerUrl}
                    onChange={(e) => setBannerUrl(e.target.value)}
                  />
                  {bannerUrl && (
                    <img
                      src={bannerUrl}
                      alt="Banner preview"
                      className="h-12 w-full rounded object-cover"
                    />
                  )}
                </div>
              </div>

              <div className="border-t pt-4">
                <Label className="text-base font-medium">Social Links</Label>
                <div className="grid grid-cols-2 gap-4 mt-2">
                  <div className="grid gap-2">
                    <Label htmlFor="instagram" className="text-sm">Instagram</Label>
                    <Input
                      id="instagram"
                      value={socialInstagram}
                      onChange={(e) => setSocialInstagram(e.target.value)}
                      placeholder="https://instagram.com/..."
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="facebook" className="text-sm">Facebook</Label>
                    <Input
                      id="facebook"
                      value={socialFacebook}
                      onChange={(e) => setSocialFacebook(e.target.value)}
                      placeholder="https://facebook.com/..."
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="tiktok" className="text-sm">TikTok</Label>
                    <Input
                      id="tiktok"
                      value={socialTiktok}
                      onChange={(e) => setSocialTiktok(e.target.value)}
                      placeholder="https://tiktok.com/..."
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="youtube" className="text-sm">YouTube</Label>
                    <Input
                      id="youtube"
                      value={socialYoutube}
                      onChange={(e) => setSocialYoutube(e.target.value)}
                      placeholder="https://youtube.com/..."
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="linkedin" className="text-sm">LinkedIn</Label>
                    <Input
                      id="linkedin"
                      value={socialLinkedin}
                      onChange={(e) => setSocialLinkedin(e.target.value)}
                      placeholder="https://linkedin.com/..."
                    />
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="locations" className="mt-4">
            {loadingRelated ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : locations.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Building2 className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No locations connected to this academy</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Location</TableHead>
                    <TableHead>City</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Visible</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locations.map((loc) => (
                    <TableRow key={loc.id}>
                      <TableCell className="font-medium">
                        {loc.location?.name || "Unknown"}
                      </TableCell>
                      <TableCell>{loc.location?.city || "-"}</TableCell>
                      <TableCell>
                        <Badge variant={loc.is_active ? "default" : "secondary"}>
                          {loc.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {loc.show_on_academy_page ? "Yes" : "No"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="trainers" className="mt-4">
            {loadingRelated ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : trainers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No trainers connected to this academy</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Trainer</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Payment %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {trainers.map((trainer) => (
                    <TableRow key={trainer.id}>
                      <TableCell className="font-medium">
                        {trainer.trainer_profile?.profile?.full_name || "Unknown"}
                      </TableCell>
                      <TableCell>
                        {trainer.trainer_profile?.profile?.email || "-"}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            trainer.status === "active"
                              ? "default"
                              : trainer.status === "pending"
                              ? "secondary"
                              : "outline"
                          }
                        >
                          {trainer.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{trainer.payment_percentage}%</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="settings" className="space-y-4 mt-4">
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="verified">Verified</Label>
                <p className="text-sm text-muted-foreground">
                  Verified academies appear in public listings
                </p>
              </div>
              <Switch
                id="verified"
                checked={isVerified}
                onCheckedChange={setIsVerified}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="public">Public</Label>
                <p className="text-sm text-muted-foreground">
                  Public academies are visible to everyone
                </p>
              </div>
              <Switch
                id="public"
                checked={isPublic}
                onCheckedChange={setIsPublic}
              />
            </div>

            <div className="border-t pt-4">
              <Label className="text-base font-medium">Subscription</Label>
              <div className="grid gap-4 mt-2">
                <div className="grid gap-2">
                  <Label htmlFor="status">Status</Label>
                  <Select value={status} onValueChange={handleStatusChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      {ACADEMY_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s.charAt(0).toUpperCase() + s.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="tier">Tier</Label>
                  <Select value={tier} onValueChange={setTier}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select tier" />
                    </SelectTrigger>
                    <SelectContent>
                      {ACADEMY_TIERS.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t.charAt(0).toUpperCase() + t.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {status !== "active" && (
                  <div className="grid gap-2">
                    <Label>Trial Ends At</Label>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          className={cn(
                            "justify-start text-left font-normal",
                            !trialEndsAt && "text-muted-foreground"
                          )}
                        >
                          <CalendarIcon className="mr-2 h-4 w-4" />
                          {trialEndsAt ? format(trialEndsAt, "PPP") : "Select date"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={trialEndsAt}
                          onSelect={setTrialEndsAt}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isLoading}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
