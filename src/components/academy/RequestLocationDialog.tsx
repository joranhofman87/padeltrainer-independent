import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPinPlus, Loader2 } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';

interface RequestLocationDialogProps {
  academyProfileId?: string;
  onRequestSubmitted?: () => void;
}

const COUNTRIES = [
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'DE', name: 'Germany' },
  { code: 'ES', name: 'Spain' },
  { code: 'FR', name: 'France' },
  { code: 'IT', name: 'Italy' },
  { code: 'PT', name: 'Portugal' },
  { code: 'UK', name: 'United Kingdom' },
  { code: 'SE', name: 'Sweden' },
  { code: 'DK', name: 'Denmark' },
];

export function RequestLocationDialog({
  academyProfileId,
  onRequestSubmitted,
}: RequestLocationDialogProps) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    city: '',
    country: 'NL',
    street_address: '',
    postal_code: '',
    website_url: '',
    phone: '',
    email: '',
    notes: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name || !formData.city) {
      toast({
        title: t('common.error'),
        description: 'Name and city are required',
        variant: 'destructive',
      });
      return;
    }

    if (!user) {
      toast({
        title: t('common.error'),
        description: 'You must be logged in',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);

    try {
      const { error } = await supabase.from('location_requests').insert({
        name: formData.name,
        city: formData.city,
        country: formData.country,
        street_address: formData.street_address || null,
        postal_code: formData.postal_code || null,
        website_url: formData.website_url || null,
        phone: formData.phone || null,
        email: formData.email || null,
        notes: formData.notes || null,
        requested_by: user.id,
        request_context: 'academy',
        context_id: academyProfileId || null,
        status: 'pending',
      });

      if (error) throw error;

      toast({
        title: t('locations.requestSubmitted'),
        description: t('locations.requestSubmittedDescription'),
      });

      setOpen(false);
      setFormData({
        name: '',
        city: '',
        country: 'NL',
        street_address: '',
        postal_code: '',
        website_url: '',
        phone: '',
        email: '',
        notes: '',
      });

      onRequestSubmitted?.();
    } catch (error: any) {
      logger.error('Error submitting location request', error instanceof Error ? error : new Error(String(error)), { component: 'RequestLocationDialog' });
      toast({
        title: t('common.error'),
        description: error.message || 'Failed to submit location request',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <MapPinPlus className="h-4 w-4 mr-2" />
          {t('locations.requestNew')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('locations.requestNew')}</DialogTitle>
            <DialogDescription>
              {t('locations.requestNewDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="location-name">Location Name *</Label>
                <Input
                  id="location-name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="Padel Club Amsterdam"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="location-city">City *</Label>
                <Input
                  id="location-city"
                  value={formData.city}
                  onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                  placeholder="Amsterdam"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="location-country">Country</Label>
              <Select
                value={formData.country}
                onValueChange={(value) => setFormData({ ...formData, country: value })}
              >
                <SelectTrigger id="location-country">
                  <SelectValue placeholder="Select country" />
                </SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((country) => (
                    <SelectItem key={country.code} value={country.code}>
                      {country.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="location-address">Street Address</Label>
                <Input
                  id="location-address"
                  value={formData.street_address}
                  onChange={(e) => setFormData({ ...formData, street_address: e.target.value })}
                  placeholder="Sportlaan 123"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="location-postal">Postal Code</Label>
                <Input
                  id="location-postal"
                  value={formData.postal_code}
                  onChange={(e) => setFormData({ ...formData, postal_code: e.target.value })}
                  placeholder="1234 AB"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="location-website">Website</Label>
              <Input
                id="location-website"
                type="url"
                value={formData.website_url}
                onChange={(e) => setFormData({ ...formData, website_url: e.target.value })}
                placeholder="https://www.example.com"
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="location-phone">Phone</Label>
                <Input
                  id="location-phone"
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="+31 20 1234567"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="location-email">Email</Label>
                <Input
                  id="location-email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="info@example.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="location-notes">Additional Notes</Label>
              <Textarea
                id="location-notes"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                placeholder="Any additional information about this location..."
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit Request
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
