import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Loader2, Camera, Save } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { CertificationsPicker } from '@/components/trainer/CertificationsPicker';
import { SpecializationsPicker } from '@/components/trainer/SpecializationsPicker';
import { getRatingSystems, RatingSystemConfig, COUNTRY_NAMES } from '@/lib/ratingSystems';
import { getTrainerCountry } from '@/lib/certifications';

interface EditClubTrainerDialogProps {
  trainerId: string; // trainer_profiles.id
  userId: string; // auth user id
  trainerName: string;
  onTrainerUpdated: () => void;
}

interface TrainerProfileData {
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[];
  specializations: string[];
  coaching_method: string;
  favourite_quote: string;
  video_url: string;
  social_instagram: string;
  social_youtube: string;
  social_linkedin: string;
  preferred_min_rating: number | null;
  preferred_max_rating: number | null;
  preferred_rating_system: string;
}

interface ProfileData {
  full_name: string;
  phone: string;
  bio: string;
  avatar_url: string | null;
  skill_rating: number | null;
  rating_system: string | null;
  rating_member_id: string | null;
}

export function EditClubTrainerDialog({
  trainerId,
  userId,
  trainerName,
  onTrainerUpdated,
}: EditClubTrainerDialogProps) {
  const { t } = useTranslation('club');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [profileData, setProfileData] = useState<ProfileData>({
    full_name: '',
    phone: '',
    bio: '',
    avatar_url: null,
    skill_rating: null,
    rating_system: null,
    rating_member_id: null,
  });

  const [trainerData, setTrainerData] = useState<TrainerProfileData>({
    hourly_rate: null,
    experience_years: null,
    certifications: [],
    specializations: [],
    coaching_method: '',
    favourite_quote: '',
    video_url: '',
    social_instagram: '',
    social_youtube: '',
    social_linkedin: '',
    preferred_min_rating: null,
    preferred_max_rating: null,
    preferred_rating_system: 'knltb',
  });

  const [ratingSystems, setRatingSystems] = useState<RatingSystemConfig[]>([]);
  const [trainerCountry, setTrainerCountry] = useState<string>('NL');

  useEffect(() => {
    if (open) {
      fetchData();
    }
  }, [open, trainerId, userId]);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Fetch rating systems
      const systems = await getRatingSystems();
      setRatingSystems(systems);

      // Fetch trainer country
      const country = await getTrainerCountry(userId);
      setTrainerCountry(country);

      // Fetch profile data from profiles table (club managers have RLS access via policies)
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, phone, bio, avatar_url, skill_rating, rating_system, rating_member_id')
        .eq('user_id', userId)
        .single();

      if (profile) {
        setProfileData({
          full_name: profile.full_name || '',
          phone: profile.phone || '',
          bio: profile.bio || '',
          avatar_url: profile.avatar_url,
          skill_rating: profile.skill_rating,
          rating_system: profile.rating_system,
          rating_member_id: profile.rating_member_id,
        });
      }

      // Fetch trainer profile data
      const { data: trainer } = await supabase
        .from('trainer_profiles')
        .select('hourly_rate, experience_years, certifications, specializations, coaching_method, favourite_quote, video_url, social_instagram, social_youtube, social_linkedin, preferred_min_rating, preferred_max_rating, preferred_rating_system')
        .eq('id', trainerId)
        .single();

      if (trainer) {
        setTrainerData({
          hourly_rate: trainer.hourly_rate,
          experience_years: trainer.experience_years,
          certifications: trainer.certifications || [],
          specializations: trainer.specializations || [],
          coaching_method: trainer.coaching_method || '',
          favourite_quote: trainer.favourite_quote || '',
          video_url: trainer.video_url || '',
          social_instagram: trainer.social_instagram || '',
          social_youtube: trainer.social_youtube || '',
          social_linkedin: trainer.social_linkedin || '',
          preferred_min_rating: trainer.preferred_min_rating,
          preferred_max_rating: trainer.preferred_max_rating,
          preferred_rating_system: trainer.preferred_rating_system || 'knltb',
        });
      }
    } catch (error) {
      console.error('Error fetching trainer data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({
        title: t('createTrainer.error'),
        description: 'Please select an image file',
        variant: 'destructive',
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t('createTrainer.error'),
        description: 'Please select an image smaller than 5MB',
        variant: 'destructive',
      });
      return;
    }

    setUploadingAvatar(true);

    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `${userId}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);

      const urlWithTimestamp = `${publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: urlWithTimestamp })
        .eq('user_id', userId);

      if (updateError) throw updateError;

      setProfileData(prev => ({ ...prev, avatar_url: urlWithTimestamp }));

      toast({
        title: 'Avatar updated',
        description: 'The trainer\'s profile picture has been updated.',
      });
    } catch (error: any) {
      console.error('Avatar upload error:', error);
      toast({
        title: t('createTrainer.error'),
        description: error.message || 'Failed to upload avatar',
        variant: 'destructive',
      });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      // Update profile via edge function (bypasses RLS)
      const { data: updateResult, error: updateError } = await supabase.functions.invoke('update-user', {
        body: {
          target_user_id: userId,
          trainer_profile_id: trainerId,
          full_name: profileData.full_name,
          phone: profileData.phone,
          bio: profileData.bio,
          avatar_url: profileData.avatar_url,
          skill_rating: profileData.skill_rating,
          rating_system: profileData.rating_system,
          rating_member_id: profileData.rating_member_id,
        },
      });

      if (updateError) throw updateError;
      if (updateResult?.error) throw new Error(updateResult.error);

      // Update trainer profile (direct update works due to trainer_profiles RLS)
      const { error: trainerError } = await supabase
        .from('trainer_profiles')
        .update({
          hourly_rate: trainerData.hourly_rate,
          experience_years: trainerData.experience_years,
          certifications: trainerData.certifications,
          specializations: trainerData.specializations,
          coaching_method: trainerData.coaching_method || null,
          favourite_quote: trainerData.favourite_quote || null,
          video_url: trainerData.video_url || null,
          social_instagram: trainerData.social_instagram || null,
          social_youtube: trainerData.social_youtube || null,
          social_linkedin: trainerData.social_linkedin || null,
          preferred_min_rating: trainerData.preferred_min_rating,
          preferred_max_rating: trainerData.preferred_max_rating,
          preferred_rating_system: trainerData.preferred_rating_system || null,
        })
        .eq('id', trainerId);

      if (trainerError) throw trainerError;

      toast({
        title: t('editTrainer.success', 'Profile Updated'),
        description: t('editTrainer.successDescription', 'The trainer profile has been updated.'),
      });

      onTrainerUpdated();
      setOpen(false);
    } catch (error: any) {
      console.error('Error updating trainer:', error);
      toast({
        title: t('createTrainer.error'),
        description: error.message || 'Failed to update trainer profile',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const initials = profileData.full_name
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || 'T';

  // Group rating systems by country
  const groupedSystems = ratingSystems.reduce((acc, system) => {
    const country = system.country;
    if (!acc[country]) acc[country] = [];
    acc[country].push(system);
    return acc;
  }, {} as Record<string, RatingSystemConfig[]>);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <Pencil className="h-4 w-4 mr-2" />
          {t('trainers.editProfile', 'Edit')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        {loading ? (
          <div className="space-y-4 py-4">
            <Skeleton className="h-20 w-20 rounded-full mx-auto" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{t('editTrainer.title', 'Edit Trainer Profile')}</DialogTitle>
              <DialogDescription>
                {t('editTrainer.description', 'Update the trainer\'s profile information.')}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-6 py-4">
              {/* Avatar */}
              <div className="flex items-center gap-4">
                <div className="relative group">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={profileData.avatar_url || undefined} />
                    <AvatarFallback className="text-lg">{initials}</AvatarFallback>
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
                  <p className="font-medium">{profileData.full_name || trainerName}</p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-primary hover:underline"
                    disabled={uploadingAvatar}
                  >
                    {uploadingAvatar ? 'Uploading...' : 'Change photo'}
                  </button>
                </div>
              </div>

              {/* Basic Info */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-full_name">{t('createTrainer.fullName')}</Label>
                  <Input
                    id="edit-full_name"
                    value={profileData.full_name}
                    onChange={(e) => setProfileData({ ...profileData, full_name: e.target.value })}
                    placeholder="John Doe"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-phone">{t('createTrainer.phone')}</Label>
                  <Input
                    id="edit-phone"
                    type="tel"
                    value={profileData.phone}
                    onChange={(e) => setProfileData({ ...profileData, phone: e.target.value })}
                    placeholder="+31 6 12345678"
                  />
                </div>
              </div>

              {/* Bio */}
              <div className="space-y-2">
                <Label htmlFor="edit-bio">{t('editTrainer.bio', 'Bio')}</Label>
                <Textarea
                  id="edit-bio"
                  value={profileData.bio}
                  onChange={(e) => setProfileData({ ...profileData, bio: e.target.value })}
                  placeholder="Write a short bio about the trainer..."
                  rows={3}
                />
              </div>

              {/* Trainer-specific fields */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-hourly_rate">{t('editTrainer.hourlyRate', 'Hourly Rate (€)')}</Label>
                  <Input
                    id="edit-hourly_rate"
                    type="number"
                    min="0"
                    step="0.01"
                    value={trainerData.hourly_rate ?? ''}
                    onChange={(e) => setTrainerData({ ...trainerData, hourly_rate: e.target.value ? parseFloat(e.target.value) : null })}
                    placeholder="50"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-experience">{t('editTrainer.experience', 'Experience (years)')}</Label>
                  <Input
                    id="edit-experience"
                    type="number"
                    min="0"
                    value={trainerData.experience_years ?? ''}
                    onChange={(e) => setTrainerData({ ...trainerData, experience_years: e.target.value ? parseInt(e.target.value) : null })}
                    placeholder="5"
                  />
                </div>
              </div>

              {/* Rating */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-rating_system">{t('editTrainer.ratingSystem', 'Rating System')}</Label>
                  <Select
                    value={profileData.rating_system || ''}
                    onValueChange={(value) => setProfileData({ ...profileData, rating_system: value })}
                  >
                    <SelectTrigger id="edit-rating_system">
                      <SelectValue placeholder="Select rating system" />
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
                  <Label htmlFor="edit-rating">{t('editTrainer.rating', 'Rating')}</Label>
                  <Input
                    id="edit-rating"
                    type="number"
                    step="0.1"
                    value={profileData.skill_rating ?? ''}
                    onChange={(e) => setProfileData({ ...profileData, skill_rating: e.target.value ? parseFloat(e.target.value) : null })}
                    placeholder="8.0"
                  />
                </div>
              </div>

              {/* Certifications */}
              <div className="space-y-2">
                <Label>{t('editTrainer.certifications', 'Certifications')}</Label>
                <CertificationsPicker
                  selectedCertifications={trainerData.certifications}
                  onChange={(certs) => setTrainerData({ ...trainerData, certifications: certs })}
                  trainerCountry={trainerCountry}
                />
              </div>

              {/* Specializations */}
              <div className="space-y-2">
                <Label>{t('editTrainer.specializations', 'Specializations')}</Label>
                <SpecializationsPicker
                  selectedSpecializations={trainerData.specializations}
                  onChange={(specs) => setTrainerData({ ...trainerData, specializations: specs })}
                />
              </div>

              {/* Preferred Player Levels */}
              <div className="space-y-4 pt-4 border-t">
                <div>
                  <Label>{t('editTrainer.preferredLevels', 'Preferred Player Levels')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('editTrainer.preferredLevelsDescription', 'Which skill levels does this trainer most enjoy training?')}
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
                  >
                    <SelectTrigger id="preferred_rating_system">
                      <SelectValue placeholder="Select rating system" />
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
                          {minVal} - {maxVal} ({preferredSystem.name})
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
                              preferred_min_rating: min,
                              preferred_max_rating: max,
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

              {/* Coaching Method */}
              <div className="space-y-2">
                <Label htmlFor="edit-coaching_method">{t('editTrainer.coachingMethod', 'Coaching Method')}</Label>
                <Textarea
                  id="edit-coaching_method"
                  value={trainerData.coaching_method}
                  onChange={(e) => setTrainerData({ ...trainerData, coaching_method: e.target.value })}
                  placeholder="Describe the coaching approach..."
                  rows={2}
                />
              </div>

              {/* Quote */}
              <div className="space-y-2">
                <Label htmlFor="edit-quote">{t('editTrainer.quote', 'Favourite Quote')}</Label>
                <Input
                  id="edit-quote"
                  value={trainerData.favourite_quote}
                  onChange={(e) => setTrainerData({ ...trainerData, favourite_quote: e.target.value })}
                  placeholder="An inspiring quote..."
                />
              </div>

              {/* Video URL */}
              <div className="space-y-2">
                <Label htmlFor="edit-video">{t('editTrainer.videoUrl', 'Video URL')}</Label>
                <Input
                  id="edit-video"
                  type="url"
                  value={trainerData.video_url}
                  onChange={(e) => setTrainerData({ ...trainerData, video_url: e.target.value })}
                  placeholder="https://youtube.com/..."
                />
              </div>

              {/* Social Links */}
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-instagram">Instagram</Label>
                  <Input
                    id="edit-instagram"
                    value={trainerData.social_instagram}
                    onChange={(e) => setTrainerData({ ...trainerData, social_instagram: e.target.value })}
                    placeholder="@username"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-youtube">YouTube</Label>
                  <Input
                    id="edit-youtube"
                    value={trainerData.social_youtube}
                    onChange={(e) => setTrainerData({ ...trainerData, social_youtube: e.target.value })}
                    placeholder="channel URL"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-linkedin">LinkedIn</Label>
                  <Input
                    id="edit-linkedin"
                    value={trainerData.social_linkedin}
                    onChange={(e) => setTrainerData({ ...trainerData, social_linkedin: e.target.value })}
                    placeholder="profile URL"
                  />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                {t('profile.save', 'Save Changes')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
