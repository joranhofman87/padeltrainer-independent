import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { sendEmail } from '@/lib/email';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';

interface RequestClubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const COUNTRIES: Record<string, string> = {
  NL: 'Nederland',
  BE: 'België',
  DE: 'Deutschland',
};

export function RequestClubDialog({ open, onOpenChange }: RequestClubDialogProps) {
  const { t } = useTranslation('common');
  const { toast } = useToast();
  const { profile } = useAuth();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    clubName: '',
    city: '',
    country: 'NL',
    streetAddress: '',
    websiteUrl: '',
    additionalNotes: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.clubName.trim() || !formData.city.trim()) {
      toast({
        title: t('locations.requestClubError', 'Error'),
        description: t('locations.fillRequiredFields', 'Please fill in the required fields.'),
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const result = await sendEmail('location_request', 'info@padeltrainer.ai', {
        clubName: formData.clubName,
        city: formData.city,
        country: COUNTRIES[formData.country] || formData.country,
        streetAddress: formData.streetAddress || undefined,
        websiteUrl: formData.websiteUrl || undefined,
        additionalNotes: formData.additionalNotes || undefined,
        requestedBy: profile?.full_name || 'Unknown',
        requestedByEmail: profile?.email || 'Unknown',
      });

      if (result.success) {
        toast({
          title: t('locations.requestSubmitted', 'Request submitted'),
          description: t('locations.requestSubmittedDesc', 'We will review your request and add the club soon.'),
        });
        setFormData({
          clubName: '',
          city: '',
          country: 'NL',
          streetAddress: '',
          websiteUrl: '',
          additionalNotes: '',
        });
        onOpenChange(false);
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Error submitting club request:', error);
      toast({
        title: t('locations.requestClubError', 'Error'),
        description: t('locations.requestClubErrorDesc', 'Failed to submit request. Please try again.'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('locations.requestNewClub', 'Request new club')}</DialogTitle>
          <DialogDescription>
            {t('locations.requestNewClubDesc', "Can't find your club? Submit a request and we'll add it to the platform.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="clubName">{t('locations.clubName', 'Club name')} *</Label>
            <Input
              id="clubName"
              value={formData.clubName}
              onChange={(e) => setFormData({ ...formData, clubName: e.target.value })}
              placeholder={t('locations.clubNamePlaceholder', 'e.g., Padel Club Amsterdam')}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="city">{t('locations.city', 'City')} *</Label>
              <Input
                id="city"
                value={formData.city}
                onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                placeholder={t('locations.cityPlaceholder', 'e.g., Amsterdam')}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="country">{t('locations.country', 'Country')}</Label>
              <Select
                value={formData.country}
                onValueChange={(value) => setFormData({ ...formData, country: value })}
              >
                <SelectTrigger id="country">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(COUNTRIES).map(([code, name]) => (
                    <SelectItem key={code} value={code}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="streetAddress">{t('locations.streetAddress', 'Street address')}</Label>
            <Input
              id="streetAddress"
              value={formData.streetAddress}
              onChange={(e) => setFormData({ ...formData, streetAddress: e.target.value })}
              placeholder={t('locations.streetAddressPlaceholder', 'e.g., Sportlaan 123')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="websiteUrl">{t('locations.website', 'Website')}</Label>
            <Input
              id="websiteUrl"
              type="url"
              value={formData.websiteUrl}
              onChange={(e) => setFormData({ ...formData, websiteUrl: e.target.value })}
              placeholder="https://"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="additionalNotes">{t('locations.additionalNotes', 'Additional notes')}</Label>
            <Textarea
              id="additionalNotes"
              value={formData.additionalNotes}
              onChange={(e) => setFormData({ ...formData, additionalNotes: e.target.value })}
              placeholder={t('locations.additionalNotesPlaceholder', 'Any other information about this club...')}
              rows={3}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('locations.submitRequest', 'Submit request')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
