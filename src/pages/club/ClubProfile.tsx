import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Save, Building2, Camera, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { getUserClubProfiles, updateClubProfile, type ClubProfile } from '@/lib/club';
import { supabase } from '@/integrations/supabase/client';
import type { Location } from '@/lib/locations';
import { ClubNavigation } from '@/components/club/ClubNavigation';

interface ClubWithLocation extends ClubProfile {
  role: string;
  location: Location;
}

export default function ClubProfile() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [club, setClub] = useState<ClubWithLocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const [formData, setFormData] = useState({
    description: '',
    contact_email: '',
    phone: '',
  });
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    async function fetchClub() {
      if (!user) return;

      try {
        const userClubs = await getUserClubProfiles(user.id);
        if (userClubs.length > 0) {
          const firstClub = userClubs[0];
          setClub(firstClub);
          setFormData({
            description: firstClub.description || '',
            contact_email: firstClub.contact_email || '',
            phone: firstClub.phone || '',
          });
          setLogoUrl(firstClub.logo_url);
        }
      } catch (error) {
        console.error('Error fetching club:', error);
        toast({
          title: t('common:error'),
          description: 'Failed to load club profile',
          variant: 'destructive',
        });
      } finally {
        setLoading(false);
      }
    }

    fetchClub();
  }, [user, t, toast]);

  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !club) return;

    if (!file.type.startsWith('image/')) {
      toast({
        title: t('common:error'),
        description: 'Please select an image file',
        variant: 'destructive',
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: t('common:error'),
        description: 'Please select an image smaller than 5MB',
        variant: 'destructive',
      });
      return;
    }

    setUploadingLogo(true);

    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `clubs/${club.id}/logo.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);

      const urlWithTimestamp = `${publicUrl}?t=${Date.now()}`;

      await updateClubProfile(club.id, { logo_url: urlWithTimestamp });
      setLogoUrl(urlWithTimestamp);

      toast({
        title: t('common:success'),
        description: t('profile.logoUpdated'),
      });
    } catch (error: any) {
      console.error('Logo upload error:', error);
      toast({
        title: t('common:error'),
        description: error.message || 'Failed to upload logo',
        variant: 'destructive',
      });
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!club) return;

    setSaving(true);

    try {
      await updateClubProfile(club.id, formData);

      toast({
        title: t('common:success'),
        description: t('profile.profileUpdated'),
      });

      navigate('/club');
    } catch (error: any) {
      toast({
        title: t('common:error'),
        description: error.message || 'Failed to update profile',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
          <div className="container mx-auto px-4 py-4 flex items-center gap-4">
            <Skeleton className="h-10 w-10" />
            <Skeleton className="h-6 w-48" />
          </div>
        </header>
        <main className="container mx-auto px-4 py-8 max-w-2xl">
          <Skeleton className="h-64 w-full" />
        </main>
      </div>
    );
  }

  if (!club) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Building2 className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
          <h1 className="text-2xl font-bold mb-2">{t('profile.noClub')}</h1>
          <p className="text-muted-foreground mb-6">{t('profile.noClubDescription')}</p>
          <Button onClick={() => navigate('/locations')}>
            {t('profile.browseLocations')}
          </Button>
        </div>
      </div>
    );
  }

  const initials = club.location.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <span className="font-bold text-xl">{t('profile.title')}</span>
          <Button onClick={handleSubmit} disabled={saving}>
            <Save className="h-4 w-4 mr-2" />
            {saving ? t('common:saving') : t('common:save')}
          </Button>
        </div>
        <ClubNavigation />
      </header>

      <main className="container mx-auto px-4 py-8 max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Logo Section */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="relative group">
                  <Avatar className="h-20 w-20">
                    <AvatarImage src={logoUrl || undefined} />
                    <AvatarFallback className="text-2xl bg-primary/10 text-primary">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingLogo}
                    className="absolute inset-0 flex items-center justify-center bg-black/50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    {uploadingLogo ? (
                      <Loader2 className="h-6 w-6 text-white animate-spin" />
                    ) : (
                      <Camera className="h-6 w-6 text-white" />
                    )}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                </div>
                <div>
                  <h3 className="font-semibold">{club.location.name}</h3>
                  <p className="text-sm text-muted-foreground">{club.location.city}</p>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs text-primary hover:underline mt-1"
                    disabled={uploadingLogo}
                  >
                    {uploadingLogo ? t('profile.uploading') : t('profile.changeLogo')}
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Club Details */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5" />
                {t('profile.clubDetails')}
              </CardTitle>
              <CardDescription>{t('profile.clubDetailsDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="description">{t('profile.description')}</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder={t('profile.descriptionPlaceholder')}
                  rows={4}
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="contact_email">{t('profile.contactEmail')}</Label>
                  <Input
                    id="contact_email"
                    type="email"
                    value={formData.contact_email}
                    onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
                    placeholder={t('profile.contactEmailPlaceholder')}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">{t('profile.phone')}</Label>
                  <Input
                    id="phone"
                    value={formData.phone}
                    onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                    placeholder={t('profile.phonePlaceholder')}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Location Info (Read-only) */}
          <Card>
            <CardHeader>
              <CardTitle>{t('profile.locationInfo')}</CardTitle>
              <CardDescription>{t('profile.locationInfoDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">{t('profile.clubName')}</span>
                <span className="font-medium">{club.location.name}</span>
              </div>
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">{t('profile.city')}</span>
                <span className="font-medium">{club.location.city}</span>
              </div>
              {club.location.street_address && (
                <div className="flex justify-between py-2 border-b">
                  <span className="text-muted-foreground">{t('profile.address')}</span>
                  <span className="font-medium">{club.location.street_address}</span>
                </div>
              )}
              {club.location.website_url && (
                <div className="flex justify-between py-2">
                  <span className="text-muted-foreground">{t('profile.website')}</span>
                  <a
                    href={club.location.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  >
                    {club.location.website_url}
                  </a>
                </div>
              )}
            </CardContent>
          </Card>
        </form>
      </main>
    </div>
  );
}
