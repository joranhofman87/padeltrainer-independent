import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { GraduationCap, Globe, Instagram, Facebook, Youtube, Linkedin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { updateAcademyProfile } from '@/lib/academy';

export default function AcademyProfile() {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const { activeAcademy, refreshAcademies } = useAcademyContext();
  const [isLoading, setIsLoading] = useState(false);
  
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

  if (!activeAcademy) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-6">
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
