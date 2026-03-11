import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Loader2, Camera, Save, Trash2 } from 'lucide-react';
import { logger } from '@/lib/logger';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { CertificationsPicker } from '@/components/trainer/CertificationsPicker';
import { SpecializationsPicker } from '@/components/trainer/SpecializationsPicker';
import { getRatingSystems, RatingSystemConfig, COUNTRY_NAMES } from '@/lib/ratingSystems';
import { getTrainerCountry } from '@/lib/certifications';

interface EditAcademyTrainerDialogProps {
  trainerId: string; // trainer_profiles.id
  userId: string; // auth user id
  trainerName: string;
  academyTrainerId: string; // academy_trainers.id for removal
  academyLocations: any[]; // academy_locations with location details
  onTrainerUpdated: () => void;
  onRemoveTrainer: () => void;
}

interface TrainerProfileData {
  hourly_rate: number | null;
  coaching_since_year: number | null;
  certifications: string[];
  specializations: string[];
  coaching_method: string;
  favourite_quote: string;
  video_url: string;
  social_instagram: string;
  social_youtube: string;
  social_linkedin: string;
}

interface ProfileData {
  full_name: string;
  phone: string;
  email: string;
  bio: string;
  avatar_url: string | null;
  skill_rating: number | null;
  rating_system: string | null;
  rating_member_id: string | null;
}

export function EditAcademyTrainerDialog({
  trainerId,
  userId,
  trainerName,
  academyTrainerId,
  academyLocations,
  onTrainerUpdated,
  onRemoveTrainer,
}: EditAcademyTrainerDialogProps) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [profileData, setProfileData] = useState<ProfileData>({
    full_name: '',
    phone: '',
    email: '',
    bio: '',
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
    social_instagram: '',
    social_youtube: '',
    social_linkedin: '',
  });

  // Track which academy locations are assigned to this trainer
  const [assignedLocationIds, setAssignedLocationIds] = useState<Set<string>>(new Set());

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

      // Fetch profile data
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, phone, email, bio, avatar_url, skill_rating, rating_system, rating_member_id')
        .eq('user_id', userId)
        .single();

      if (profile) {
        setProfileData({
          full_name: profile.full_name || trainerName || '',
          phone: profile.phone || '',
          email: profile.email || '',
          bio: profile.bio || '',
          avatar_url: profile.avatar_url,
          skill_rating: profile.skill_rating,
          rating_system: profile.rating_system,
          rating_member_id: profile.rating_member_id,
        });
      } else {
        // Profile not accessible via RLS — use the prop name as fallback
        setProfileData(prev => ({ ...prev, full_name: trainerName || '' }));
      }

      // Fetch trainer profile data
      const { data: trainer } = await supabase
        .from('trainer_profiles')
        .select('hourly_rate, coaching_since_year, certifications, specializations, coaching_method, favourite_quote, video_url, social_instagram, social_youtube, social_linkedin')
        .eq('id', trainerId)
        .single();

      if (trainer) {
        setTrainerData({
          hourly_rate: trainer.hourly_rate,
          coaching_since_year: (trainer as any).coaching_since_year,
          certifications: trainer.certifications || [],
          specializations: trainer.specializations || [],
          coaching_method: trainer.coaching_method || '',
          favourite_quote: trainer.favourite_quote || '',
          video_url: trainer.video_url || '',
          social_instagram: trainer.social_instagram || '',
          social_youtube: trainer.social_youtube || '',
          social_linkedin: trainer.social_linkedin || '',
        });
      }

      // Fetch trainer's current locations to find which academy locations are assigned
      const { data: trainerLocs } = await supabase
        .from('trainer_locations')
        .select('location_id')
        .eq('trainer_id', trainerId);

      if (trainerLocs) {
        setAssignedLocationIds(new Set(trainerLocs.map((tl) => tl.location_id)));
      }
    } catch (error) {
      logger.error('Error fetching trainer data', error instanceof Error ? error : new Error(String(error)), { component: 'EditAcademyTrainerDialog' });
    } finally {
      setLoading(false);
    }
  };

  const handleAvatarUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast({
        title: t('common.error'),
        description: 'Please select an image file',
        variant: 'destructive',
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t('common.error'),
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
        description: "The trainer's profile picture has been updated.",
      });
    } catch (error: any) {
      logger.error('Avatar upload error', error instanceof Error ? error : new Error(String(error)), { component: 'EditAcademyTrainerDialog' });
      toast({
        title: t('common.error'),
        description: error.message || 'Failed to upload avatar',
        variant: 'destructive',
      });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleLocationToggle = (locationId: string, checked: boolean) => {
    setAssignedLocationIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(locationId);
      } else {
        next.delete(locationId);
      }
      return next;
    });
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
          rating_system: profileData.rating_system || 'none',
          rating_member_id: profileData.rating_member_id,
        },
      });

      if (updateError) throw updateError;
      if (updateResult?.error) throw new Error(updateResult.error);

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
          social_instagram: trainerData.social_instagram || null,
          social_youtube: trainerData.social_youtube || null,
          social_linkedin: trainerData.social_linkedin || null,
        })
        .eq('id', trainerId);

      if (trainerError) throw trainerError;

      // Sync trainer_locations for academy locations
      const academyLocationIds = academyLocations.map((al) => al.location?.id).filter(Boolean);

      // Get current trainer locations for these academy locations only
      const { data: currentLocs } = await supabase
        .from('trainer_locations')
        .select('id, location_id')
        .eq('trainer_id', trainerId)
        .in('location_id', academyLocationIds.length > 0 ? academyLocationIds : ['__none__']);

      const currentLocIds = new Set((currentLocs || []).map((l) => l.location_id));

      // Add new assignments
      const toAdd = academyLocationIds.filter(
        (id: string) => assignedLocationIds.has(id) && !currentLocIds.has(id)
      );
      if (toAdd.length > 0) {
        await supabase.from('trainer_locations').insert(
          toAdd.map((locationId: string) => ({
            trainer_id: trainerId,
            location_id: locationId,
            relationship_type: 'academy_trainer',
            show_on_club_page: true,
          }))
        );
      }

      // Remove unassigned
      const toRemove = (currentLocs || []).filter(
        (l) => !assignedLocationIds.has(l.location_id)
      );
      if (toRemove.length > 0) {
        await supabase
          .from('trainer_locations')
          .delete()
          .in('id', toRemove.map((l) => l.id));
      }

      toast({
        title: t('trainers.updated'),
        description: t('trainers.updatedDescription'),
      });

      onTrainerUpdated();
      setOpen(false);
    } catch (error: any) {
      logger.error('Error updating trainer', error instanceof Error ? error : new Error(String(error)), { component: 'EditAcademyTrainerDialog' });
      toast({
        title: t('common.error'),
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
        <Button variant="ghost" size="icon">
          <Pencil className="h-4 w-4" />
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
              <DialogTitle>{t('trainers.editTrainer')}</DialogTitle>
              <DialogDescription>
                Update the trainer's profile information.
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
                  <Label htmlFor="edit-full_name">Full Name</Label>
                  <Input
                    id="edit-full_name"
                    value={profileData.full_name}
                    onChange={(e) => setProfileData({ ...profileData, full_name: e.target.value })}
                    placeholder="John Doe"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-phone">Phone</Label>
                  <Input
                    id="edit-phone"
                    type="tel"
                    value={profileData.phone}
                    onChange={(e) => setProfileData({ ...profileData, phone: e.target.value })}
                    placeholder="+31 6 12345678"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="edit-email">Email</Label>
                  <Input
                    id="edit-email"
                    type="email"
                    value={profileData.email}
                    disabled
                    className="bg-muted"
                  />
                </div>
              </div>

              {/* Bio */}
              <div className="space-y-2">
                <Label htmlFor="edit-bio">Bio</Label>
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
                  <Label htmlFor="edit-hourly_rate">Hourly Rate (€)</Label>
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
                  <Label htmlFor="edit-experience">Coaching Since (year)</Label>
                  <Input
                    id="edit-experience"
                    type="number"
                    min="1970"
                    max={new Date().getFullYear()}
                    value={trainerData.coaching_since_year ?? ''}
                    onChange={(e) => setTrainerData({ ...trainerData, coaching_since_year: e.target.value ? parseInt(e.target.value) : null })}
                    placeholder={`e.g. ${new Date().getFullYear() - 5}`}
                  />
                </div>
              </div>

              {/* Rating */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-rating_system">Rating System</Label>
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
                  <Label htmlFor="edit-rating">Rating</Label>
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
                <Label>Certifications</Label>
                <CertificationsPicker
                  selectedCertifications={trainerData.certifications}
                  onChange={(certs) => setTrainerData({ ...trainerData, certifications: certs })}
                  trainerCountry={trainerCountry}
                />
              </div>

              {/* Specializations */}
              <div className="space-y-2">
                <Label>Specializations</Label>
                <SpecializationsPicker
                  selectedSpecializations={trainerData.specializations}
                  onChange={(specs) => setTrainerData({ ...trainerData, specializations: specs })}
                />
              </div>

              {/* Academy Locations Assignment */}
              {academyLocations.length > 0 && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <Label className="text-base font-semibold">{t('trainers.assignLocations', 'Assign Locations')}</Label>
                    <p className="text-sm text-muted-foreground">
                      {t('trainers.assignLocationsDescription', 'Select which locations this trainer is active at.')}
                    </p>
                    <div className="space-y-2">
                      {academyLocations.map((al) => {
                        const location = al.location;
                        if (!location) return null;
                        return (
                          <div key={al.id} className="flex items-center gap-3 py-1.5">
                            <Checkbox
                              id={`loc-${location.id}`}
                              checked={assignedLocationIds.has(location.id)}
                              onCheckedChange={(checked) =>
                                handleLocationToggle(location.id, checked === true)
                              }
                            />
                            <label
                              htmlFor={`loc-${location.id}`}
                              className="text-sm font-medium cursor-pointer"
                            >
                              {location.name}
                              {location.city && (
                                <span className="text-muted-foreground font-normal ml-1">
                                  — {location.city}
                                </span>
                              )}
                            </label>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              {/* Additional fields */}
              <Separator />

              <div className="space-y-2">
                <Label htmlFor="edit-coaching_method">Coaching Method</Label>
                <Textarea
                  id="edit-coaching_method"
                  value={trainerData.coaching_method}
                  onChange={(e) => setTrainerData({ ...trainerData, coaching_method: e.target.value })}
                  placeholder="Describe coaching methodology..."
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-favourite_quote">Favourite Quote</Label>
                <Input
                  id="edit-favourite_quote"
                  value={trainerData.favourite_quote}
                  onChange={(e) => setTrainerData({ ...trainerData, favourite_quote: e.target.value })}
                  placeholder="A motivational quote..."
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-video_url">Video URL</Label>
                <Input
                  id="edit-video_url"
                  value={trainerData.video_url}
                  onChange={(e) => setTrainerData({ ...trainerData, video_url: e.target.value })}
                  placeholder="https://youtube.com/..."
                />
              </div>

              {/* Social Links */}
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-social_instagram">Instagram</Label>
                  <Input
                    id="edit-social_instagram"
                    value={trainerData.social_instagram}
                    onChange={(e) => setTrainerData({ ...trainerData, social_instagram: e.target.value })}
                    placeholder="@username"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-social_youtube">YouTube</Label>
                  <Input
                    id="edit-social_youtube"
                    value={trainerData.social_youtube}
                    onChange={(e) => setTrainerData({ ...trainerData, social_youtube: e.target.value })}
                    placeholder="Channel URL"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-social_linkedin">LinkedIn</Label>
                  <Input
                    id="edit-social_linkedin"
                    value={trainerData.social_linkedin}
                    onChange={(e) => setTrainerData({ ...trainerData, social_linkedin: e.target.value })}
                    placeholder="Profile URL"
                  />
                </div>
              </div>

              {/* Remove Trainer */}
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-destructive">{t('trainers.removeTitle', 'Remove Trainer')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('trainers.removeDescription', 'This will remove the trainer from your academy.')}
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" type="button">
                      <Trash2 className="h-4 w-4 mr-2" />
                      {t('trainers.remove', 'Remove')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('trainers.removeTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('trainers.removeDescription')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          onRemoveTrainer();
                          setOpen(false);
                        }}
                      >
                        {t('trainers.remove')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                <Save className="h-4 w-4 mr-2" />
                {t('common.save')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
