import { useState, useEffect, useMemo, useRef } from "react";
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
  Check,
  ChevronsUpDown,
  Loader2,
  MapPin,
  Plus,
  Trash2,
  Users,
  Building2,
  Upload,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { getActiveLocations, type Location } from "@/lib/locations";

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

interface AvailableTrainer {
  id: string;
  user_id: string;
  full_name: string | null;
  email: string | null;
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

  // Location picker state
  const [allLocations, setAllLocations] = useState<Location[]>([]);
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationSearch, setLocationSearch] = useState("");
  const [addingLocation, setAddingLocation] = useState(false);

  // Trainer picker state
  const [availableTrainers, setAvailableTrainers] = useState<AvailableTrainer[]>([]);
  const [trainerOpen, setTrainerOpen] = useState(false);
  const [trainerSearch, setTrainerSearch] = useState("");
  const [addingTrainer, setAddingTrainer] = useState(false);
  const [selectedTrainerId, setSelectedTrainerId] = useState<string | null>(null);

  // File upload refs
  const bannerInputRef = useRef<HTMLInputElement>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);

  useEffect(() => {
    if (open) {
      loadRelatedData();
      loadAllLocations();
      loadAllTrainers();
    }
  }, [open, academy.id]);

  const loadAllLocations = async () => {
    try {
      const data = await getActiveLocations();
      setAllLocations(data);
    } catch (error) {
      console.error("Error loading locations:", error);
    }
  };

  const loadAllTrainers = async () => {
    try {
      const { data: trainerProfiles } = await supabase
        .from("trainer_profiles")
        .select("id, user_id");

      if (trainerProfiles && trainerProfiles.length > 0) {
        const userIds = trainerProfiles.map(t => t.user_id);
        const { data: profiles } = await supabase
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", userIds);

        const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);
        
        const enrichedTrainers: AvailableTrainer[] = trainerProfiles.map(t => ({
          id: t.id,
          user_id: t.user_id,
          full_name: profileMap.get(t.user_id)?.full_name || null,
          email: profileMap.get(t.user_id)?.email || null,
        }));

        setAvailableTrainers(enrichedTrainers);
      }
    } catch (error) {
      console.error("Error loading trainers:", error);
    }
  };

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

  // Filter locations not already linked
  const filteredLocations = useMemo(() => {
    const linkedIds = new Set(locations.map(l => l.location?.id));
    return allLocations.filter(l => {
      if (linkedIds.has(l.id)) return false;
      if (locationSearch) {
        return (
          l.name.toLowerCase().includes(locationSearch.toLowerCase()) ||
          l.city.toLowerCase().includes(locationSearch.toLowerCase())
        );
      }
      return true;
    });
  }, [allLocations, locations, locationSearch]);

  // Filter trainers not already linked
  const filteredTrainers = useMemo(() => {
    const linkedIds = new Set(trainers.map(t => t.trainer_profile?.id));
    return availableTrainers.filter(t => {
      if (linkedIds.has(t.id)) return false;
      if (trainerSearch) {
        return (
          (t.full_name?.toLowerCase().includes(trainerSearch.toLowerCase())) ||
          (t.email?.toLowerCase().includes(trainerSearch.toLowerCase()))
        );
      }
      return true;
    });
  }, [availableTrainers, trainers, trainerSearch]);

  // Group locations by city for the picker
  const groupedLocations = useMemo(() => {
    const groups: Record<string, Location[]> = {};
    filteredLocations.forEach(location => {
      if (!groups[location.city]) {
        groups[location.city] = [];
      }
      groups[location.city].push(location);
    });
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredLocations]);

  const handleAddLocation = async (locationId: string) => {
    setAddingLocation(true);
    try {
      const { error } = await supabase.from("academy_locations").insert({
        academy_profile_id: academy.id,
        location_id: locationId,
        is_active: true,
        show_on_academy_page: true,
        contract_type: "non_exclusive",
      });

      if (error) throw error;

      toast({ title: "Location added", description: "Location linked to academy." });
      await loadRelatedData();
      setLocationOpen(false);
    } catch (error) {
      console.error("Error adding location:", error);
      toast({ title: "Error", description: "Failed to add location.", variant: "destructive" });
    } finally {
      setAddingLocation(false);
    }
  };

  const handleRemoveLocation = async (academyLocationId: string) => {
    try {
      const { error } = await supabase
        .from("academy_locations")
        .delete()
        .eq("id", academyLocationId);

      if (error) throw error;

      toast({ title: "Location removed", description: "Location unlinked from academy." });
      await loadRelatedData();
    } catch (error) {
      console.error("Error removing location:", error);
      toast({ title: "Error", description: "Failed to remove location.", variant: "destructive" });
    }
  };

  const handleToggleLocationActive = async (academyLocationId: string, isActive: boolean) => {
    try {
      const { error } = await supabase
        .from("academy_locations")
        .update({ is_active: isActive })
        .eq("id", academyLocationId);

      if (error) throw error;
      await loadRelatedData();
    } catch (error) {
      console.error("Error updating location:", error);
      toast({ title: "Error", description: "Failed to update location.", variant: "destructive" });
    }
  };

  const handleToggleLocationVisible = async (academyLocationId: string, visible: boolean) => {
    try {
      const { error } = await supabase
        .from("academy_locations")
        .update({ show_on_academy_page: visible })
        .eq("id", academyLocationId);

      if (error) throw error;
      await loadRelatedData();
    } catch (error) {
      console.error("Error updating location:", error);
      toast({ title: "Error", description: "Failed to update location.", variant: "destructive" });
    }
  };

  const handleAddTrainer = async () => {
    if (!selectedTrainerId) return;
    
    setAddingTrainer(true);
    try {
      const { error } = await supabase.from("academy_trainers").insert({
        academy_profile_id: academy.id,
        trainer_profile_id: selectedTrainerId,
        status: "active",
        payment_percentage: 100, // Default value, academies pay trainers via salary
        show_on_academy_page: true,
        joined_at: new Date().toISOString(),
      });

      if (error) throw error;

      toast({ title: "Trainer added", description: "Trainer linked to academy." });
      await loadRelatedData();
      setTrainerOpen(false);
      setSelectedTrainerId(null);
    } catch (error) {
      console.error("Error adding trainer:", error);
      toast({ title: "Error", description: "Failed to add trainer.", variant: "destructive" });
    } finally {
      setAddingTrainer(false);
    }
  };

  const handleRemoveTrainer = async (academyTrainerId: string) => {
    try {
      const { error } = await supabase
        .from("academy_trainers")
        .delete()
        .eq("id", academyTrainerId);

      if (error) throw error;

      toast({ title: "Trainer removed", description: "Trainer unlinked from academy." });
      await loadRelatedData();
    } catch (error) {
      console.error("Error removing trainer:", error);
      toast({ title: "Error", description: "Failed to remove trainer.", variant: "destructive" });
    }
  };

  const handleToggleTrainerStatus = async (academyTrainerId: string, currentStatus: string) => {
    const newStatus = currentStatus === "active" ? "inactive" : "active";
    try {
      const { error } = await supabase
        .from("academy_trainers")
        .update({ status: newStatus })
        .eq("id", academyTrainerId);

      if (error) throw error;
      await loadRelatedData();
    } catch (error) {
      console.error("Error updating trainer:", error);
      toast({ title: "Error", description: "Failed to update trainer.", variant: "destructive" });
    }
  };

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    if (newStatus === "active") {
      setTrialEndsAt(undefined);
    }
  };

  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Error", description: "Please upload an image file.", variant: "destructive" });
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "Error", description: "File size must be under 10MB.", variant: "destructive" });
      return;
    }

    setBannerUploading(true);
    try {
      const fileExt = file.name.split(".").pop();
      const filePath = `academies/${academy.id}/banner.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(filePath);

      const newUrl = publicUrlData.publicUrl + "?t=" + Date.now();
      setBannerUrl(newUrl);
      toast({ title: "Banner uploaded", description: "Banner image uploaded successfully." });
    } catch (error: any) {
      console.error("Error uploading banner:", error);
      toast({ title: "Error", description: error.message || "Failed to upload banner.", variant: "destructive" });
    } finally {
      setBannerUploading(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Error", description: "Please upload an image file.", variant: "destructive" });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Error", description: "File size must be under 5MB.", variant: "destructive" });
      return;
    }

    setLogoUploading(true);
    try {
      const fileExt = file.name.split(".").pop();
      const filePath = `academies/${academy.id}/logo.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(filePath);

      const newUrl = publicUrlData.publicUrl + "?t=" + Date.now();
      setLogoUrl(newUrl);
      toast({ title: "Logo uploaded", description: "Logo image uploaded successfully." });
    } catch (error: any) {
      console.error("Error uploading logo:", error);
      toast({ title: "Error", description: error.message || "Failed to upload logo.", variant: "destructive" });
    } finally {
      setLogoUploading(false);
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
                  <Label htmlFor="logoUrl">Logo</Label>
                  <div className="flex gap-2">
                    <Input
                      id="logoUrl"
                      value={logoUrl}
                      onChange={(e) => setLogoUrl(e.target.value)}
                      placeholder="URL or upload"
                      className="flex-1"
                    />
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleLogoUpload}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => logoInputRef.current?.click()}
                      disabled={logoUploading}
                    >
                      {logoUploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {logoUrl && (
                    <img
                      src={logoUrl}
                      alt="Logo preview"
                      className="h-12 w-12 rounded object-cover"
                    />
                  )}
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="bannerUrl">Banner</Label>
                  <div className="flex gap-2">
                    <Input
                      id="bannerUrl"
                      value={bannerUrl}
                      onChange={(e) => setBannerUrl(e.target.value)}
                      placeholder="URL or upload"
                      className="flex-1"
                    />
                    <input
                      ref={bannerInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleBannerUpload}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => bannerInputRef.current?.click()}
                      disabled={bannerUploading}
                    >
                      {bannerUploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
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

          <TabsContent value="locations" className="mt-4 space-y-4">
            {/* Add Location Button */}
            <Popover open={locationOpen} onOpenChange={setLocationOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Location
                  <ChevronsUpDown className="ml-auto h-4 w-4 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[400px] p-0" align="start">
                <Command>
                  <CommandInput
                    placeholder="Search locations..."
                    value={locationSearch}
                    onValueChange={setLocationSearch}
                  />
                  <CommandList className="max-h-[300px]">
                    <CommandEmpty>No locations found.</CommandEmpty>
                    {groupedLocations.map(([city, cityLocations]) => (
                      <CommandGroup key={city} heading={city}>
                        {cityLocations.map(location => (
                          <CommandItem
                            key={location.id}
                            value={`${location.name} ${location.city}`}
                            onSelect={() => handleAddLocation(location.id)}
                            disabled={addingLocation}
                          >
                            {addingLocation ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                              <Plus className="mr-2 h-4 w-4" />
                            )}
                            <span className="font-medium">{location.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {/* Locations Table */}
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
                    <TableHead>Active</TableHead>
                    <TableHead>Visible</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
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
                        <Switch
                          checked={loc.is_active}
                          onCheckedChange={(checked) => handleToggleLocationActive(loc.id, checked)}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={loc.show_on_academy_page}
                          onCheckedChange={(checked) => handleToggleLocationVisible(loc.id, checked)}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveLocation(loc.id)}
                          className="h-8 w-8 text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="trainers" className="mt-4 space-y-4">
            {/* Add Trainer Button */}
            <Popover open={trainerOpen} onOpenChange={(open) => {
              setTrainerOpen(open);
              if (!open) {
                setSelectedTrainerId(null);
              }
            }}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Trainer
                  <ChevronsUpDown className="ml-auto h-4 w-4 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[400px] p-0" align="start">
                <div className="p-4 space-y-4">
                  <Command className="border rounded-md">
                    <CommandInput
                      placeholder="Search trainers..."
                      value={trainerSearch}
                      onValueChange={setTrainerSearch}
                    />
                    <CommandList className="max-h-[200px]">
                      <CommandEmpty>No trainers found.</CommandEmpty>
                      <CommandGroup>
                        {filteredTrainers.map(trainer => (
                          <CommandItem
                            key={trainer.id}
                            value={`${trainer.full_name} ${trainer.email}`}
                            onSelect={() => setSelectedTrainerId(trainer.id)}
                            className={cn(selectedTrainerId === trainer.id && "bg-primary/10")}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedTrainerId === trainer.id ? "opacity-100 text-primary" : "opacity-0"
                              )}
                            />
                            <div className="flex-1">
                              <span className="font-medium">{trainer.full_name || "Unknown"}</span>
                              {trainer.email && (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  {trainer.email}
                                </span>
                              )}
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>

                  {selectedTrainerId && (
                    <Button
                      className="w-full"
                      onClick={handleAddTrainer}
                      disabled={addingTrainer}
                    >
                      {addingTrainer && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Add Trainer
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>

            {/* Trainers Table */}
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
                    <TableHead className="w-[50px]"></TableHead>
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
                          variant={trainer.status === "active" ? "default" : "secondary"}
                          className="cursor-pointer"
                          onClick={() => handleToggleTrainerStatus(trainer.id, trainer.status)}
                        >
                          {trainer.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveTrainer(trainer.id)}
                          className="h-8 w-8 text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
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
