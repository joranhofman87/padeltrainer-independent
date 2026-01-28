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
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { updateAcademyLocation, type AcademyLocationWithDetails } from '@/lib/academy';

interface EditAcademyLocationDialogProps {
  academyLocation: AcademyLocationWithDetails;
  onLocationUpdated: () => void;
}

export function EditAcademyLocationDialog({
  academyLocation,
  onLocationUpdated,
}: EditAcademyLocationDialogProps) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [contractType, setContractType] = useState<'exclusive' | 'non_exclusive'>(
    academyLocation.contract_type || 'non_exclusive'
  );
  const [contractStart, setContractStart] = useState(
    academyLocation.contract_start?.split('T')[0] || ''
  );
  const [contractEnd, setContractEnd] = useState(
    academyLocation.contract_end?.split('T')[0] || ''
  );
  const [isActive, setIsActive] = useState(academyLocation.is_active);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setLoading(true);
    try {
      const success = await updateAcademyLocation(academyLocation.id, {
        contract_type: contractType,
        contract_start: contractStart || null,
        contract_end: contractEnd || null,
        is_active: isActive,
      });

      if (success) {
        toast({
          title: t('locations.updated'),
          description: t('locations.updatedDescription'),
        });
        setOpen(false);
        onLocationUpdated();
      } else {
        throw new Error('Failed to update');
      }
    } catch (error) {
      console.error('Error updating location:', error);
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
          {t('locations.edit')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('locations.editContract')}</DialogTitle>
            <DialogDescription>
              {academyLocation.location.name} - {academyLocation.location.city}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {/* Contract Type */}
            <div className="grid gap-2">
              <Label>{t('locations.contractType')}</Label>
              <Select
                value={contractType}
                onValueChange={(v) => setContractType(v as 'exclusive' | 'non_exclusive')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="non_exclusive">
                    {t('locations.nonExclusive')}
                  </SelectItem>
                  <SelectItem value="exclusive">
                    {t('locations.exclusive')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Contract Dates */}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="editContractStart">{t('locations.contractStart')}</Label>
                <Input
                  id="editContractStart"
                  type="date"
                  value={contractStart}
                  onChange={(e) => setContractStart(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="editContractEnd">{t('locations.contractEnd')}</Label>
                <Input
                  id="editContractEnd"
                  type="date"
                  value={contractEnd}
                  onChange={(e) => setContractEnd(e.target.value)}
                />
              </div>
            </div>

            {/* Active Status */}
            <div className="flex items-center justify-between pt-2 border-t">
              <div>
                <Label htmlFor="isActive">{t('locations.activeContract')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('locations.activeContractHint')}
                </p>
              </div>
              <Switch
                id="isActive"
                checked={isActive}
                onCheckedChange={setIsActive}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('common:save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
