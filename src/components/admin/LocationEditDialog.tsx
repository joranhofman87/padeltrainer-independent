import { useState, useEffect, useRef } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { createLocation, updateLocation, type Location } from '@/lib/locations';

interface LocationEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: Location | null;
  onSuccess: () => void;
}

interface ClubData {
  id: string;
  is_verified: boolean;
  subscription_status: string | null;
  subscription_tier: string | null;
  trial_ends_at: string | null;
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_tiktok: string | null;
  social_youtube: string | null;
  social_linkedin: string | null;
}

interface FormData {
  name: string;
  city: string;
  country: string;
  street_address: string;
  postal_code: string;
  slug: string;
  is_active: boolean;
  description: string;
  website_url: string;
  indoor_courts: number;
  outdoor_courts: number;
  opening_hours: string;
  phone: string;
  email: string;
  logo_url: string;
  facebook_url: string;
  instagram_url: string;
  google_maps_url: string;
  google_rating: string;
  google_review_count: string;
  latitude: string;
  longitude: string;
}

const getInitialFormData = (location: Location | null): FormData => ({
  name: location?.name || '',
  city: location?.city || '',
  country: location?.country || 'NL',
  street_address: location?.street_address || '',
  postal_code: location?.postal_code || '',
  slug: location?.slug || '',
  is_active: location?.is_active ?? true,
  description: location?.description || '',
  website_url: location?.website_url || '',
  indoor_courts: location?.indoor_courts ?? 0,
  outdoor_courts: location?.outdoor_courts ?? 0,
  opening_hours: location?.opening_hours || '',
  phone: location?.phone || '',
  email: location?.email || '',
  logo_url: location?.logo_url || '',
  facebook_url: location?.facebook_url || '',
  instagram_url: location?.instagram_url || '',
  google_maps_url: location?.google_maps_url || '',
  google_rating: location?.google_rating?.toString() || '',
  google_review_count: location?.google_review_count?.toString() || '',
  latitude: location?.latitude?.toString() || '',
  longitude: location?.longitude?.toString() || '',
});

export function LocationEditDialog({
  open,
  onOpenChange,
  location,
  onSuccess,
}: LocationEditDialogProps) {
  const { toast } = useToast();
  const [formData, setFormData] = useState<FormData>(getInitialFormData(location));
  const [saving, setSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [clubData, setClubData] = useState<ClubData | null>(null);
  const [clubFormData, setClubFormData] = useState<Omit<ClubData, 'id'> | null>(null);

  useEffect(() => {
    if (open) {
      setFormData(getInitialFormData(location));
      if (location?.id) {
        supabaseTyped
          .from('club_profiles')
          .select('id, is_verified, subscription_status, subscription_tier, trial_ends_at, description, contact_email, phone, social_instagram, social_facebook, social_tiktok, social_youtube, social_linkedin')
          .eq('location_id', location.id)
          .maybeSingle()
          .then(({ data }) => {
            if (data) {
              setClubData(data);
              setClubFormData({
                is_verified: data.is_verified,
                subscription_status: data.subscription_status,
                subscription_tier: data.subscription_tier,
                trial_ends_at: data.trial_ends_at,
                description: data.description,
                contact_email: data.contact_email,
                phone: data.phone,
                social_instagram: data.social_instagram,
                social_facebook: data.social_facebook,
                social_tiktok: data.social_tiktok,
                social_youtube: data.social_youtube,
                social_linkedin: data.social_linkedin,
              });
            } else {
              setClubData(null);
              setClubFormData(null);
            }
          });
      } else {
        setClubData(null);
        setClubFormData(null);
      }
    }
  }, [open, location]);

  const generateSlug = (name: string, city: string) => {
    return `${name}-${city}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  };

  const handleSave = async () => {
    if (!formData.name || !formData.city) {
      toast({
        title: 'Validation Error',
        description: 'Name and city are required',
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      const slug = formData.slug || generateSlug(formData.name, formData.city);
      const locationData = {
        name: formData.name,
        city: formData.city,
        country: formData.country,
        street_address: formData.street_address || null,
        postal_code: formData.postal_code || null,
        slug,
        is_active: formData.is_active,
        description: formData.description || null,
        website_url: formData.website_url || null,
        indoor_courts: formData.indoor_courts ?? 0,
        outdoor_courts: formData.outdoor_courts ?? 0,
        number_of_courts: (formData.indoor_courts ?? 0) + (formData.outdoor_courts ?? 0) || null,
        opening_hours: formData.opening_hours || null,
        phone: formData.phone || null,
        email: formData.email || null,
        logo_url: formData.logo_url || null,
        facebook_url: formData.facebook_url || null,
        instagram_url: formData.instagram_url || null,
        google_maps_url: formData.google_maps_url || null,
        google_rating: formData.google_rating ? parseFloat(formData.google_rating) : null,
        google_review_count: formData.google_review_count ? parseInt(formData.google_review_count) : null,
        latitude: formData.latitude ? parseFloat(formData.latitude) : null,
        longitude: formData.longitude ? parseFloat(formData.longitude) : null,
      };

      if (location) {
        await updateLocation(location.id, locationData);
        toast({ title: 'Success', description: 'Location updated successfully' });
      } else {
        await createLocation(locationData);
        toast({ title: 'Success', description: 'Location created successfully' });
      }

      // Update linked club profile if present
      if (clubData && clubFormData) {
        const { error: clubError } = await supabaseTyped
          .from('club_profiles')
          .update({
            is_verified: clubFormData.is_verified,
            subscription_status: clubFormData.subscription_status,
            subscription_tier: clubFormData.subscription_tier,
            trial_ends_at: clubFormData.trial_ends_at,
            description: clubFormData.description,
            contact_email: clubFormData.contact_email,
            phone: clubFormData.phone,
            social_instagram: clubFormData.social_instagram,
            social_facebook: clubFormData.social_facebook,
            social_tiktok: clubFormData.social_tiktok,
            social_youtube: clubFormData.social_youtube,
            social_linkedin: clubFormData.social_linkedin,
          })
          .eq('id', clubData.id);
        if (clubError) throw clubError;
      }

      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      logger.error('Error saving location', error instanceof Error ? error : new Error(String(error)), { component: 'LocationEditDialog' });
      toast({
        title: 'Error',
        description: error.message || 'Failed to save location',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const updateField = <K extends keyof FormData>(key: K, value: FormData[K]) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Error", description: "Please upload an image file.", variant: "destructive" });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Error", description: "File size must be under 5MB.", variant: "destructive" });
      return;
    }

    setLogoUploading(true);
    try {
      const fileExt = file.name.split(".").pop();
      const locationId = location?.id || `temp-${Date.now()}`;
      const filePath = `locations/${locationId}/logo.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from("avatars")
        .getPublicUrl(filePath);

      const newUrl = publicUrlData.publicUrl + "?t=" + Date.now();
      updateField('logo_url', newUrl);
      toast({ title: "Logo uploaded", description: "Logo image uploaded successfully." });
    } catch (error: any) {
      logger.error("Error uploading logo", error instanceof Error ? error : new Error(String(error)), { component: 'LocationEditDialog' });
      toast({ title: "Error", description: error.message || "Failed to upload logo.", variant: "destructive" });
    } finally {
      setLogoUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{location ? `Edit Location: ${location.name}` : 'Add New Location'}</DialogTitle>
          <DialogDescription>
            {location
              ? 'Update the location details below.'
              : 'Add a new padel venue to the platform.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Basic Info */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Basic Info</h3>
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={e => updateField('name', e.target.value)}
                placeholder="Club name"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="city">City *</Label>
                <Input
                  id="city"
                  value={formData.city}
                  onChange={e => updateField('city', e.target.value)}
                  placeholder="City"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="country">Country</Label>
                <Select
                  value={formData.country}
                  onValueChange={value => updateField('country', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NL">Netherlands</SelectItem>
                    <SelectItem value="BE">Belgium</SelectItem>
                    <SelectItem value="DE">Germany</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="street_address">Street Address</Label>
                <Input
                  id="street_address"
                  value={formData.street_address}
                  onChange={e => updateField('street_address', e.target.value)}
                  placeholder="Street address"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="postal_code">Postal Code</Label>
                <Input
                  id="postal_code"
                  value={formData.postal_code}
                  onChange={e => updateField('postal_code', e.target.value)}
                  placeholder="Postal code"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="slug">URL Slug</Label>
                <Input
                  id="slug"
                  value={formData.slug}
                  onChange={e => updateField('slug', e.target.value)}
                  placeholder="Auto-generated if empty"
                />
              </div>
              <div className="flex items-center justify-between pt-6">
                <Label htmlFor="is_active">Active</Label>
                <Switch
                  id="is_active"
                  checked={formData.is_active}
                  onCheckedChange={checked => updateField('is_active', checked)}
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Details */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Details</h3>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={clubData ? (clubFormData?.description || formData.description || '') : formData.description}
                onChange={e => {
                  if (clubData && clubFormData) {
                    setClubFormData(prev => prev ? { ...prev, description: e.target.value } : prev);
                  }
                  updateField('description', e.target.value);
                }}
                placeholder="Description of the venue..."
                rows={3}
              />
              {clubData && (
                <p className="text-xs text-muted-foreground">Editing updates the club profile description</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="website_url">Website URL</Label>
              <Input
                id="website_url"
                value={formData.website_url}
                onChange={e => updateField('website_url', e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="indoor_courts">Indoor Courts</Label>
                <Input
                  id="indoor_courts"
                  type="number"
                  min="0"
                  value={formData.indoor_courts}
                  onChange={e => updateField('indoor_courts', parseInt(e.target.value) || 0)}
                  placeholder="0"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="outdoor_courts">Outdoor Courts</Label>
                <Input
                  id="outdoor_courts"
                  type="number"
                  min="0"
                  value={formData.outdoor_courts}
                  onChange={e => updateField('outdoor_courts', parseInt(e.target.value) || 0)}
                  placeholder="0"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="opening_hours">Opening Hours</Label>
              <Textarea
                id="opening_hours"
                value={formData.opening_hours}
                onChange={e => updateField('opening_hours', e.target.value)}
                placeholder="Mon-Fri: 9:00-22:00&#10;Sat-Sun: 8:00-20:00"
                rows={2}
              />
            </div>
          </div>

          <Separator />

          {/* Contact */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Contact</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={e => updateField('phone', e.target.value)}
                  placeholder="+31 6 12345678"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={e => updateField('email', e.target.value)}
                  placeholder="info@example.com"
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Media */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Media</h3>
            <div className="space-y-2">
              <Label htmlFor="logo_url">Logo</Label>
              <div className="flex gap-2">
                <Input
                  id="logo_url"
                  value={formData.logo_url}
                  onChange={e => updateField('logo_url', e.target.value)}
                  placeholder="URL or upload"
                  className="flex-1"
                />
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleLogoUpload}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => logoInputRef.current?.click()}
                  disabled={logoUploading}
                >
                  {logoUploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                </Button>
              </div>
              {formData.logo_url && (
                <div className="mt-2">
                  <img
                    src={formData.logo_url}
                    alt="Logo preview"
                    className="h-16 w-16 object-contain rounded-md border"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* Social & Google */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Social & Google</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="facebook_url">Facebook URL</Label>
                <Input
                  id="facebook_url"
                  value={formData.facebook_url}
                  onChange={e => updateField('facebook_url', e.target.value)}
                  placeholder="https://facebook.com/..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="instagram_url">Instagram URL</Label>
                <Input
                  id="instagram_url"
                  value={formData.instagram_url}
                  onChange={e => updateField('instagram_url', e.target.value)}
                  placeholder="https://instagram.com/..."
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="google_maps_url">Google Maps URL</Label>
              <Input
                id="google_maps_url"
                value={formData.google_maps_url}
                onChange={e => updateField('google_maps_url', e.target.value)}
                placeholder="https://maps.google.com/..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="google_rating">Google Rating</Label>
                <Input
                  id="google_rating"
                  type="number"
                  step="0.1"
                  min="0"
                  max="5"
                  value={formData.google_rating}
                  onChange={e => updateField('google_rating', e.target.value)}
                  placeholder="4.5"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="google_review_count">Google Review Count</Label>
                <Input
                  id="google_review_count"
                  type="number"
                  min="0"
                  value={formData.google_review_count}
                  onChange={e => updateField('google_review_count', e.target.value)}
                  placeholder="123"
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Coordinates */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Coordinates</h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="latitude">Latitude</Label>
                <Input
                  id="latitude"
                  type="number"
                  step="any"
                  value={formData.latitude}
                  onChange={e => updateField('latitude', e.target.value)}
                  placeholder="52.3676"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="longitude">Longitude</Label>
                <Input
                  id="longitude"
                  type="number"
                  step="any"
                  value={formData.longitude}
                  onChange={e => updateField('longitude', e.target.value)}
                  placeholder="4.9041"
                />
              </div>
            </div>
          </div>

          {/* Club Management - only shown when a club profile is linked */}
          {clubFormData && (
            <>
              <Separator />
              <div className="space-y-4">
                <h3 className="text-sm font-medium text-muted-foreground">Club Management</h3>
                <div className="flex items-center justify-between">
                  <Label htmlFor="club_verified">Verified</Label>
                  <Switch
                    id="club_verified"
                    checked={clubFormData.is_verified}
                    onCheckedChange={checked =>
                      setClubFormData(prev => prev ? { ...prev, is_verified: checked } : prev)
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="club_sub_status">Subscription Status</Label>
                  <Select
                    value={clubFormData.subscription_status || 'inactive'}
                    onValueChange={value =>
                      setClubFormData(prev => prev ? { ...prev, subscription_status: value } : prev)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inactive">Inactive</SelectItem>
                      <SelectItem value="trial">Trial</SelectItem>
                      <SelectItem value="active">Active</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {clubFormData.subscription_status !== 'active' && (
                  <div className="space-y-2">
                    <Label htmlFor="club_trial_ends">Trial Ends At</Label>
                    <Input
                      id="club_trial_ends"
                      type="date"
                      value={clubFormData.trial_ends_at?.split('T')[0] || ''}
                      onChange={e =>
                        setClubFormData(prev =>
                          prev
                            ? { ...prev, trial_ends_at: e.target.value ? `${e.target.value}T23:59:59Z` : null }
                            : prev
                        )
                      }
                    />
                  </div>
                )}

                <Separator />
                <h3 className="text-sm font-medium text-muted-foreground">Club Profile Details</h3>

                <div className="space-y-2">
                  <Label htmlFor="club_description">Club Description</Label>
                  <Textarea
                    id="club_description"
                    value={clubFormData.description || ''}
                    onChange={e =>
                      setClubFormData(prev => prev ? { ...prev, description: e.target.value || null } : prev)
                    }
                    placeholder="Club description..."
                    rows={3}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="club_contact_email">Contact Email</Label>
                    <Input
                      id="club_contact_email"
                      type="email"
                      value={clubFormData.contact_email || ''}
                      onChange={e =>
                        setClubFormData(prev => prev ? { ...prev, contact_email: e.target.value || null } : prev)
                      }
                      placeholder="info@club.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="club_phone">Phone</Label>
                    <Input
                      id="club_phone"
                      value={clubFormData.phone || ''}
                      onChange={e =>
                        setClubFormData(prev => prev ? { ...prev, phone: e.target.value || null } : prev)
                      }
                      placeholder="+31 6 12345678"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="club_instagram">Instagram</Label>
                    <Input
                      id="club_instagram"
                      value={clubFormData.social_instagram || ''}
                      onChange={e =>
                        setClubFormData(prev => prev ? { ...prev, social_instagram: e.target.value || null } : prev)
                      }
                      placeholder="https://instagram.com/..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="club_facebook">Facebook</Label>
                    <Input
                      id="club_facebook"
                      value={clubFormData.social_facebook || ''}
                      onChange={e =>
                        setClubFormData(prev => prev ? { ...prev, social_facebook: e.target.value || null } : prev)
                      }
                      placeholder="https://facebook.com/..."
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="club_tiktok">TikTok</Label>
                    <Input
                      id="club_tiktok"
                      value={clubFormData.social_tiktok || ''}
                      onChange={e =>
                        setClubFormData(prev => prev ? { ...prev, social_tiktok: e.target.value || null } : prev)
                      }
                      placeholder="https://tiktok.com/..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="club_youtube">YouTube</Label>
                    <Input
                      id="club_youtube"
                      value={clubFormData.social_youtube || ''}
                      onChange={e =>
                        setClubFormData(prev => prev ? { ...prev, social_youtube: e.target.value || null } : prev)
                      }
                      placeholder="https://youtube.com/..."
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="club_linkedin">LinkedIn</Label>
                  <Input
                    id="club_linkedin"
                    value={clubFormData.social_linkedin || ''}
                    onChange={e =>
                      setClubFormData(prev => prev ? { ...prev, social_linkedin: e.target.value || null } : prev)
                    }
                    placeholder="https://linkedin.com/..."
                  />
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {location ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
