import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Save, Building2, Camera, Loader2, ImageIcon, Lock, LayoutGrid, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useClubContext } from '@/components/club/ClubLayout';
import { updateClubProfile } from '@/lib/club';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

export default function ClubProfile() {
  const { t } = useTranslation('club');
  const navigate = useNavigate();
  const { toast } = useToast();
  const { activeClub, refreshClubs } = useClubContext();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingBanner, setUploadingBanner] = useState(false);

  const [formData, setFormData] = useState({
    description: '',
    contact_email: '',
    phone: '',
    social_instagram: '',
    social_facebook: '',
    social_tiktok: '',
    social_youtube: '',
    social_linkedin: '',
  });
  const [courtData, setCourtData] = useState({
    indoor_courts: 0,
    outdoor_courts: 0,
    website_url: '',
  });
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);

  // Check if club has a paid plan (not starter)
  const isPaidPlan = (activeClub as any)?.subscription_status === 'active' && 
                     (activeClub as any)?.subscription_tier !== 'starter';

  useEffect(() => {
    if (activeClub) {
      const clubData = activeClub as any;
      setFormData({
        description: activeClub.description || '',
        contact_email: activeClub.contact_email || '',
        phone: activeClub.phone || '',
        social_instagram: clubData.social_instagram || '',
        social_facebook: clubData.social_facebook || '',
        social_tiktok: clubData.social_tiktok || '',
        social_youtube: clubData.social_youtube || '',
        social_linkedin: clubData.social_linkedin || '',
      });
      setLogoUrl(activeClub.logo_url);
      setBannerUrl((activeClub as any).banner_url);
      
      // Set court data from location
      setCourtData({
        indoor_courts: activeClub.location.indoor_courts || 0,
        outdoor_courts: activeClub.location.outdoor_courts || 0,
        website_url: (activeClub.location as any).website_url || '',
      });
    }
  }, [activeClub]);

  const validateImageDimensions = (
    file: File,
    type: 'logo' | 'banner'
  ): Promise<{ valid: boolean; message?: string }> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        
        if (type === 'banner') {
          const aspectRatio = img.width / img.height;
          const minWidth = 800;
          const maxWidth = 2400;
          const minAspectRatio = 2.5; // At least 2.5:1 (wide)
          const maxAspectRatio = 5; // At most 5:1 (not too wide)
          
          if (img.width < minWidth) {
            resolve({ valid: false, message: t('profile.bannerTooSmall', { minWidth }) });
            return;
          }
          if (img.width > maxWidth) {
            resolve({ valid: false, message: t('profile.bannerTooLarge', { maxWidth }) });
            return;
          }
          if (aspectRatio < minAspectRatio || aspectRatio > maxAspectRatio) {
            resolve({ valid: false, message: t('profile.bannerWrongRatio') });
            return;
          }
        } else if (type === 'logo') {
          const minSize = 100;
          const maxSize = 1000;
          
          if (img.width < minSize || img.height < minSize) {
            resolve({ valid: false, message: t('profile.logoTooSmall', { minSize }) });
            return;
          }
          if (img.width > maxSize || img.height > maxSize) {
            resolve({ valid: false, message: t('profile.logoTooLarge', { maxSize }) });
            return;
          }
        }
        
        resolve({ valid: true });
      };
      img.onerror = () => {
        resolve({ valid: false, message: t('profile.invalidImage') });
      };
      img.src = URL.createObjectURL(file);
    });
  };

  const handleImageUpload = async (
    file: File,
    type: 'logo' | 'banner',
    setUploading: (v: boolean) => void,
    setUrl: (url: string) => void
  ) => {
    if (!activeClub) return;

    if (!file.type.startsWith('image/')) {
      toast({
        title: t('common:error'),
        description: t('profile.selectImageFile'),
        variant: 'destructive',
      });
      return;
    }

    const maxSize = type === 'banner' ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
    if (file.size > maxSize) {
      toast({
        title: t('common:error'),
        description: t('profile.imageTooLarge', { maxSize: type === 'banner' ? '10MB' : '5MB' }),
        variant: 'destructive',
      });
      return;
    }

    // Validate dimensions
    const validation = await validateImageDimensions(file, type);
    if (!validation.valid) {
      toast({
        title: t('common:error'),
        description: validation.message,
        variant: 'destructive',
      });
      return;
    }

    setUploading(true);

    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `clubs/${activeClub.id}/${type}.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(filePath);

      const urlWithTimestamp = `${publicUrl}?t=${Date.now()}`;

      const updateField = type === 'logo' ? { logo_url: urlWithTimestamp } : { banner_url: urlWithTimestamp };
      await updateClubProfile(activeClub.id, updateField);
      setUrl(urlWithTimestamp);

      toast({
        title: t('common:success'),
        description: t(`profile.${type}Updated`),
      });
    } catch (error: any) {
      logger.error(`${type} upload error`, error instanceof Error ? error : new Error(String(error)), { component: 'ClubProfile' });
      toast({
        title: t('common:error'),
        description: error.message || `Failed to upload ${type}`,
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleImageUpload(file, 'logo', setUploadingLogo, setLogoUrl);
    }
  };

  const handleBannerUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleImageUpload(file, 'banner', setUploadingBanner, setBannerUrl);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeClub) return;

    setSaving(true);

    try {
      // Update club profile
      await updateClubProfile(activeClub.id, formData);

      // Update location court counts
      const { error: locationError } = await supabase
        .from('locations')
        .update({
          indoor_courts: courtData.indoor_courts,
          outdoor_courts: courtData.outdoor_courts,
          website_url: courtData.website_url || null,
        })
        .eq('id', activeClub.location_id);

      if (locationError) {
        logger.error('Error updating courts', new Error(locationError.message), { component: 'ClubProfile' });
      }

      toast({
        title: t('common:success'),
        description: t('profile.profileUpdated'),
      });

      refreshClubs();
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

  if (!activeClub) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const initials = activeClub.location.name
    .split(' ')
    .map((n: string) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <main className="container mx-auto px-4 py-8 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">{t('profile.title')}</h1>
        <Button onClick={handleSubmit} disabled={saving}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? t('common:saving') : t('common:save')}
        </Button>
      </div>

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
                  onClick={() => logoInputRef.current?.click()}
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
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleLogoUpload}
                  className="hidden"
                />
              </div>
              <div>
                <h3 className="font-semibold">{activeClub.location.name}</h3>
                <p className="text-sm text-muted-foreground">{activeClub.location.city}</p>
                <button
                  type="button"
                  onClick={() => logoInputRef.current?.click()}
                  className="text-xs text-primary hover:underline mt-1"
                  disabled={uploadingLogo}
                >
                  {uploadingLogo ? t('profile.uploading') : t('profile.changeLogo')}
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Banner Section */}
        <Card className={!isPaidPlan ? 'border-dashed' : ''}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ImageIcon className="h-5 w-5" />
              {t('profile.banner')}
              {!isPaidPlan && <Lock className="h-4 w-4 text-muted-foreground" />}
            </CardTitle>
            <CardDescription>
              {t('profile.bannerDescription')}
              <span className="block text-xs mt-1">{t('profile.bannerSizeHint')}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isPaidPlan ? (
              <div className="space-y-4">
                {bannerUrl && (
                  <div className="relative w-full h-32 rounded-lg overflow-hidden">
                    <img
                      src={bannerUrl}
                      alt="Club banner"
                      className="w-full h-full object-cover"
                    />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => bannerInputRef.current?.click()}
                    disabled={uploadingBanner}
                  >
                    {uploadingBanner ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <ImageIcon className="h-4 w-4 mr-2" />
                    )}
                    {bannerUrl ? t('profile.changeBanner') : t('profile.uploadBanner')}
                  </Button>
                </div>
                <input
                  ref={bannerInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleBannerUpload}
                  className="hidden"
                />
              </div>
            ) : (
              <div className="bg-muted/50 rounded-lg p-4 text-center">
                <Lock className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                <p className="font-medium text-sm">{t('profile.bannerPremium')}</p>
                <p className="text-xs text-muted-foreground mb-3">
                  {t('profile.bannerPremiumDescription')}
                </p>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => navigate('/club/subscription')}
                >
                  {t('profile.upgradeNow')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Court Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LayoutGrid className="h-5 w-5" />
              {t('profile.courtInfo')}
            </CardTitle>
            <CardDescription>{t('profile.courtInfoDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="indoor_courts">{t('profile.indoorCourts')}</Label>
                <Input
                  id="indoor_courts"
                  type="number"
                  min="0"
                  value={courtData.indoor_courts}
                  onChange={(e) => setCourtData({ ...courtData, indoor_courts: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="outdoor_courts">{t('profile.outdoorCourts')}</Label>
                <Input
                  id="outdoor_courts"
                  type="number"
                  min="0"
                  value={courtData.outdoor_courts}
                  onChange={(e) => setCourtData({ ...courtData, outdoor_courts: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="website_url">{t('profile.websiteUrl', 'Website URL')}</Label>
              <Input
                id="website_url"
                type="url"
                value={courtData.website_url}
                onChange={(e) => setCourtData({ ...courtData, website_url: e.target.value })}
                placeholder="https://www.example.com"
              />
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
              <Label htmlFor="description">{t('profile.aboutClub')}</Label>
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

        {/* Social Media */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Share2 className="h-5 w-5" />
              {t('profile.socialMedia')}
            </CardTitle>
            <CardDescription>{t('profile.socialMediaDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="social_instagram">{t('profile.instagram')}</Label>
                <Input
                  id="social_instagram"
                  value={formData.social_instagram}
                  onChange={(e) => setFormData({ ...formData, social_instagram: e.target.value })}
                  placeholder={t('profile.instagramPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="social_facebook">{t('profile.facebook')}</Label>
                <Input
                  id="social_facebook"
                  value={formData.social_facebook}
                  onChange={(e) => setFormData({ ...formData, social_facebook: e.target.value })}
                  placeholder={t('profile.facebookPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="social_tiktok">{t('profile.tiktok')}</Label>
                <Input
                  id="social_tiktok"
                  value={formData.social_tiktok}
                  onChange={(e) => setFormData({ ...formData, social_tiktok: e.target.value })}
                  placeholder={t('profile.tiktokPlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="social_youtube">{t('profile.youtube')}</Label>
                <Input
                  id="social_youtube"
                  value={formData.social_youtube}
                  onChange={(e) => setFormData({ ...formData, social_youtube: e.target.value })}
                  placeholder={t('profile.youtubePlaceholder')}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="social_linkedin">{t('profile.linkedin')}</Label>
                <Input
                  id="social_linkedin"
                  value={formData.social_linkedin}
                  onChange={(e) => setFormData({ ...formData, social_linkedin: e.target.value })}
                  placeholder={t('profile.linkedinPlaceholder')}
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
              <span className="font-medium">{activeClub.location.name}</span>
            </div>
            <div className="flex justify-between py-2 border-b">
              <span className="text-muted-foreground">{t('profile.city')}</span>
              <span className="font-medium">{activeClub.location.city}</span>
            </div>
            {activeClub.location.street_address && (
              <div className="flex justify-between py-2 border-b">
                <span className="text-muted-foreground">{t('profile.address')}</span>
                <span className="font-medium">{activeClub.location.street_address}</span>
              </div>
            )}
            {activeClub.location.website_url && (
              <div className="flex justify-between py-2">
                <span className="text-muted-foreground">{t('profile.website')}</span>
                <a
                  href={activeClub.location.website_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {activeClub.location.website_url}
                </a>
              </div>
            )}
          </CardContent>
        </Card>
      </form>
    </main>
  );
}
