import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { claimClub } from '@/lib/club';
import { Loader2, Building2 } from 'lucide-react';

interface ClaimClubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: string;
  locationName: string;
  userId: string;
  userEmail?: string;
}

export function ClaimClubDialog({
  open,
  onOpenChange,
  locationId,
  locationName,
  userId,
  userEmail,
}: ClaimClubDialogProps) {
  const { t } = useTranslation('club');
  const { toast } = useToast();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    contactEmail: userEmail || '',
    phone: '',
    description: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.contactEmail) {
      toast({
        title: t('claim.error'),
        description: t('claim.emailRequired'),
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const { clubProfile, error } = await claimClub(
        locationId,
        userId,
        formData.contactEmail,
        formData.phone,
        formData.description
      );

      if (error) {
        throw error;
      }

      toast({
        title: t('claim.success'),
        description: t('claim.successDescription'),
      });

      onOpenChange(false);
      navigate('/club');
    } catch (error: any) {
      console.error('Error claiming club:', error);
      toast({
        title: t('claim.error'),
        description: error.message || t('claim.errorDescription'),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            <DialogTitle>{t('claim.title')}</DialogTitle>
          </div>
          <DialogDescription>
            {t('claim.description', { clubName: locationName })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="contactEmail">{t('claim.contactEmail')} *</Label>
            <Input
              id="contactEmail"
              type="email"
              value={formData.contactEmail}
              onChange={(e) =>
                setFormData({ ...formData, contactEmail: e.target.value })
              }
              placeholder={t('claim.contactEmailPlaceholder')}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone">{t('claim.phone')}</Label>
            <Input
              id="phone"
              type="tel"
              value={formData.phone}
              onChange={(e) =>
                setFormData({ ...formData, phone: e.target.value })
              }
              placeholder={t('claim.phonePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">{t('claim.aboutClub')}</Label>
            <Textarea
              id="description"
              value={formData.description}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
              placeholder={t('claim.aboutClubPlaceholder')}
              rows={3}
            />
          </div>

          <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            <p>{t('claim.verificationNote')}</p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('claim.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
