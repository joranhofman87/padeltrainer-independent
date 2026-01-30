import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GraduationCap, Globe, Instagram, Facebook, Youtube, Linkedin, Upload, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { AspectRatio } from '@/components/ui/aspect-ratio';
import { useToast } from '@/hooks/use-toast';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { updateAcademyProfile } from '@/lib/academy';
import { supabase } from '@/integrations/supabase/client';

export default function AcademyProfile() {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const { activeAcademy, refreshAcademies } = useAcademyContext();
  const [isLoading, setIsLoading] = useState(false);
  const [bannerUploading, setBannerUploading] = useState(false);
  const bannerInputRef = useRef<HTMLInputElement>(null);
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    contact_email: '',
    phone: '',
    website_url: '',
    is_public: false,
    social_instagram: '',
    social_facebook: '',
    social_youtube: '',
    social_linkedin: '',
    social_tiktok: '',
  });

  useEffect(() => {
    if (activeAcademy) {
      setFormData({
        name: activeAcademy.name || '',
        description: activeAcademy.description || '',
        contact_email: activeAcademy.contact_email || '',
        phone: activeAcademy.phone || '',
        website_url: activeAcademy.website_url || '',
        is_public: activeAcademy.is_public || false,
        social_instagram: activeAcademy.social_instagram || '',
        social_facebook: activeAcademy.social_facebook || '',
        social_youtube: activeAcademy.social_youtube || '',
        social_linkedin: activeAcademy.social_linkedin || '',
        social_tiktok: activeAcademy.social_tiktok || '',
      });
    }
  }, [activeAcademy]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeAcademy) return;

    setIsLoading(true);

    try {
      const result = await updateAcademyProfile(activeAcademy.id, formData);
      
      if (result) {
        await refreshAcademies();
        toast({
          title: t('profile.saved'),
          description: t('profile.savedDescription', 'Your profile has been updated.'),
        });
      } else {
        throw new Error('Failed to update profile');
      }
    } catch (error: any) {
      toast({
        title: t('common:error'),
        description: error.message,
        variant: 'destructive',
      });
    }

    setIsLoading(false);
  };

  const handleBannerUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !activeAcademy) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({
        title: t('common.error'),
        description: t('profile.bannerInvalidType'),
        variant: 'destructive',
      });
      return;
    }

    // Validate file size (10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: t('common.error'),
        description: t('profile.bannerTooLarge'),
        variant: 'destructive',
      });
      return;
    }

    // Validate dimensions
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    
    img.onload = async () => {
      URL.revokeObjectURL(objectUrl);
      
      const width = img.width;
      const height = img.height;
      const aspectRatio = width / height;

      if (width < 800 || width > 2400) {
        toast({
          title: t('common.error'),
          description: t('profile.bannerInvalidWidth'),
          variant: 'destructive',
        });
        return;
      }

      if (aspectRatio < 2.5 || aspectRatio > 5) {
        toast({
          title: t('common.error'),
          description: t('profile.bannerInvalidRatio'),
          variant: 'destructive',
        });
        return;
      }

      // Upload the file
      setBannerUploading(true);
      try {
        const fileExt = file.name.split('.').pop();
        const filePath = `academies/${activeAcademy.id}/banner.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from('avatars')
          .upload(filePath, file, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage
          .from('avatars')
          .getPublicUrl(filePath);

        // Update the academy profile with the new banner URL
        const result = await updateAcademyProfile(activeAcademy.id, {
          banner_url: publicUrlData.publicUrl + '?t=' + Date.now(),
        });

        if (result) {
          await refreshAcademies();
          toast({
            title: t('profile.bannerUpdated'),
            description: t('profile.bannerUpdatedDescription'),
          });
        }
      } catch (error: any) {
        toast({
          title: t('common.error'),
          description: error.message,
          variant: 'destructive',
        });
      } finally {
        setBannerUploading(false);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      toast({
        title: t('common.error'),
        description: t('profile.bannerInvalidType'),
        variant: 'destructive',
      });
    };

    img.src = objectUrl;
  };

  if (!activeAcademy) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Banner Upload */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ImageIcon className="h-5 w-5" />
              {t('profile.banner')}
            </CardTitle>
            <CardDescription>
              {t('profile.bannerDescription')}
              <br />
              <span className="text-xs">{t('profile.bannerSizeHint')}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeAcademy.banner_url ? (
              <AspectRatio ratio={3 / 1} className="bg-muted rounded-lg overflow-hidden">
                <img
                  src={activeAcademy.banner_url}
                  alt="Academy banner"
                  className="object-cover w-full h-full"
                />
              </AspectRatio>
            ) : (
              <AspectRatio ratio={3 / 1} className="bg-muted rounded-lg flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <ImageIcon className="h-12 w-12 mx-auto mb-2" />
                  <p className="text-sm">{t('profile.noBanner')}</p>
                </div>
              </AspectRatio>
            )}
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
              onClick={() => bannerInputRef.current?.click()}
              disabled={bannerUploading}
            >
              <Upload className="h-4 w-4 mr-2" />
              {bannerUploading
                ? t('common.saving')
                : activeAcademy.banner_url
                ? t('profile.changeBanner')
                : t('profile.uploadBanner')}
            </Button>
          </CardContent>
        </Card>

        {/* Basic Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GraduationCap className="h-5 w-5" />
              {t('profile.title')}
            </CardTitle>
            <CardDescription>{t('profile.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('profile.academyName')}</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder={t('profile.namePlaceholder', 'Your Academy Name')}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">{t('profile.about')}</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder={t('profile.descriptionPlaceholder', 'Tell visitors about your academy...')}
                rows={4}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="contact_email">{t('profile.contactEmail')}</Label>
                <Input
                  id="contact_email"
                  type="email"
                  value={formData.contact_email}
                  onChange={(e) => setFormData({ ...formData, contact_email: e.target.value })}
                  placeholder="info@academy.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="phone">{t('profile.phone')}</Label>
                <Input
                  id="phone"
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="+31 6 12345678"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="website_url">{t('profile.website')}</Label>
              <div className="relative">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="website_url"
                  type="url"
                  value={formData.website_url}
                  onChange={(e) => setFormData({ ...formData, website_url: e.target.value })}
                  placeholder="https://youracademy.com"
                  className="pl-10"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-4 border-t">
              <div>
                <Label htmlFor="is_public">{t('profile.publicProfile')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('profile.publicProfileDescription', 'Make your academy discoverable in the directory')}
                </p>
              </div>
              <Switch
                id="is_public"
                checked={formData.is_public}
                onCheckedChange={(checked) => setFormData({ ...formData, is_public: checked })}
                disabled={!activeAcademy.is_verified}
              />
            </div>
            {!activeAcademy.is_verified && (
              <p className="text-sm text-muted-foreground">
                {t('profile.verificationRequired', 'Your academy must be verified before it can be made public.')}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Social Media */}
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.socialMedia')}</CardTitle>
            <CardDescription>{t('profile.socialMediaDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="instagram" className="flex items-center gap-2">
                <Instagram className="h-4 w-4" /> Instagram
              </Label>
              <Input
                id="instagram"
                value={formData.social_instagram}
                onChange={(e) => setFormData({ ...formData, social_instagram: e.target.value })}
                placeholder="yourusername or full URL"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="facebook" className="flex items-center gap-2">
                <Facebook className="h-4 w-4" /> Facebook
              </Label>
              <Input
                id="facebook"
                value={formData.social_facebook}
                onChange={(e) => setFormData({ ...formData, social_facebook: e.target.value })}
                placeholder="yourusername or full URL"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="youtube" className="flex items-center gap-2">
                <Youtube className="h-4 w-4" /> YouTube
              </Label>
              <Input
                id="youtube"
                value={formData.social_youtube}
                onChange={(e) => setFormData({ ...formData, social_youtube: e.target.value })}
                placeholder="@yourchannel or full URL"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="linkedin" className="flex items-center gap-2">
                <Linkedin className="h-4 w-4" /> LinkedIn
              </Label>
              <Input
                id="linkedin"
                value={formData.social_linkedin}
                onChange={(e) => setFormData({ ...formData, social_linkedin: e.target.value })}
                placeholder="company/yourcompany or full URL"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={isLoading}>
            {isLoading ? t('common:saving') : t('common:save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
