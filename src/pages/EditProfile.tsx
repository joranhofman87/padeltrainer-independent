import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ArrowLeft, Save, User, RefreshCw } from 'lucide-react';
import { RATING_SYSTEMS, RatingSystem, getRatingSystemConfig, DEFAULT_RATING_SYSTEM } from '@/lib/ratingSystem';

interface TrainerProfileData {
  hourly_rate: number | null;
  experience_years: number | null;
  certifications: string[];
  specializations: string[];
  knltb_rating: number | null;
}

export default function EditProfile() {
  const { user, profile, role, loading, refreshAuth } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t } = useTranslation('player');
  
  const [saving, setSaving] = useState(false);
  const [syncingRating, setSyncingRating] = useState(false);
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    phone: '',
    location: '',
    bio: '',
    skill_rating: '',
    rating_system: DEFAULT_RATING_SYSTEM as RatingSystem,
    knltb_number: '',
  });
  
  const [trainerData, setTrainerData] = useState<TrainerProfileData>({
    hourly_rate: null,
    experience_years: null,
    certifications: [],
    specializations: [],
    knltb_rating: null,
  });
  
  const [certificationsInput, setCertificationsInput] = useState('');
  const [specializationsInput, setSpecializationsInput] = useState('');

  useEffect(() => {
    if (!loading && !user) {
      navigate('/auth');
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
        rating_system: ((profile as any).rating_system as RatingSystem) || DEFAULT_RATING_SYSTEM,
        knltb_number: profile.knltb_number || '',
      });
    }
  }, [profile]);

  useEffect(() => {
    if (role === 'trainer' && user) {
      fetchTrainerProfile();
    }
  }, [role, user]);

  const fetchTrainerProfile = async () => {
    const { data, error } = await supabase
      .from('trainer_profiles')
      .select('hourly_rate, experience_years, certifications, specializations, knltb_rating')
      .eq('user_id', user!.id)
      .single();
    
    if (data) {
      setTrainerData({
        hourly_rate: data.hourly_rate,
        experience_years: data.experience_years,
        certifications: data.certifications || [],
        specializations: data.specializations || [],
        knltb_rating: data.knltb_rating,
      });
      setCertificationsInput((data.certifications || []).join(', '));
      setSpecializationsInput((data.specializations || []).join(', '));
    }
  };

  const handleSyncRating = async () => {
    if (!profile?.knltb_number || !profile?.id) {
      toast({
        title: t('ratingHistory.syncError'),
        description: 'Please enter your KNLTB number first',
        variant: 'destructive',
      });
      return;
    }

    setSyncingRating(true);
    toast({
      title: t('ratingHistory.syncing'),
      description: 'This may take a moment...',
    });

    try {
      const { data, error } = await supabase.functions.invoke('scrape-knltb-rating', {
        body: {
          knltbNumber: profile.knltb_number,
          profileId: profile.id,
          storeHistory: true,
        },
      });

      if (error) throw error;

      if (data?.success && data?.data?.rating) {
        setFormData(prev => ({
          ...prev,
          skill_rating: data.data.rating.toString(),
          rating_system: 'knltb',
        }));

        toast({
          title: t('ratingHistory.syncSuccess'),
          description: `Your rating: ${data.data.rating}`,
        });

        await refreshAuth();
      } else {
        throw new Error(data?.error || 'Failed to fetch rating');
      }
    } catch (error: any) {
      console.error('Sync error:', error);
      toast({
        title: t('ratingHistory.syncError'),
        description: error.message || 'Could not fetch your rating from KNLTB',
        variant: 'destructive',
      });
    } finally {
      setSyncingRating(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    
    setSaving(true);
    
    try {
      // Update profile
      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          full_name: formData.full_name,
          phone: formData.phone,
          location: formData.location,
          bio: formData.bio,
          skill_rating: formData.skill_rating ? parseFloat(formData.skill_rating) : null,
          rating_system: formData.rating_system,
          knltb_number: formData.knltb_number,
        })
        .eq('user_id', user.id);
      
      if (profileError) throw profileError;

      // Update trainer profile if trainer
      if (role === 'trainer') {
        const certifications = certificationsInput
          .split(',')
          .map(c => c.trim())
          .filter(c => c);
        const specializations = specializationsInput
          .split(',')
          .map(s => s.trim())
          .filter(s => s);
        
        const { error: trainerError } = await supabase
          .from('trainer_profiles')
          .update({
            hourly_rate: trainerData.hourly_rate,
            experience_years: trainerData.experience_years,
            certifications,
            specializations,
            knltb_rating: trainerData.knltb_rating,
          })
          .eq('user_id', user.id);
        
        if (trainerError) throw trainerError;
      }

      await refreshAuth();
      
      toast({
        title: 'Profile updated',
        description: 'Your changes have been saved.',
      });
      
      navigate(role === 'trainer' ? '/trainer' : '/player');
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to update profile',
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/5">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <span className="font-bold text-xl">Edit Profile</span>
          </div>
          <Button onClick={handleSubmit} disabled={saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Avatar Section */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <Avatar className="h-20 w-20">
                  <AvatarImage src={profile?.avatar_url || undefined} />
                  <AvatarFallback className="text-2xl">{initials}</AvatarFallback>
                </Avatar>
                <div>
                  <h3 className="font-semibold">{formData.full_name || 'Your Name'}</h3>
                  <p className="text-sm text-muted-foreground capitalize">{role || 'User'}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <User className="h-5 w-5" />
                Basic Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="full_name">Full Name</Label>
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
                    disabled
                    className="bg-muted"
                  />
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
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Player Details</CardTitle>
                    <CardDescription>Your padel skill information</CardDescription>
                  </div>
                  {formData.rating_system === 'knltb' && formData.knltb_number && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleSyncRating}
                      disabled={syncingRating}
                    >
                      <RefreshCw className={`h-4 w-4 mr-2 ${syncingRating ? 'animate-spin' : ''}`} />
                      {syncingRating ? t('ratingHistory.syncing') : t('ratingHistory.refresh')}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="knltb_number">KNLTB Number</Label>
                  <Input
                    id="knltb_number"
                    value={formData.knltb_number}
                    onChange={(e) => setFormData({ ...formData, knltb_number: e.target.value })}
                    placeholder="12345678"
                  />
                  <p className="text-xs text-muted-foreground">
                    Your official KNLTB registration number
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="rating_system">{t('ratingSystem.label')}</Label>
                  <Select
                    value={formData.rating_system}
                    onValueChange={(value: RatingSystem) => {
                      setFormData({ ...formData, rating_system: value, skill_rating: '' });
                    }}
                  >
                    <SelectTrigger id="rating_system">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(RATING_SYSTEMS).map((system) => (
                        <SelectItem key={system.id} value={system.id}>
                          {t(`ratingSystem.${system.id}`)} ({t('ratingSystem.range', { min: system.min, max: system.max })})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('ratingSystem.description')}
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="skill_rating">Padel Rating</Label>
                  <Input
                    id="skill_rating"
                    type="number"
                    step={getRatingSystemConfig(formData.rating_system).step}
                    min={getRatingSystemConfig(formData.rating_system).min}
                    max={getRatingSystemConfig(formData.rating_system).max}
                    value={formData.skill_rating}
                    onChange={(e) => setFormData({ ...formData, skill_rating: e.target.value })}
                    placeholder={getRatingSystemConfig(formData.rating_system).max.toString()}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('ratingSystem.range', { 
                      min: getRatingSystemConfig(formData.rating_system).min, 
                      max: getRatingSystemConfig(formData.rating_system).max 
                    })}
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Trainer-specific fields */}
          {role === 'trainer' && (
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
                    <Label htmlFor="experience_years">Years of Experience</Label>
                    <Input
                      id="experience_years"
                      type="number"
                      min="0"
                      value={trainerData.experience_years || ''}
                      onChange={(e) => setTrainerData({ 
                        ...trainerData, 
                        experience_years: e.target.value ? parseInt(e.target.value) : null 
                      })}
                      placeholder="5"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="knltb_rating">KNLTB Rating</Label>
                  <Input
                    id="knltb_rating"
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="9.9"
                    value={trainerData.knltb_rating || ''}
                    onChange={(e) => setTrainerData({ 
                      ...trainerData, 
                      knltb_rating: e.target.value ? parseFloat(e.target.value) : null 
                    })}
                    placeholder="7.5"
                  />
                  <p className="text-xs text-muted-foreground">
                    Your official KNLTB rating (0.1 - 9.9)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="certifications">Certifications (comma-separated)</Label>
                  <Input
                    id="certifications"
                    value={certificationsInput}
                    onChange={(e) => setCertificationsInput(e.target.value)}
                    placeholder="KNLTB Level 3, WPT Coach Certificate"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="specializations">Specializations (comma-separated)</Label>
                  <Input
                    id="specializations"
                    value={specializationsInput}
                    onChange={(e) => setSpecializationsInput(e.target.value)}
                    placeholder="Beginners, Advanced Technique, Competition Prep"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </form>
      </main>
    </div>
  );
}