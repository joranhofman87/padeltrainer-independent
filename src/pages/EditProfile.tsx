import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save, User, Camera, Loader2, MapPin, Quote, Video, Instagram, Youtube, Linkedin, Sparkles, Eye, EyeOff } from 'lucide-react';
import { getRatingSystems, RatingSystemConfig, COUNTRY_NAMES } from '@/lib/ratingSystems';
import { LocationPicker } from '@/components/locations/LocationPicker';
import { TrainerLocationPicker, TrainerLocationSelection } from '@/components/locations/TrainerLocationPicker';
import { getPlayerLocations, updatePlayerLocations, getTrainerLocations, updateTrainerLocations, TrainerLocationData } from '@/lib/locations';
import { CertificationsPicker } from '@/components/trainer/CertificationsPicker';
import { SpecializationsPicker } from '@/components/trainer/SpecializationsPicker';
import { getTrainerCountry } from '@/lib/certifications';
import { isValidVideoUrl, getVideoThumbnail } from '@/lib/videoEmbed';
import { logger } from '@/lib/logger';
import { VideoManager } from '@/components/profiles/VideoManager';
import { canBeVisible } from '@/lib/subscription';
import { isTrainerInPaidAcademy } from '@/lib/academy';
import { useLocalizedPathFn } from '@/hooks/useLocalizedPath';

interface TrainerProfileData {
  hourly_rate: number | null;
  coaching_since_year: number | null;
  certifications: string[];
  specializations: string[];
  coaching_method: string;
  favourite_quote: string;
  video_url: string;
  website_url: string;
  social_instagram: string;
  social_tiktok: string;
  social_youtube: string;
  social_linkedin: string;
  preferred_min_rating: number | null;
  preferred_max_rating: number | null;
  preferred_rating_system: string;
}

export default function EditProfile() {
  const { user, profile, role, loading, refreshAuth, subscription } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation('player');
  const { t: tTrainer } = useTranslation('trainer');
  const getLocalizedPath = useLocalizedPathFn();
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    phone: '',
    location: '',
    bio: '',
    skill_rating: '',
    rating_system: 'knltb',
    rating_member_id: '',
    birth_date: '',
  });
  
  const [trainerData, setTrainerData] = useState<TrainerProfileData>({
    hourly_rate: null,
    coaching_since_year: null,
    certifications: [],
    specializations: [],
    coaching_method: '',
    favourite_quote: '',
    video_url: '',
    website_url: '',
    social_instagram: '',
    social_tiktok: '',
    social_youtube: '',
    social_linkedin: '',
    preferred_min_rating: null,
    preferred_max_rating: null,
    preferred_rating_system: 'knltb',
  });
  
  // Rating systems from database
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [loadingRatingSystems, setLoadingRatingSystems] = useState(true);
  
  // Trainer country for certifications picker
  const [trainerCountry, setTrainerCountry] = useState<string>('NL');
  
  // Player location state
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([]);
  const [preferredLocationId, setPreferredLocationId] = useState<string | undefined>();
  const [loadingLocations, setLoadingLocations] = useState(false);
  
  // Trainer location state
  const [trainerLocations, setTrainerLocations] = useState<TrainerLocationSelection[]>([]);

  // Visibility toggle state
  const [isPublic, setIsPublic] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [updatingVisibility, setUpdatingVisibility] = useState(false);
  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);

  // Fetch rating systems from database
  useEffect(() => {
    async function fetchRatingSystems() {
      setLoadingRatingSystems(true);
      try {
        const systems = await getRatingSystems();
        setRatingSystems(systems);
      } catch (error) {
        logger.error('Error fetching rating systems', error instanceof Error ? error : new Error(String(error)), { component: 'EditProfile' });
      } finally {
        setLoadingRatingSystems(false);
      }
    }
    fetchRatingSystems();
  }, []);

  useEffect(() => {
    if (!loading && !user) {
      navigate('/app/auth');
    }
  }, [user, loading, navigate]);

  useEffect(() => {
    if (profile) {
      setFormData({
        full_name: profile.full_name || '',
        email: profile.email || '',
        phone: profile.phone || '',
        location: profile.location || '',
        bio: profile.bio || '',
        skill_rating: profile.skill_rating?.toString() || '',
        rating_system: (profile as any).rating_system || 'knltb',
        rating_member_id: (profile as any).rating_member_id || '',
        birth_date: (profile as any).birth_date || '',
      });
      setAvatarUrl(profile.avatar_url || null);
    }
  }, [profile]);

  useEffect(() => {
    if (role === 'trainer' && user) {
      fetchTrainerProfile();
    }
  }, [role, user]);

  // Fetch player locations when profile is loaded and role is player
  useEffect(() => {
    if (role === 'player' && profile?.id) {
      fetchPlayerLocations();
    }
  }, [role, profile?.id]);

  // Fetch trainer locations and country when profile is loaded and role is trainer
  useEffect(() => {
    if (role === 'trainer' && user) {
      fetchTrainerLocations();
      getTrainerCountry(user.id).then(setTrainerCountry);
    }
  }, [role, user]);

  const fetchTrainerLocations = async () => {
    if (!user) return;
    setLoadingLocations(true);
    try {
      const locations = await getTrainerLocations(user.id);
      setTrainerLocations(locations.map(loc => ({
        locationId: loc.location_id,
        relationshipType: loc.relationship_type as 'independent' | 'club_trainer',
        isPrimary: loc.is_primary,
      })));
    } catch (error) {
      logger.error('Error fetching trainer locations', error instanceof Error ? error : new Error(String(error)), { component: 'EditProfile' });
    } finally {
      setLoadingLocations(false);
    }
  };

  const fetchPlayerLocations = async () => {
    if (!profile?.id) return;
    setLoadingLocations(true);
    try {
      const playerLocations = await getPlayerLocations(profile.id);
      setSelectedLocationIds(playerLocations.map(pl => pl.location_id));
      const preferred = playerLocations.find(pl => pl.is_preferred);
      setPreferredLocationId(preferred?.location_id);
    } catch (error) {
      logger.error('Error fetching player locations', error instanceof Error ? error : new Error(String(error)), { component: 'EditProfile' });
    } finally {
      setLoadingLocations(false);
    }
  };

  const fetchTrainerProfile = async () => {
    const { data, error } = await supabase
      .from('trainer_profiles')
      .select('id, is_public, hourly_rate, coaching_since_year, certifications, specializations, coaching_method, favourite_quote, video_url, website_url, social_instagram, social_tiktok, social_youtube, social_linkedin, preferred_min_rating, preferred_max_rating, preferred_rating_system')
      .eq('user_id', user!.id)
      .single();
    
    if (data) {
      setTrainerProfileId(data.id);
      setIsPublic(data.is_public ?? false);
      setTrainerData({
        hourly_rate: data.hourly_rate,
        coaching_since_year: (data as any).coaching_since_year,
        certifications: data.certifications || [],
        specializations: data.specializations || [],
        coaching_method: data.coaching_method || '',
        favourite_quote: data.favourite_quote || '',
        video_url: data.video_url || '',
        website_url: data.website_url || '',
        social_instagram: data.social_instagram || '',
        social_tiktok: data.social_tiktok || '',
        social_youtube: data.social_youtube || '',
        social_linkedin: data.social_linkedin || '',
        preferred_min_rating: data.preferred_min_rating,
        preferred_max_rating: data.preferred_max_rating,
        preferred_rating_system: data.preferred_rating_system || 'knltb',
      });
    }
  };

  const handleVisibilityToggle = async (checked: boolean) => {
    if (checked) {
      // Check if trainer can be visible
      const canPublish = subscription ? canBeVisible(subscription) : false;
      const inPaidAcademy = trainerProfileId ? await isTrainerInPaidAcademy(trainerProfileId) : false;
      
      if (!canPublish && !inPaidAcademy) {
        setShowUpgradeDialog(true);
        return;
      }
    }

    setUpdatingVisibility(true);
    try {
      const { error } = await supabase
        .from('trainer_profiles')
        .update({ is_public: checked })
        .eq('user_id', user!.id);

      if (error) throw error;

      setIsPublic(checked);
      toast({
        title: tTrainer('profileVisibility.updated'),
        description: checked
          ? tTrainer('profileVisibility.updatedPublic')
          : tTrainer('profileVisibility.updatedHidden'),
      });
    } catch (error: any) {
      toast({
        title: tTrainer('profileVisibility.error'),
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setUpdatingVisibility(false);
    }
  };

  // Get current rating system config
  const currentRatingSystem = ratingSystems.find(s => s.code === formData.rating_system);

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !user) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({
        title: t('editProfile.invalidFileType'),
        description: t('editProfile.invalidFileTypeDescription'),
        variant: 'destructive',
      });
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t('editProfile.fileTooLarge'),
        description: t('editProfile.fileTooLargeDescription'),
        variant: 'destructive',
      });
      return;
    }

    setUploadingAvatar(true);

    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${user.id}/avatar.${fileExt}`;

      // Upload file to storage
      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);

      // Add cache-busting query param
      const urlWithTimestamp = `${publicUrl}?t=${Date.now()}`;

      // Update profile with new avatar URL
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: urlWithTimestamp })
        .eq('user_id', user.id);

      if (updateError) throw updateError;

      setAvatarUrl(urlWithTimestamp);
      await refreshAuth();

      toast({
        title: t('editProfile.avatarUpdated'),
        description: t('editProfile.avatarUpdatedDescription'),
      });
    } catch (error: any) {
      logger.error('Avatar upload error', error instanceof Error ? error : new Error(String(error)), { component: 'EditProfile' });
      toast({
        title: t('editProfile.uploadFailed'),
        description: error.message || t('editProfile.uploadFailed'),
        variant: 'destructive',
      });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    
    setSaving(true);
    
    try {
      const emailChanged = formData.email !== (profile?.email || '');

      // If email changed, use edge function to update auth + profile
      if (emailChanged) {
        const { data: response, error: emailError } = await supabase.functions.invoke('update-user', {
          body: {
            target_user_id: user.id,
            email: formData.email,
            full_name: formData.full_name,
            phone: formData.phone,
            bio: formData.bio,
            skill_rating: formData.skill_rating ? parseFloat(formData.skill_rating) : null,
            rating_system: formData.rating_system,
            rating_member_id: formData.rating_member_id,
            birth_date: formData.birth_date || null,
          },
        });

        if (emailError) throw emailError;
        if (response?.error) throw new Error(response.error);

        toast({
          title: t('settings.emailChangeSent', 'Verification email sent'),
          description: t('settings.emailChangeDescription', 'Please check your new email address to confirm the change.'),
        });
      } else {
        // Update profile directly (no email change)
        const { error: profileError } = await supabase
          .from('profiles')
          .update({
            full_name: formData.full_name,
            phone: formData.phone,
            location: formData.location,
            bio: formData.bio,
            skill_rating: formData.skill_rating ? parseFloat(formData.skill_rating) : null,
            rating_system: formData.rating_system,
            rating_member_id: formData.rating_member_id,
            birth_date: formData.birth_date || null,
          })
          .eq('user_id', user.id);
        
        if (profileError) throw profileError;
      }

      // Update player locations if player
      if (role === 'player' && profile?.id) {
        await updatePlayerLocations(profile.id, selectedLocationIds, preferredLocationId);
      }

      // Update trainer profile if trainer
      if (role === 'trainer') {
        const certifications = trainerData.certifications;
        const specializations = trainerData.specializations;
        
        const { error: trainerError } = await supabase
          .from('trainer_profiles')
          .update({
            hourly_rate: trainerData.hourly_rate,
            coaching_since_year: trainerData.coaching_since_year,
            certifications,
            specializations,
            coaching_method: trainerData.coaching_method || null,
            favourite_quote: trainerData.favourite_quote || null,
            video_url: trainerData.video_url || null,
            social_instagram: trainerData.social_instagram || null,
            social_tiktok: trainerData.social_tiktok || null,
            social_youtube: trainerData.social_youtube || null,
            social_linkedin: trainerData.social_linkedin || null,
            preferred_min_rating: trainerData.preferred_min_rating,
            preferred_max_rating: trainerData.preferred_max_rating,
            preferred_rating_system: trainerData.preferred_rating_system,
          })
          .eq('user_id', user.id);
        
        if (trainerError) throw trainerError;

        // Update trainer locations
        const locationsData: TrainerLocationData[] = trainerLocations.map(loc => ({
          locationId: loc.locationId,
          relationshipType: loc.relationshipType,
          isPrimary: loc.isPrimary,
        }));
        await updateTrainerLocations(user.id, locationsData);
      }

      await refreshAuth();
      
      toast({
        title: t('editProfile.profileUpdated'),
        description: t('editProfile.profileUpdatedDescription'),
      });
      
      navigate(role === 'trainer' ? '/trainer' : '/player');
    } catch (error: any) {
      toast({
        title: t('editProfile.error'),
        description: error.message || t('editProfile.uploadFailed'),
        variant: 'destructive',
      });
    }
    
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const initials = formData.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase() || 'U';

  // Group rating systems by country for display
  const groupedSystems = ratingSystems.reduce((acc, system) => {
    const country = system.country;
    if (!acc[country]) acc[country] = [];
    acc[country].push(system);
    return acc;
  }, {} as Record<string, RatingSystemConfig[]>);

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/5">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="font-bold text-xl">{t('editProfile.title')}</span>
          </div>
          <Button onClick={handleSubmit} disabled={saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? t('editProfile.saving') : t('editProfile.save')}
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Visibility Toggle (trainers only) */}
          {role === 'trainer' && (
            <Card>
              <CardContent className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {isPublic ? (
                      <Eye className="h-5 w-5 text-primary" />
                    ) : (
                      <EyeOff className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div>
                      <h3 className="font-semibold">{tTrainer('profileVisibility.title')}</h3>
                      <p className="text-sm text-muted-foreground">
                        {isPublic
                          ? tTrainer('profileVisibility.statusPublic')
                          : tTrainer('profileVisibility.statusHidden')}
                      </p>
                    </div>
                  </div>
                  <Switch
                    checked={isPublic}
                    onCheckedChange={handleVisibilityToggle}
                    disabled={updatingVisibility}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Avatar Section */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="relative group">
                  <Avatar className="h-20 w-20">
                    <AvatarImage src={avatarUrl || undefined} />
                    <AvatarFallback className="text-2xl">{initials}</AvatarFallback>
                  </Avatar>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingAvatar}
                    className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    {uploadingAvatar ? (
                      <Loader2 className="h-6 w-6 text-white animate-spin" />
                    ) : (
                      <Camera className="h-6 w-6 text-white" />
                    )}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarUpload}
                    className="hidden"
                  />
                </div>
                <div>
                  <h3 className="font-semibold">{formData.full_name || t('editProfile.yourName')}</h3>
                  <p className="text-sm text-muted-foreground capitalize">{role || t('editProfile.user')}</p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-primary hover:underline mt-1"
                    disabled={uploadingAvatar}
                  >
                    {uploadingAvatar ? t('editProfile.uploading') : t('editProfile.changePhoto')}
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                {t('editProfile.basicInformation')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="full_name">{t('editProfile.fullName')}</Label>
                  <Input
                    id="full_name"
                    value={formData.full_name}
                    onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                    placeholder="John Doe"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  />
                  {formData.email !== (profile?.email || '') && (
                    <p className="text-xs text-muted-foreground">
                      {t('settings.emailChangeVerification', 'A verification email will be sent to your new address.')}
                    </p>
                  )}
                </div>
              </div>
              
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    placeholder="+31 6 12345678"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="location">Location</Label>
                  <Input
                    id="location"
                    value={formData.location}
                    onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                    placeholder="Amsterdam"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bio">Bio</Label>
                <Textarea
                  id="bio"
                  value={formData.bio}
                  onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
                  placeholder="Tell us about yourself..."
                  rows={4}
                />
              </div>
            </CardContent>
          </Card>

          {/* Player-specific fields */}
          {role === 'player' && (
            <Card>
              <CardHeader>
                <CardTitle>Player Details</CardTitle>
                <CardDescription>Your padel skill information</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="birth_date">{t('birthDate', 'Date of birth')}</Label>
                  <Input
                    id="birth_date"
                    type="date"
                    value={formData.birth_date}
                    onChange={(e) => setFormData({ ...formData, birth_date: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="rating_system">{t('ratingSystem.label')}</Label>
                  <Select
                    value={formData.rating_system}
                    onValueChange={(value) => {
                      setFormData({ ...formData, rating_system: value, skill_rating: '' });
                    }}
                    disabled={loadingRatingSystems}
                  >
                    <SelectTrigger id="rating_system">
                      <SelectValue placeholder={loadingRatingSystems ? 'Loading...' : 'Select rating system'} />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(groupedSystems).map(([country, systems]) => (
                        <div key={country}>
                          <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                            {COUNTRY_NAMES[country] || country}
                          </div>
                          {systems.map((system) => (
                            <SelectItem key={system.code} value={system.code}>
                              {system.name} ({system.min_rating} - {system.max_rating})
                            </SelectItem>
                          ))}
                        </div>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('ratingSystem.description')}
                  </p>
                </div>

                {/* Dynamic Member ID field */}
                {currentRatingSystem?.member_id_label && (
                  <div className="space-y-2">
                    <Label htmlFor="rating_member_id">{currentRatingSystem.member_id_label}</Label>
                    <Input
                      id="rating_member_id"
                      value={formData.rating_member_id}
                      onChange={(e) => setFormData({ ...formData, rating_member_id: e.target.value })}
                      placeholder={currentRatingSystem.member_id_placeholder || ''}
                    />
                    <p className="text-xs text-muted-foreground">
                      Your official {currentRatingSystem.name} registration number
                    </p>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="skill_rating">Padel Rating</Label>
                  <Input
                    id="skill_rating"
                    type="number"
                    step={currentRatingSystem?.step || 0.1}
                    min={currentRatingSystem?.min_rating || 0.1}
                    max={currentRatingSystem?.max_rating || 10}
                    value={formData.skill_rating}
                    onChange={(e) => setFormData({ ...formData, skill_rating: e.target.value })}
                    placeholder={currentRatingSystem?.max_rating?.toString() || ''}
                    disabled={!currentRatingSystem}
                  />
                  {currentRatingSystem && (
                    <p className="text-xs text-muted-foreground">
                      {currentRatingSystem.min_rating} - {currentRatingSystem.max_rating}
                      {currentRatingSystem.lower_is_better && ' (lower is better)'}
                    </p>
                  )}
                </div>
                
                {/* Preferred Padel Clubs Section */}
                <div className="space-y-2 pt-4 border-t">
                  <Label className="flex items-center gap-2">
                    <MapPin className="h-4 w-4" />
                    {t('profile.preferredClubs', 'Preferred Padel Clubs')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('profile.whereToTrain', 'Where do you want to train?')}
                  </p>
                  <LocationPicker
                    selectedLocationIds={selectedLocationIds}
                    onChange={setSelectedLocationIds}
                    primaryLocationId={preferredLocationId}
                    onPrimaryChange={setPreferredLocationId}
                    showPrimary={true}
                    disabled={loadingLocations}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Trainer-specific fields */}
          {role === 'trainer' && (
            <>
              {/* Profile Branding Card */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Sparkles className="h-5 w-5" />
                    {t('trainer:profile.branding', 'Profile Branding')}
                  </CardTitle>
                  <CardDescription>{t('trainer:profile.brandingDescription', 'Make your profile stand out')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Coaching Method */}
                  <div className="space-y-2">
                    <Label htmlFor="coaching_method">{t('trainer:profile.coachingMethod', 'My Coaching Style')}</Label>
                    <Textarea
                      id="coaching_method"
                      value={trainerData.coaching_method}
                      onChange={(e) => setTrainerData({ ...trainerData, coaching_method: e.target.value })}
                      placeholder={t('trainer:profile.coachingMethodPlaceholder', 'Describe your training philosophy...')}
                      maxLength={300}
                      rows={3}
                    />
                    <p className="text-xs text-muted-foreground text-right">
                      {trainerData.coaching_method.length}/300
                    </p>
                  </div>

                  {/* Favourite Quote */}
                  <div className="space-y-2">
                    <Label htmlFor="favourite_quote" className="flex items-center gap-2">
                      <Quote className="h-4 w-4" />
                      {t('trainer:profile.favouriteQuote', 'Favourite Quote')}
                    </Label>
                    <Input
                      id="favourite_quote"
                      value={trainerData.favourite_quote}
                      onChange={(e) => setTrainerData({ ...trainerData, favourite_quote: e.target.value })}
                      placeholder={t('trainer:profile.favouriteQuotePlaceholder', 'Share your favourite padel quote...')}
                      maxLength={150}
                    />
                  </div>

                  {/* Videos */}
                  {trainerProfileId && (
                    <VideoManager trainerProfileId={trainerProfileId} />
                  )}

                  {/* Social Media */}
                  <div className="space-y-4">
                    <Label className="flex items-center gap-2">
                      {t('trainer:profile.socialMedia', 'Social Media')}
                    </Label>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="social_instagram" className="text-xs text-muted-foreground flex items-center gap-1">
                          <Instagram className="h-3 w-3" />
                          Instagram
                        </Label>
                        <Input
                          id="social_instagram"
                          value={trainerData.social_instagram}
                          onChange={(e) => setTrainerData({ ...trainerData, social_instagram: e.target.value })}
                          placeholder="@username"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="social_tiktok" className="text-xs text-muted-foreground flex items-center gap-1">
                          <span className="text-xs font-bold">♪</span>
                          TikTok
                        </Label>
                        <Input
                          id="social_tiktok"
                          value={trainerData.social_tiktok}
                          onChange={(e) => setTrainerData({ ...trainerData, social_tiktok: e.target.value })}
                          placeholder="@username"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="social_youtube" className="text-xs text-muted-foreground flex items-center gap-1">
                          <Youtube className="h-3 w-3" />
                          YouTube
                        </Label>
                        <Input
                          id="social_youtube"
                          value={trainerData.social_youtube}
                          onChange={(e) => setTrainerData({ ...trainerData, social_youtube: e.target.value })}
                          placeholder="https://youtube.com/@channel"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="social_linkedin" className="text-xs text-muted-foreground flex items-center gap-1">
                          <Linkedin className="h-3 w-3" />
                          LinkedIn
                        </Label>
                        <Input
                          id="social_linkedin"
                          value={trainerData.social_linkedin}
                          onChange={(e) => setTrainerData({ ...trainerData, social_linkedin: e.target.value })}
                          placeholder="https://linkedin.com/in/..."
                        />
                      </div>
                    </div>
                  </div>

                  {/* Preferred Player Levels */}
                  <div className="space-y-4 pt-4 border-t">
                    <div>
                      <Label>{t('trainer:profile.preferredLevels', 'Preferred Player Levels')}</Label>
                      <p className="text-sm text-muted-foreground">
                        {t('trainer:profile.preferredLevelsDescription', 'Which skill levels do you most enjoy training?')}
                      </p>
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="preferred_rating_system" className="text-xs text-muted-foreground">Rating System</Label>
                      <Select
                        value={trainerData.preferred_rating_system}
                        onValueChange={(value) => {
                          const system = ratingSystems.find(s => s.code === value);
                          setTrainerData({ 
                            ...trainerData, 
                            preferred_rating_system: value,
                            preferred_min_rating: system?.min_rating || null,
                            preferred_max_rating: system?.max_rating || null,
                          });
                        }}
                        disabled={loadingRatingSystems}
                      >
                        <SelectTrigger id="preferred_rating_system">
                          <SelectValue placeholder="Select rating system" />
                        </SelectTrigger>
                        <SelectContent>
                          {ratingSystems.map((system) => (
                            <SelectItem key={system.code} value={system.code}>
                              {system.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {(() => {
                      const preferredSystem = ratingSystems.find(s => s.code === trainerData.preferred_rating_system);
                      if (!preferredSystem) return null;
                      
                      const minVal = trainerData.preferred_min_rating ?? preferredSystem.min_rating;
                      const maxVal = trainerData.preferred_max_rating ?? preferredSystem.max_rating;
                      
                      return (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Level range:</span>
                            <span className="font-medium">
                              {minVal.toFixed(1)} - {maxVal.toFixed(1)} ({preferredSystem.name})
                            </span>
                          </div>
                          <div className="px-2">
                            <Slider
                              value={[minVal, maxVal]}
                              min={preferredSystem.min_rating}
                              max={preferredSystem.max_rating}
                              step={preferredSystem.step}
                              onValueChange={([min, max]) => {
                                setTrainerData({
                                  ...trainerData,
                                  preferred_min_rating: Math.round(min * 10) / 10,
                                  preferred_max_rating: Math.round(max * 10) / 10,
                                });
                              }}
                            />
                            <div className="flex justify-between text-xs text-muted-foreground mt-1">
                              <span>{preferredSystem.min_rating}</span>
                              <span>{preferredSystem.max_rating}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </CardContent>
              </Card>

              {/* Trainer Details Card */}
              <Card>
                <CardHeader>
                  <CardTitle>Trainer Details</CardTitle>
                  <CardDescription>Your professional information</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="hourly_rate">Hourly Rate (€)</Label>
                      <Input
                        id="hourly_rate"
                        type="number"
                        step="0.01"
                        min="0"
                        value={trainerData.hourly_rate || ''}
                        onChange={(e) => setTrainerData({ 
                          ...trainerData, 
                          hourly_rate: e.target.value ? parseFloat(e.target.value) : null 
                        })}
                        placeholder="50.00"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="coaching_since_year">Coaching Since (year)</Label>
                      <Input
                        id="coaching_since_year"
                        type="number"
                        min="1970"
                        max={new Date().getFullYear()}
                        value={trainerData.coaching_since_year || ''}
                        onChange={(e) => setTrainerData({ 
                          ...trainerData, 
                          coaching_since_year: e.target.value ? parseInt(e.target.value) : null 
                        })}
                        placeholder={`e.g. ${new Date().getFullYear() - 5}`}
                      />
                    </div>
                  </div>

                  <div className="space-y-4">
                    <Label>Your Padel Rating</Label>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="trainer_rating_system" className="text-xs text-muted-foreground">Rating System</Label>
                        <Select
                          value={formData.rating_system}
                          onValueChange={(value) => {
                            setFormData({ 
                              ...formData, 
                              rating_system: value,
                              skill_rating: '', // Reset rating when system changes
                            });
                          }}
                          disabled={loadingRatingSystems}
                        >
                          <SelectTrigger id="trainer_rating_system">
                            <SelectValue placeholder="Select rating system" />
                          </SelectTrigger>
                          <SelectContent>
                            {ratingSystems.map((system) => (
                              <SelectItem key={system.code} value={system.code}>
                                {system.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="trainer_rating" className="text-xs text-muted-foreground">Rating</Label>
                        {(() => {
                          return (
                            <>
                              <Input
                                id="trainer_rating"
                                type="number"
                                step={currentRatingSystem?.step || 0.1}
                                min={currentRatingSystem?.min_rating || 0.1}
                                max={currentRatingSystem?.max_rating || 10}
                                value={formData.skill_rating}
                                onChange={(e) => setFormData({ 
                                  ...formData, 
                                  skill_rating: e.target.value 
                                })}
                                placeholder={currentRatingSystem?.max_rating?.toString() || ''}
                                disabled={!currentRatingSystem}
                              />
                              {currentRatingSystem && (
                                <p className="text-xs text-muted-foreground">
                                  {currentRatingSystem.min_rating} - {currentRatingSystem.max_rating}
                                  {currentRatingSystem.lower_is_better && ' (lower is better)'}
                                </p>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label>Certifications</Label>
                    <CertificationsPicker
                      selectedCertifications={trainerData.certifications}
                      onChange={(certs) => setTrainerData({ ...trainerData, certifications: certs })}
                      trainerCountry={trainerCountry}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Specializations</Label>
                    <SpecializationsPicker
                      selectedSpecializations={trainerData.specializations}
                      onChange={(specs) => setTrainerData({ ...trainerData, specializations: specs })}
                    />
                  </div>

                  {/* Trainer Teaching Locations */}
                  <div className="space-y-2 pt-4 border-t">
                    <Label className="flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      Teaching Locations
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Where do you offer training? Mark yourself as 'Club Trainer' if you're employed by the club.
                    </p>
                    <TrainerLocationPicker
                      selectedLocations={trainerLocations}
                      onChange={setTrainerLocations}
                      disabled={loadingLocations}
                    />
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </form>
      </main>

      {/* Upgrade Dialog */}
      <Dialog open={showUpgradeDialog} onOpenChange={setShowUpgradeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tTrainer('profileVisibility.upgradeTitle')}</DialogTitle>
            <DialogDescription>
              {tTrainer('profileVisibility.upgradeBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col gap-2 sm:flex-col">
            <Button onClick={() => { setShowUpgradeDialog(false); navigate('/app/trainer/subscription'); }}>
              {tTrainer('profileVisibility.upgradePrimary')}
            </Button>
            <Button variant="outline" onClick={() => { setShowUpgradeDialog(false); navigate(getLocalizedPath('/pricing')); }}>
              {tTrainer('profileVisibility.upgradeSecondary')}
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-2">
              {tTrainer('profileVisibility.upgradeSmall')}
            </p>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
