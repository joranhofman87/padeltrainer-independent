import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { createLocation, updateLocation, type Location } from '@/lib/locations';

interface LocationEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: Location | null;
  onSuccess: () => void;
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

  useEffect(() => {
    if (open) {
      setFormData(getInitialFormData(location));
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

      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error('Error saving location:', error);
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

        <Tabs defaultValue="basic" className="w-full">
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="contact">Contact</TabsTrigger>
            <TabsTrigger value="media">Media</TabsTrigger>
            <TabsTrigger value="social">Social</TabsTrigger>
            <TabsTrigger value="coords">Coords</TabsTrigger>
          </TabsList>

          {/* Basic Tab */}
          <TabsContent value="basic" className="space-y-4 mt-4">
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
            <div className="space-y-2">
              <Label htmlFor="slug">URL Slug</Label>
              <Input
                id="slug"
                value={formData.slug}
                onChange={e => updateField('slug', e.target.value)}
                placeholder="Auto-generated if empty"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="is_active">Active</Label>
              <Switch
                id="is_active"
                checked={formData.is_active}
                onCheckedChange={checked => updateField('is_active', checked)}
              />
            </div>
          </TabsContent>

          {/* Details Tab */}
          <TabsContent value="details" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={e => updateField('description', e.target.value)}
                placeholder="Description of the venue..."
                rows={4}
              />
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
                rows={3}
              />
            </div>
          </TabsContent>

          {/* Contact Tab */}
          <TabsContent value="contact" className="space-y-4 mt-4">
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
          </TabsContent>

          {/* Media Tab */}
          <TabsContent value="media" className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="logo_url">Logo URL</Label>
              <Input
                id="logo_url"
                value={formData.logo_url}
                onChange={e => updateField('logo_url', e.target.value)}
                placeholder="https://..."
              />
              {formData.logo_url && (
                <div className="mt-2">
                  <img
                    src={formData.logo_url}
                    alt="Logo preview"
                    className="h-20 w-20 object-contain rounded-md border"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
              )}
            </div>
          </TabsContent>

          {/* Social Tab */}
          <TabsContent value="social" className="space-y-4 mt-4">
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
          </TabsContent>

          {/* Coords Tab */}
          <TabsContent value="coords" className="space-y-4 mt-4">
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
          </TabsContent>
        </Tabs>

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
