import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, Camera, Save, Trash2 } from 'lucide-react';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { supabase } from '@/lib/supabaseClient';
import { CertificationsPicker } from '@/components/profiles/CertificationsPicker';
import { SpecializationsPicker } from '@/components/profiles/SpecializationsPicker';
import { getRatingSystems, RatingSystemConfig, COUNTRY_NAMES } from '@/lib/ratingSystems';
import { getTrainerCountry } from '@/lib/certifications';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { removeAcademyTrainer, getAcademyLocations } from '@/lib/academy';
import { toast as sonnerToast } from 'sonner';

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
  preferred_rating_system: string | null;
  is_public: boolean;
}

interface ProfileData {
  full_name: string;
  phone: string;
  email: string;
  bio: string;
  location: string;
  avatar_url: string | null;
  skill_rating: number | null;
  rating_system: string | null;
  rating_member_id: string | null;
}

export default function AcademyTrainerDetail() {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const navigate = useNavigate();
  const { trainerId } = useParams<{ trainerId: string }>();
  const { activeAcademy } = useAcademyContext();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The trainerId param is the academy_trainers.id
  const [trainerProfileId, setTrainerProfileId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [academyLocations, setAcademyLocations] = useState<any[]>([]);

  const [profileData, setProfileData] = useState<ProfileData>({
    full_name: '',
    phone: '',
    email: '',
    bio: '',
    location: '',
    avatar_url: null,
    skill_rating: null,
    rating_system: null,
    rating_member_id: null,
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
    preferred_rating_system: null,
    is_public: false,
  });
  // Banner is fetched/written separately: the column ships in migration 20260709100000,
  // so bundling it into the main select/save would break this page on a pre-migration DB.
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  const [assignedLocationIds, setAssignedLocationIds] = useState<Set<string>>(new Set());
  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [trainerCountry, setTrainerCountry] = useState<string>('NL');

  useEffect(() => {
    if (trainerId && activeAcademy) {
      fetchData();
    }
  }, [trainerId, activeAcademy]);

  const fetchData = async () => {
    if (!trainerId || !activeAcademy) return;
    setLoading(true);
    try {
      // First get the academy_trainer record to find trainer_profile_id
      const { data: academyTrainer } = await supabase
        .from('academy_trainers')
        .select('trainer_profile_id')
        .eq('id', trainerId)
        .single();

      if (!academyTrainer) {
        navigate('/app/academy/trainers');
        return;
      }

      const tpId = academyTrainer.trainer_profile_id;
      setTrainerProfileId(tpId);

      // Get trainer_profile to find user_id
      const { data: trainerProfile } = await supabase
        .from('trainer_profiles')
        .select('user_id, hourly_rate, coaching_since_year, certifications, specializations, coaching_method, favourite_quote, video_url, website_url, social_instagram, social_tiktok, social_youtube, social_linkedin, preferred_min_rating, preferred_max_rating, preferred_rating_system, is_public')
        .eq('id', tpId)
        .single();

      if (!trainerProfile) {
        navigate('/app/academy/trainers');
        return;
      }

      const uid = trainerProfile.user_id;
      setUserId(uid);

      // Fetch in parallel: systems, country, profile, locations, trainer_locations
      const [systems, country, profileResult, locationsData, trainerLocsResult] = await Promise.all([
        getRatingSystems(),
        getTrainerCountry(uid),
        supabase.from('profiles').select('full_name, phone, email, bio, location, avatar_url, skill_rating, rating_system, rating_member_id').eq('user_id', uid).single(),
        getAcademyLocations(activeAcademy.id),
        supabase.from('trainer_locations').select('location_id').eq('trainer_id', tpId),
      ]);

      setRatingSystems(systems);
      setTrainerCountry(country);
      setAcademyLocations(locationsData);

      if (profileResult.data) {
        const p = profileResult.data;
        setProfileData({
          full_name: p.full_name || '',
          phone: p.phone || '',
          email: p.email || '',
          bio: p.bio || '',
          location: p.location || '',
          avatar_url: p.avatar_url,
          skill_rating: p.skill_rating,
          rating_system: p.rating_system,
          rating_member_id: p.rating_member_id,
        });
      }

      // Single typed view over the row for columns the stale generated types miss.
      const tpRow = trainerProfile as unknown as {
        coaching_since_year: number | null;
        social_tiktok: string | null;
        preferred_min_rating: number | null;
        preferred_max_rating: number | null;
        preferred_rating_system: string | null;
        is_public: boolean | null;
      };
      setTrainerData({
        hourly_rate: trainerProfile.hourly_rate,
        coaching_since_year: tpRow.coaching_since_year,
        certifications: trainerProfile.certifications || [],
        specializations: trainerProfile.specializations || [],
        coaching_method: trainerProfile.coaching_method || '',
        favourite_quote: trainerProfile.favourite_quote || '',
        video_url: trainerProfile.video_url || '',
        website_url: trainerProfile.website_url || '',
        social_instagram: trainerProfile.social_instagram || '',
        social_tiktok: tpRow.social_tiktok || '',
        social_youtube: trainerProfile.social_youtube || '',
        social_linkedin: trainerProfile.social_linkedin || '',
        preferred_min_rating: tpRow.preferred_min_rating ?? null,
        preferred_max_rating: tpRow.preferred_max_rating ?? null,
        preferred_rating_system: tpRow.preferred_rating_system ?? null,
        is_public: tpRow.is_public === true,
      });

      // Best-effort banner read, separate from the main select: on a DB without
      // migration 20260709100000 this fails with 42703 and the page still works.
      const { data: bannerRow } = await supabase
        .from('trainer_profiles')
        .select('banner_url' as never)
        .eq('id', tpId)
        .maybeSingle();
      setBannerUrl(((bannerRow as { banner_url?: string | null } | null)?.banner_url) ?? null);

      if (trainerLocsResult.data) {
        setAssignedLocationIds(new Set(trainerLocsResult.data.map((tl) => tl.location_id)));
      }
    } catch (error) {
      logger.error('Error fetching trainer data', error instanceof Error ? error : new Error(String(error)), { component: 'AcademyTrainerDetail' });
    } finally {
      setLoading(false);
    }
  };

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !userId) return;

    if (!file.type.startsWith('image/')) {
      toast({ title: t('common.error'), description: t('trainers.selectImageFile', 'Please select an image file'), variant: 'destructive' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: t('common.error'), description: t('trainers.selectImageSizeLimit', 'Please select an image smaller than 5MB'), variant: 'destructive' });
      return;
    }

    setUploadingAvatar(true);
    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${userId}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage.from('avatars').upload(filePath, file, { upsert: true });
      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath);
      const urlWithTimestamp = `${publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase.from('profiles').update({ avatar_url: urlWithTimestamp }).eq('user_id', userId);
      if (updateError) throw updateError;

      setProfileData(prev => ({ ...prev, avatar_url: urlWithTimestamp }));
      toast({ title: t('trainers.avatarUpdated', 'Avatar updated'), description: t('trainers.avatarUpdatedDescription', "The trainer's profile picture has been updated.") });
    } catch (error: any) {
      logger.error('Avatar upload error', error instanceof Error ? error : new Error(String(error)), { component: 'AcademyTrainerDetail' });
      toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('trainers.failedUploadAvatar', 'Failed to upload avatar')), variant: 'destructive' });
    } finally {
      setUploadingAvatar(false);
    }
  };

  // Mirrors the academy's own banner upload (AcademyProfile): same bucket, the
  // trainer's user-id folder (covered by the academy-managers storage policy),
  // written immediately like the avatar — deliberately NOT part of the save
  // payload so the rest of the page keeps working on a pre-migration DB.
  const handleBannerUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !userId || !trainerProfileId) return;

    if (!file.type.startsWith('image/')) {
      toast({ title: t('common.error'), description: t('trainers.selectImageFile', 'Please select an image file'), variant: 'destructive' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: t('common.error'), description: t('trainers.selectBannerSizeLimit', 'Please select an image smaller than 10MB'), variant: 'destructive' });
      return;
    }

    setUploadingBanner(true);
    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${userId}/banner.${fileExt}`;

      const { error: uploadError } = await supabase.storage.from('avatars').upload(filePath, file, { upsert: true });
      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(filePath);
      const urlWithTimestamp = `${publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from('trainer_profiles')
        .update({ banner_url: urlWithTimestamp } as never)
        .eq('id', trainerProfileId);
      if (updateError) throw updateError;

      setBannerUrl(urlWithTimestamp);
      toast({ title: t('trainers.bannerUpdated', 'Banner updated'), description: t('trainers.bannerUpdatedDescription', "The trainer's public page banner has been updated.") });
    } catch (error) {
      logger.error('Banner upload error', error instanceof Error ? error : new Error(String(error)), { component: 'AcademyTrainerDetail' });
      toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('trainers.failedUploadBanner', 'Failed to upload banner')), variant: 'destructive' });
    } finally {
      setUploadingBanner(false);
    }
  };

  const handleLocationToggle = (locationId: string, checked: boolean) => {
    setAssignedLocationIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(locationId);
      else next.delete(locationId);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!trainerProfileId || !userId) return;
    setSaving(true);

    try {
      // Update profile via edge function (bypasses RLS)
      const { data: updateResult, error: updateError } = await supabase.functions.invoke('update-user', {
        body: {
          target_user_id: userId,
          trainer_profile_id: trainerProfileId,
          full_name: profileData.full_name,
          phone: profileData.phone,
          bio: profileData.bio,
          avatar_url: profileData.avatar_url,
          skill_rating: profileData.skill_rating,
          rating_system: profileData.rating_system || 'none',
          rating_member_id: profileData.rating_member_id,
        },
      });

      if (updateError) throw updateError;
      if (updateResult?.error) throw new Error(updateResult.error);

      // City lives on profiles but update-user doesn't accept it; the academy-managers
      // profiles UPDATE policy (20260404145156) covers this direct write.
      const { error: locationError } = await supabase
        .from('profiles')
        .update({ location: profileData.location || null })
        .eq('user_id', userId);
      if (locationError) throw locationError;

      // Update trainer profile
      const { error: trainerError } = await supabase
        .from('trainer_profiles')
        .update({
          hourly_rate: trainerData.hourly_rate,
          coaching_since_year: trainerData.coaching_since_year,
          certifications: trainerData.certifications,
          specializations: trainerData.specializations,
          coaching_method: trainerData.coaching_method || null,
          favourite_quote: trainerData.favourite_quote || null,
          video_url: trainerData.video_url || null,
          website_url: trainerData.website_url || null,
          social_instagram: trainerData.social_instagram || null,
          social_tiktok: trainerData.social_tiktok || null,
          social_youtube: trainerData.social_youtube || null,
          social_linkedin: trainerData.social_linkedin || null,
          preferred_min_rating: trainerData.preferred_min_rating,
          preferred_max_rating: trainerData.preferred_max_rating,
          preferred_rating_system: trainerData.preferred_rating_system,
          is_public: trainerData.is_public,
        } as never)
        .eq('id', trainerProfileId);

      if (trainerError) throw trainerError;

      // Sync trainer_locations
      const academyLocationIds = academyLocations.map((al) => al.location?.id).filter(Boolean);
      const { data: currentLocs } = await supabase
        .from('trainer_locations')
        .select('id, location_id')
        .eq('trainer_id', trainerProfileId)
        .in('location_id', academyLocationIds.length > 0 ? academyLocationIds : ['__none__']);

      const currentLocIds = new Set((currentLocs || []).map((l) => l.location_id));

      const toAdd = academyLocationIds.filter((id: string) => assignedLocationIds.has(id) && !currentLocIds.has(id));
      if (toAdd.length > 0) {
        await supabase.from('trainer_locations').insert(
          toAdd.map((locationId: string) => ({
            trainer_id: trainerProfileId,
            location_id: locationId,
            relationship_type: 'academy_trainer',
            show_on_club_page: true,
          }))
        );
      }

      const toRemove = (currentLocs || []).filter((l) => !assignedLocationIds.has(l.location_id));
      if (toRemove.length > 0) {
        await supabase.from('trainer_locations').delete().in('id', toRemove.map((l) => l.id));
      }

      toast({ title: t('trainers.updated'), description: t('trainers.updatedDescription') });
      navigate('/app/academy/trainers');
    } catch (error: any) {
      logger.error('Error updating trainer', error instanceof Error ? error : new Error(String(error)), { component: 'AcademyTrainerDetail' });
      toast({ title: t('common.error'), description: getFriendlyErrorMessage(error, t('trainers.failedUpdateProfile', 'Failed to update trainer profile')), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveTrainer = async () => {
    if (!trainerId) return;
    setRemoving(true);
    try {
      const success = await removeAcademyTrainer(trainerId);
      if (success) {
        sonnerToast.success(t('trainers.removed'));
        navigate('/app/academy/trainers');
      } else {
        sonnerToast.error(t('trainers.failedRemove', 'Failed to remove trainer'));
      }
    } finally {
      setRemoving(false);
      setConfirmRemoveOpen(false);
    }
  };

  const initials = profileData.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'T';

  const groupedSystems = ratingSystems.reduce((acc, system) => {
    const country = system.country;
    if (!acc[country]) acc[country] = [];
    acc[country].push(system);
    return acc;
  }, {} as Record<string, RatingSystemConfig[]>);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <Skeleton className="h-8 w-32 mb-6" />
        <Skeleton className="h-20 w-20 rounded-full mb-4" />
        <Skeleton className="h-10 w-full mb-4" />
        <Skeleton className="h-10 w-full mb-4" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/app/academy/trainers')}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('trainers.title')}
        </Button>
        <Button onClick={handleSubmit} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          <Save className="h-4 w-4 mr-2" />
          {t('common.save')}
        </Button>
      </div>

      <div className="space-y-6">
        {/* Avatar & Name */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="relative group">
                <Avatar className="h-20 w-20">
                  <AvatarImage src={profileData.avatar_url || undefined} />
                  <AvatarFallback className="text-xl">{initials}</AvatarFallback>
                </Avatar>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  {uploadingAvatar ? (
                    <Loader2 className="h-5 w-5 text-white animate-spin" />
                  ) : (
                    <Camera className="h-5 w-5 text-white" />
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
                <h2 className="text-xl font-semibold">{profileData.full_name || t('trainers.trainerFallback', 'Trainer')}</h2>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-sm text-primary hover:underline"
                  disabled={uploadingAvatar}
                >
                  {uploadingAvatar ? t('common.uploading', 'Uploading...') : t('trainers.changePhoto', 'Change photo')}
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Public page banner */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <CardTitle className="text-base">{t('trainers.banner', 'Public page banner')}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {t('trainers.bannerDescription', "Shown across the top of the trainer's public page. Without one, your academy banner is used.")}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {bannerUrl ? (
              <img
                src={bannerUrl}
                alt={t('trainers.banner', 'Public page banner')}
                className="w-full h-32 object-cover rounded-md border"
              />
            ) : (
              <div className="w-full h-32 rounded-md border border-dashed flex items-center justify-center text-sm text-muted-foreground">
                {t('trainers.noBanner', 'No banner uploaded yet')}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploadingBanner}
              onClick={() => bannerInputRef.current?.click()}
            >
              {uploadingBanner ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Camera className="h-4 w-4 mr-2" />
              )}
              {bannerUrl ? t('trainers.changeBanner', 'Change banner') : t('trainers.uploadBanner', 'Upload banner')}
            </Button>
            <input
              ref={bannerInputRef}
              type="file"
              accept="image/*"
              onChange={handleBannerUpload}
              className="hidden"
            />
          </CardContent>
        </Card>

        {/* Basic Info */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <CardTitle className="text-base">{t('trainers.basicInfo', 'Basic Information')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="full_name">{t('trainers.fullName', 'Full Name')}</Label>
                <Input
                  id="full_name"
                  value={profileData.full_name}
                  onChange={(e) => setProfileData({ ...profileData, full_name: e.target.value })}
                  placeholder={t('trainers.fullNamePlaceholder', 'John Doe')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">{t('trainers.phone', 'Phone')}</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={profileData.phone}
                  onChange={(e) => setProfileData({ ...profileData, phone: e.target.value })}
                  placeholder="+31 6 12345678"
                />
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t('trainers.email', 'Email')}</Label>
                <Input id="email" type="email" value={profileData.email} disabled className="bg-muted" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="location">{t('trainers.location', 'City')}</Label>
                <Input
                  id="location"
                  value={profileData.location}
                  onChange={(e) => setProfileData({ ...profileData, location: e.target.value })}
                  placeholder={t('trainers.locationPlaceholder', 'Amsterdam')}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bio">{t('trainers.bio', 'Bio')}</Label>
              <Textarea
                id="bio"
                value={profileData.bio}
                onChange={(e) => setProfileData({ ...profileData, bio: e.target.value })}
                placeholder={t('trainers.bioPlaceholder', 'Write a short bio about the trainer...')}
                rows={3}
              />
            </div>
          </CardContent>
        </Card>

        {/* Trainer Details */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <CardTitle className="text-base">{t('trainers.trainerDetails', 'Trainer Details')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="hourly_rate">{t('trainers.hourlyRate', 'Hourly Rate (€)')}</Label>
                <Input
                  id="hourly_rate"
                  type="number"
                  min="0"
                  step="0.01"
                  value={trainerData.hourly_rate ?? ''}
                  onChange={(e) => setTrainerData({ ...trainerData, hourly_rate: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder="50"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="experience">{t('trainers.coachingSince', 'Coaching Since (year)')}</Label>
                <Input
                  id="experience"
                  type="number"
                  min="1970"
                  max={new Date().getFullYear()}
                  value={trainerData.coaching_since_year ?? ''}
                  onChange={(e) => setTrainerData({ ...trainerData, coaching_since_year: e.target.value ? parseInt(e.target.value) : null })}
                  placeholder={t('trainers.coachingSincePlaceholder', 'e.g. {{year}}', { year: new Date().getFullYear() - 5 })}
                />
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="rating_system">{t('trainers.ratingSystem', 'Rating System')}</Label>
                <Select
                  value={profileData.rating_system || ''}
                  onValueChange={(value) => setProfileData({ ...profileData, rating_system: value })}
                >
                  <SelectTrigger id="rating_system">
                    <SelectValue placeholder={t('trainers.selectRatingSystem', 'Select rating system')} />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(groupedSystems).map(([country, systems]) => (
                      <div key={country}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                          {COUNTRY_NAMES[country] || country}
                        </div>
                        {systems.map((system) => (
                          <SelectItem key={system.code} value={system.code}>
                            {system.name}
                          </SelectItem>
                        ))}
                      </div>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rating">{t('trainers.rating', 'Rating')}</Label>
                <Input
                  id="rating"
                  type="number"
                  step="0.1"
                  value={profileData.skill_rating ?? ''}
                  onChange={(e) => setProfileData({ ...profileData, skill_rating: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder="8.0"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('trainers.certifications', 'Certifications')}</Label>
              <CertificationsPicker
                selectedCertifications={trainerData.certifications}
                onChange={(certs) => setTrainerData({ ...trainerData, certifications: certs })}
                trainerCountry={trainerCountry}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('trainers.specializations', 'Specializations')}</Label>
              <SpecializationsPicker
                selectedSpecializations={trainerData.specializations}
                onChange={(specs) => setTrainerData({ ...trainerData, specializations: specs })}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('trainers.preferredLevels', 'Preferred player level range')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('trainers.preferredLevelsDescription', 'Shown on the public page as the level range this trainer coaches.')}
              </p>
              <div className="grid sm:grid-cols-3 gap-4">
                <Select
                  value={trainerData.preferred_rating_system || ''}
                  onValueChange={(value) => setTrainerData({ ...trainerData, preferred_rating_system: value })}
                >
                  <SelectTrigger aria-label={t('trainers.ratingSystem', 'Rating System')}>
                    <SelectValue placeholder={t('trainers.selectRatingSystem', 'Select rating system')} />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(groupedSystems).map(([country, systems]) => (
                      <div key={country}>
                        <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                          {COUNTRY_NAMES[country] || country}
                        </div>
                        {systems.map((system) => (
                          <SelectItem key={system.code} value={system.code}>
                            {system.name}
                          </SelectItem>
                        ))}
                      </div>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  step="0.1"
                  value={trainerData.preferred_min_rating ?? ''}
                  onChange={(e) => setTrainerData({ ...trainerData, preferred_min_rating: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder={t('trainers.minRating', 'Min')}
                  aria-label={t('trainers.minRating', 'Min')}
                />
                <Input
                  type="number"
                  step="0.1"
                  value={trainerData.preferred_max_rating ?? ''}
                  onChange={(e) => setTrainerData({ ...trainerData, preferred_max_rating: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder={t('trainers.maxRating', 'Max')}
                  aria-label={t('trainers.maxRating', 'Max')}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Locations */}
        {academyLocations.length > 0 && (
          <Card className={flushOnMobileCardClass()}>
            <CardHeader>
              <CardTitle className="text-base">{t('trainers.assignLocations', 'Assign Locations')}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {t('trainers.assignLocationsDescription', 'Select which locations this trainer is active at.')}
              </p>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {academyLocations.map((al) => {
                  const location = al.location;
                  if (!location) return null;
                  return (
                    <div key={al.id} className="flex items-center gap-3 py-1.5">
                      <Checkbox
                        id={`loc-${location.id}`}
                        checked={assignedLocationIds.has(location.id)}
                        onCheckedChange={(checked) => handleLocationToggle(location.id, checked === true)}
                      />
                      <label htmlFor={`loc-${location.id}`} className="text-sm font-medium cursor-pointer">
                        {location.name}
                        {location.city && (
                          <span className="text-muted-foreground font-normal ml-1">— {location.city}</span>
                        )}
                      </label>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Additional Info */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader>
            <CardTitle className="text-base">{t('trainers.additionalInfo', 'Additional Information')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="coaching_method">{t('trainers.coachingMethod', 'Coaching Method')}</Label>
              <Textarea
                id="coaching_method"
                value={trainerData.coaching_method}
                onChange={(e) => setTrainerData({ ...trainerData, coaching_method: e.target.value })}
                placeholder={t('trainers.coachingMethodPlaceholder', 'Describe coaching methodology...')}
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="favourite_quote">{t('trainers.favouriteQuote', 'Favourite Quote')}</Label>
              <Input
                id="favourite_quote"
                value={trainerData.favourite_quote}
                onChange={(e) => setTrainerData({ ...trainerData, favourite_quote: e.target.value })}
                placeholder={t('trainers.favouriteQuotePlaceholder', 'A motivational quote...')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="video_url">{t('trainers.videoUrl', 'Video URL')}</Label>
              <Input
                id="video_url"
                value={trainerData.video_url}
                onChange={(e) => setTrainerData({ ...trainerData, video_url: e.target.value })}
                placeholder="https://youtube.com/..."
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="website_url">{t('trainers.websiteUrl', 'Website')}</Label>
              <Input
                id="website_url"
                value={trainerData.website_url}
                onChange={(e) => setTrainerData({ ...trainerData, website_url: e.target.value })}
                placeholder="https://..."
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="social_instagram">Instagram</Label>
                <Input
                  id="social_instagram"
                  value={trainerData.social_instagram}
                  onChange={(e) => setTrainerData({ ...trainerData, social_instagram: e.target.value })}
                  placeholder={t('trainers.instagramPlaceholder', '@username')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="social_tiktok">TikTok</Label>
                <Input
                  id="social_tiktok"
                  value={trainerData.social_tiktok}
                  onChange={(e) => setTrainerData({ ...trainerData, social_tiktok: e.target.value })}
                  placeholder={t('trainers.tiktokPlaceholder', '@username')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="social_youtube">YouTube</Label>
                <Input
                  id="social_youtube"
                  value={trainerData.social_youtube}
                  onChange={(e) => setTrainerData({ ...trainerData, social_youtube: e.target.value })}
                  placeholder={t('trainers.youtubePlaceholder', 'Channel URL')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="social_linkedin">LinkedIn</Label>
                <Input
                  id="social_linkedin"
                  value={trainerData.social_linkedin}
                  onChange={(e) => setTrainerData({ ...trainerData, social_linkedin: e.target.value })}
                  placeholder={t('trainers.linkedinPlaceholder', 'Profile URL')}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Public visibility */}
        <Card className={flushOnMobileCardClass()}>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{t('trainers.publicProfile', 'Public profile')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('trainers.publicProfileDescription', "Controls whether this trainer's public page is visible. Your academy subscription covers the trainer's page.")}
                </p>
              </div>
              <Switch
                checked={trainerData.is_public}
                onCheckedChange={(checked) => setTrainerData({ ...trainerData, is_public: checked === true })}
                aria-label={t('trainers.publicProfile', 'Public profile')}
              />
            </div>
          </CardContent>
        </Card>

        {/* Danger Zone */}
        <Card className="border-destructive/20">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-destructive">{t('trainers.removeTitle', 'Remove Trainer')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('trainers.removeDescription', 'This will remove the trainer from your academy.')}
                </p>
              </div>
              <Button variant="destructive" size="sm" onClick={() => setConfirmRemoveOpen(true)}>
                <Trash2 className="h-4 w-4 mr-2" />
                {t('trainers.remove', 'Remove')}
              </Button>
              <ConfirmDialog
                open={confirmRemoveOpen}
                onOpenChange={setConfirmRemoveOpen}
                title={t('trainers.removeTitle')}
                description={t('trainers.removeDescription')}
                confirmLabel={t('trainers.remove')}
                cancelLabel={t('common:cancel')}
                loading={removing}
                onConfirm={handleRemoveTrainer}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
