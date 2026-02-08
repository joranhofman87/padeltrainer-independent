import { useState, useEffect, useRef } from "react";
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
import { CalendarIcon, Loader2, Upload } from "lucide-react";
import { AdminTrainerReviewsTab } from "./AdminTrainerReviewsTab";
import { MollieDisconnectSection } from "./MollieDisconnectSection";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabaseClient";
import { useToast } from "@/hooks/use-toast";
import { getRatingSystems, type RatingSystemConfig } from "@/lib/ratingSystems";
import { logger } from '@/lib/logger';

export interface TrainerEditData {
  id: string;
  user_id: string;
  // Profile info (from profiles table)
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  bio: string | null;
  phone: string | null;
  // Rating info (from profiles table)
  skill_rating: number | null;
  rating_system: string | null;
  rating_member_id: string | null;
  // Trainer profile info
  hourly_rate: number | null;
  coaching_since_year: number | null;
  coaching_method: string | null;
  favourite_quote: string | null;
  video_url: string | null;
  website_url: string | null;
  // Social
  social_instagram: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
  // Business
  business_name: string | null;
  business_address: string | null;
  kvk_number: string | null;
  btw_number: string | null;
  iban: string | null;
  // Subscription
  subscription_status: string | null;
  trial_ends_at: string | null;
  is_public: boolean;
  is_verified: boolean | null;
}

interface TrainerEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trainer: TrainerEditData;
  onSuccess: () => void;
}

const TRAINER_STATUSES = ["trial", "active", "cancelled", "expired", "inactive"];

export function TrainerEditDialog({
  open,
  onOpenChange,
  trainer,
  onSuccess,
}: TrainerEditDialogProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("profile");

  // Profile state
  const [fullName, setFullName] = useState(trainer.full_name || "");
  const [email, setEmail] = useState(trainer.email || "");
  const [phone, setPhone] = useState(trainer.phone || "");
  const [bio, setBio] = useState(trainer.bio || "");
  const [avatarUrl, setAvatarUrl] = useState(trainer.avatar_url || "");

  // Rating state
  const [skillRating, setSkillRating] = useState(trainer.skill_rating?.toString() || "");
  const [ratingSystem, setRatingSystem] = useState(trainer.rating_system || "knltb");
  const [ratingMemberId, setRatingMemberId] = useState(trainer.rating_member_id || "");
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);

  // Trainer profile state
  const [hourlyRate, setHourlyRate] = useState(trainer.hourly_rate?.toString() || "");
  const [coachingSinceYear, setCoachingSinceYear] = useState(trainer.coaching_since_year?.toString() || "");
  const [coachingMethod, setCoachingMethod] = useState(trainer.coaching_method || "");
  const [favouriteQuote, setFavouriteQuote] = useState(trainer.favourite_quote || "");
  const [videoUrl, setVideoUrl] = useState(trainer.video_url || "");
  const [websiteUrl, setWebsiteUrl] = useState(trainer.website_url || "");

  // Social state
  const [socialInstagram, setSocialInstagram] = useState(trainer.social_instagram || "");
  const [socialTiktok, setSocialTiktok] = useState(trainer.social_tiktok || "");
  const [socialYoutube, setSocialYoutube] = useState(trainer.social_youtube || "");
  const [socialLinkedin, setSocialLinkedin] = useState(trainer.social_linkedin || "");

  // Business state
  const [businessName, setBusinessName] = useState(trainer.business_name || "");
  const [businessAddress, setBusinessAddress] = useState(trainer.business_address || "");
  const [kvkNumber, setKvkNumber] = useState(trainer.kvk_number || "");
  const [btwNumber, setBtwNumber] = useState(trainer.btw_number || "");
  const [iban, setIban] = useState(trainer.iban || "");

  // Subscription state
  const [status, setStatus] = useState(trainer.subscription_status || "trial");
  const [trialEndsAt, setTrialEndsAt] = useState<Date | undefined>(
    trainer.trial_ends_at ? new Date(trainer.trial_ends_at) : undefined
  );
  const [isPublic, setIsPublic] = useState(trainer.is_public);
  const [isVerified, setIsVerified] = useState(trainer.is_verified || false);
  const [platformFeeOverride, setPlatformFeeOverride] = useState("");

  // File upload
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarUploading, setAvatarUploading] = useState(false);

  // Fetch rating systems
  useEffect(() => {
    getRatingSystems().then(setRatingSystems);
  }, []);

  // Reset state when trainer changes
  useEffect(() => {
    if (open) {
      setFullName(trainer.full_name || "");
      setEmail(trainer.email || "");
      setPhone(trainer.phone || "");
      setBio(trainer.bio || "");
      setAvatarUrl(trainer.avatar_url || "");
      setSkillRating(trainer.skill_rating?.toString() || "");
      setRatingSystem(trainer.rating_system || "knltb");
      setRatingMemberId(trainer.rating_member_id || "");
      setHourlyRate(trainer.hourly_rate?.toString() || "");
      setCoachingSinceYear(trainer.coaching_since_year?.toString() || "");
      setCoachingMethod(trainer.coaching_method || "");
      setFavouriteQuote(trainer.favourite_quote || "");
      setVideoUrl(trainer.video_url || "");
      setWebsiteUrl(trainer.website_url || "");
      setSocialInstagram(trainer.social_instagram || "");
      setSocialTiktok(trainer.social_tiktok || "");
      setSocialYoutube(trainer.social_youtube || "");
      setSocialLinkedin(trainer.social_linkedin || "");
      setBusinessName(trainer.business_name || "");
      setBusinessAddress(trainer.business_address || "");
      setKvkNumber(trainer.kvk_number || "");
      setBtwNumber(trainer.btw_number || "");
      setIban(trainer.iban || "");
      setStatus(trainer.subscription_status || "trial");
      setTrialEndsAt(trainer.trial_ends_at ? new Date(trainer.trial_ends_at) : undefined);
      setIsPublic(trainer.is_public);
      setIsVerified(trainer.is_verified || false);
      setActiveTab("profile");
      
      // Fetch platform fee override
      supabase
        .from("trainer_profiles")
        .select("platform_fee_override")
        .eq("id", trainer.id)
        .single()
        .then(({ data }) => {
          setPlatformFeeOverride(data?.platform_fee_override?.toString() || "");
        });
    }
  }, [open, trainer]);

  const handleStatusChange = (newStatus: string) => {
    setStatus(newStatus);
    if (newStatus === "active") {
      setTrialEndsAt(undefined);
    }
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Please upload an image smaller than 5MB.",
        variant: "destructive",
      });
      return;
    }

    setAvatarUploading(true);
    try {
      const fileExt = file.name.split(".").pop();
      const filePath = `trainers/${trainer.id}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(filePath);

      const newUrl = publicUrlData.publicUrl + "?t=" + Date.now();
      setAvatarUrl(newUrl);
      toast({ title: "Avatar uploaded", description: "Avatar image uploaded successfully." });
    } catch (error: any) {
      logger.error('Error uploading avatar', error as Error, { component: 'TrainerEditDialog' });
      toast({ title: "Error", description: error.message || "Failed to upload avatar.", variant: "destructive" });
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      // Update profile via edge function (has service role access)
      const { error: profileError } = await supabase.functions.invoke("update-user", {
        body: {
          target_user_id: trainer.user_id,
          email: email && email !== trainer.email ? email.trim().toLowerCase() : undefined,
          full_name: fullName || null,
          phone: phone || null,
          bio: bio || null,
          avatar_url: avatarUrl || null,
          skill_rating: skillRating ? parseFloat(skillRating) : null,
          rating_system: ratingSystem || "knltb",
          rating_member_id: ratingMemberId || null,
        },
      });

      if (profileError) {
        logger.error('Error updating profile', undefined, { error: profileError, component: 'TrainerEditDialog' });
        throw new Error("Failed to update profile");
      }

      // Update trainer_profiles table
      const { error: trainerError } = await supabase
        .from("trainer_profiles")
        .update({
          hourly_rate: hourlyRate ? parseFloat(hourlyRate) : null,
          coaching_since_year: coachingSinceYear ? parseInt(coachingSinceYear) : null,
          coaching_method: coachingMethod || null,
          favourite_quote: favouriteQuote || null,
          video_url: videoUrl || null,
          website_url: websiteUrl || null,
          social_instagram: socialInstagram || null,
          social_tiktok: socialTiktok || null,
          social_youtube: socialYoutube || null,
          social_linkedin: socialLinkedin || null,
          business_name: businessName || null,
          business_address: businessAddress || null,
          kvk_number: kvkNumber || null,
          btw_number: btwNumber || null,
          iban: iban || null,
          subscription_status: status,
          trial_ends_at: status === "active" ? null : (trialEndsAt?.toISOString() || null),
          is_public: isPublic,
          is_verified: isVerified,
          platform_fee_override: platformFeeOverride ? parseFloat(platformFeeOverride) : null,
        })
        .eq("id", trainer.id);

      if (trainerError) throw trainerError;

      toast({
        title: "Trainer updated",
        description: `${fullName || "Trainer"}'s profile has been updated successfully.`,
      });

      onSuccess();
      onOpenChange(false);
    } catch (error) {
      logger.error('Error updating trainer', error as Error, { component: 'TrainerEditDialog' });
      toast({
        title: "Error",
        description: "Failed to update trainer. Please try again.",
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
          <DialogTitle>Edit Trainer</DialogTitle>
          <DialogDescription>
            Manage all settings for {trainer.full_name || "this trainer"}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="social">Social</TabsTrigger>
            <TabsTrigger value="business">Business</TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          {/* Profile Tab */}
          <TabsContent value="profile" className="space-y-4 mt-4">
            <div className="grid gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="fullName">Full Name</Label>
                  <Input
                    id="fullName"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="avatar">Avatar</Label>
                  <div className="flex gap-2">
                    <Input
                      id="avatar"
                      value={avatarUrl}
                      onChange={(e) => setAvatarUrl(e.target.value)}
                      placeholder="URL or upload"
                      className="flex-1"
                    />
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleAvatarUpload}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => avatarInputRef.current?.click()}
                      disabled={avatarUploading}
                    >
                      {avatarUploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                  {avatarUrl && (
                    <img
                      src={avatarUrl}
                      alt="Avatar preview"
                      className="h-12 w-12 rounded-full object-cover"
                    />
                  )}
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                />
              </div>

              {/* Rating Section */}
              <div className="border-t pt-4 mt-2">
                <h4 className="text-sm font-medium mb-3">Player Rating</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="ratingSystem">Rating System</Label>
                    <Select value={ratingSystem} onValueChange={setRatingSystem}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select system" />
                      </SelectTrigger>
                      <SelectContent>
                        {ratingSystems.map((sys) => (
                          <SelectItem key={sys.code} value={sys.code}>
                            {sys.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="skillRating">Skill Rating</Label>
                    <Input
                      id="skillRating"
                      type="number"
                      value={skillRating}
                      onChange={(e) => setSkillRating(e.target.value)}
                      placeholder={(() => {
                        const sys = ratingSystems.find(s => s.code === ratingSystem);
                        return sys ? `${sys.min_rating} - ${sys.max_rating}` : "e.g. 5.0";
                      })()}
                      step={ratingSystems.find(s => s.code === ratingSystem)?.step || 0.1}
                      min={ratingSystems.find(s => s.code === ratingSystem)?.min_rating}
                      max={ratingSystems.find(s => s.code === ratingSystem)?.max_rating}
                    />
                    {(() => {
                      const sys = ratingSystems.find(s => s.code === ratingSystem);
                      return sys && (
                        <p className="text-xs text-muted-foreground">
                          Range: {sys.min_rating} - {sys.max_rating} ({sys.lower_is_better ? "lower is better" : "higher is better"})
                        </p>
                      );
                    })()}
                  </div>
                </div>
                {(() => {
                  const sys = ratingSystems.find(s => s.code === ratingSystem);
                  return sys?.member_id_label && (
                    <div className="grid gap-2 mt-4">
                      <Label htmlFor="ratingMemberId">{sys.member_id_label}</Label>
                      <Input
                        id="ratingMemberId"
                        value={ratingMemberId}
                        onChange={(e) => setRatingMemberId(e.target.value)}
                        placeholder={sys.member_id_placeholder || ""}
                      />
                    </div>
                  );
                })()}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="hourlyRate">Hourly Rate (€)</Label>
                  <Input
                    id="hourlyRate"
                    type="number"
                    value={hourlyRate}
                    onChange={(e) => setHourlyRate(e.target.value)}
                    placeholder="e.g. 50"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="coachingSinceYear">Coaching Since (year)</Label>
                  <Input
                    id="coachingSinceYear"
                    type="number"
                    value={coachingSinceYear}
                    onChange={(e) => setCoachingSinceYear(e.target.value)}
                    placeholder={`e.g. ${new Date().getFullYear() - 5}`}
                    min="1970"
                    max={new Date().getFullYear()}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="coachingMethod">Coaching Method</Label>
                <Textarea
                  id="coachingMethod"
                  value={coachingMethod}
                  onChange={(e) => setCoachingMethod(e.target.value)}
                  rows={2}
                  placeholder="Describe your coaching philosophy..."
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="favouriteQuote">Favourite Quote</Label>
                <Input
                  id="favouriteQuote"
                  value={favouriteQuote}
                  onChange={(e) => setFavouriteQuote(e.target.value)}
                  placeholder="Your favorite coaching quote..."
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="videoUrl">Video URL</Label>
                  <Input
                    id="videoUrl"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="YouTube or video link"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="websiteUrl">Website URL</Label>
                  <Input
                    id="websiteUrl"
                    value={websiteUrl}
                    onChange={(e) => setWebsiteUrl(e.target.value)}
                    placeholder="https://..."
                  />
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Social Tab */}
          <TabsContent value="social" className="space-y-4 mt-4">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="socialInstagram">Instagram</Label>
                <Input
                  id="socialInstagram"
                  value={socialInstagram}
                  onChange={(e) => setSocialInstagram(e.target.value)}
                  placeholder="@username or URL"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="socialTiktok">TikTok</Label>
                <Input
                  id="socialTiktok"
                  value={socialTiktok}
                  onChange={(e) => setSocialTiktok(e.target.value)}
                  placeholder="@username or URL"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="socialYoutube">YouTube</Label>
                <Input
                  id="socialYoutube"
                  value={socialYoutube}
                  onChange={(e) => setSocialYoutube(e.target.value)}
                  placeholder="Channel URL"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="socialLinkedin">LinkedIn</Label>
                <Input
                  id="socialLinkedin"
                  value={socialLinkedin}
                  onChange={(e) => setSocialLinkedin(e.target.value)}
                  placeholder="Profile URL"
                />
              </div>
            </div>
          </TabsContent>

          {/* Business Tab */}
          <TabsContent value="business" className="space-y-4 mt-4">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="businessName">Business Name</Label>
                <Input
                  id="businessName"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="businessAddress">Business Address</Label>
                <Textarea
                  id="businessAddress"
                  value={businessAddress}
                  onChange={(e) => setBusinessAddress(e.target.value)}
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="kvkNumber">KVK Number</Label>
                  <Input
                    id="kvkNumber"
                    value={kvkNumber}
                    onChange={(e) => setKvkNumber(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="btwNumber">BTW Number</Label>
                  <Input
                    id="btwNumber"
                    value={btwNumber}
                    onChange={(e) => setBtwNumber(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="iban">IBAN</Label>
                <Input
                  id="iban"
                  value={iban}
                  onChange={(e) => setIban(e.target.value)}
                  placeholder="NL00 BANK 0000 0000 00"
                />
              </div>
            </div>
          </TabsContent>

          {/* Reviews Tab */}
          <TabsContent value="reviews" className="mt-4">
            <AdminTrainerReviewsTab 
              trainerId={trainer.id} 
              trainerName={fullName || "this trainer"} 
            />
          </TabsContent>

          {/* Settings Tab */}
          <TabsContent value="settings" className="space-y-4 mt-4">
            <div className="grid gap-4">
              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="is-public">Profile Visibility</Label>
                  <p className="text-sm text-muted-foreground">
                    Allow trainer to appear in public listings
                  </p>
                </div>
                <Switch
                  id="is-public"
                  checked={isPublic}
                  onCheckedChange={setIsPublic}
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="is-verified">Verified Status</Label>
                  <p className="text-sm text-muted-foreground">
                    Mark trainer as verified
                  </p>
                </div>
                <Switch
                  id="is-verified"
                  checked={isVerified}
                  onCheckedChange={setIsVerified}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="status">Subscription Status</Label>
                <Select value={status} onValueChange={handleStatusChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {TRAINER_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
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

              <div className="grid gap-2 border-t pt-4">
                <Label htmlFor="platformFeeOverride">Platform Fee Override (€)</Label>
                <Input
                  id="platformFeeOverride"
                  type="number"
                  min="0"
                  step="0.01"
                  value={platformFeeOverride}
                  onChange={(e) => setPlatformFeeOverride(e.target.value)}
                  placeholder="Leave empty for tier default"
                />
                <p className="text-xs text-muted-foreground">
                  Set a custom fee for this trainer. Leave empty to use tier default (€1.00 Starter, €0.75 Professional).
                </p>
              </div>

              <MollieDisconnectSection
                entityId={trainer.id}
                entityType="trainer"
                entityName={fullName || "this trainer"}
              />
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
