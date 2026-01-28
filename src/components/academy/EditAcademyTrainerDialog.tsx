import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Loader2 } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { useToast } from '@/hooks/use-toast';
import { updateAcademyTrainerPayment } from '@/lib/academy';

interface EditAcademyTrainerDialogProps {
  trainer: {
    id: string;
    payment_percentage: number;
    profile?: {
      full_name: string | null;
    };
  };
  onTrainerUpdated: () => void;
}

export function EditAcademyTrainerDialog({
  trainer,
  onTrainerUpdated,
}: EditAcademyTrainerDialogProps) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [paymentPercentage, setPaymentPercentage] = useState(trainer.payment_percentage);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setLoading(true);
    try {
      const success = await updateAcademyTrainerPayment(trainer.id, paymentPercentage);

      if (success) {
        toast({
          title: t('trainers.updated'),
          description: t('trainers.updatedDescription'),
        });
        setOpen(false);
        onTrainerUpdated();
      } else {
        throw new Error('Failed to update');
      }
    } catch (error) {
      console.error('Error updating trainer:', error);
      toast({
        title: t('common:error'),
        description: String(error),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="h-4 w-4 mr-2" />
          {t('trainers.edit')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('trainers.editTrainer')}</DialogTitle>
            <DialogDescription>
              {trainer.profile?.full_name || 'Trainer'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>{t('trainerInvitation.paymentPercentage')}</Label>
              <div className="flex items-center gap-4">
                <Slider
                  value={[paymentPercentage]}
                  onValueChange={(value) => setPaymentPercentage(value[0])}
                  min={0}
                  max={100}
                  step={5}
                  className="flex-1"
                />
                <span className="w-16 text-right font-medium">{paymentPercentage}%</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('trainerInvitation.paymentDescription', {
                  percentage: paymentPercentage,
                  academyPercentage: 100 - paymentPercentage,
                })}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              {t('common:save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
