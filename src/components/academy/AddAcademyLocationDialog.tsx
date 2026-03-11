import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Loader2, MapPin, CalendarDays } from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { addAcademyLocation } from '@/lib/academy';
import { LocationPicker } from '@/components/locations/LocationPicker';

interface AddAcademyLocationDialogProps {
  academyProfileId: string;
  existingLocationIds: string[];
  onLocationAdded: () => void;
}

export function AddAcademyLocationDialog({
  academyProfileId,
  existingLocationIds,
  onLocationAdded,
}: AddAcademyLocationDialogProps) {
  const { t } = useTranslation('academy');
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([]);
  const [contractType, setContractType] = useState<'exclusive' | 'non_exclusive'>('non_exclusive');
  const [contractStart, setContractStart] = useState('');
  const [contractEnd, setContractEnd] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedLocationIds.length === 0) return;

    setLoading(true);
    try {
      // Add each selected location
      let hasError = false;
      for (const locationId of selectedLocationIds) {
        if (existingLocationIds.includes(locationId)) continue;

        const result = await addAcademyLocation(
          academyProfileId,
          locationId,
          contractType,
          contractStart || undefined,
          contractEnd || undefined
        );

        if (!result.success) {
          toast({
            title: t('locations.addError'),
            description: result.error,
            variant: 'destructive',
          });
          hasError = true;
        }
      }

      if (!hasError) {
        toast({
          title: t('locations.added'),
          description: t('locations.addedDescription'),
        });

        setSelectedLocationIds([]);
        setContractType('non_exclusive');
        setContractStart('');
        setContractEnd('');
        setOpen(false);
        onLocationAdded();
      }
    } catch (error) {
      logger.error('Error adding location', error instanceof Error ? error : new Error(String(error)), { component: 'AddAcademyLocationDialog' });
      toast({
        title: t('common:error'),
        description: String(error),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  // Filter out already added locations
  const handleLocationChange = (ids: string[]) => {
    const filtered = ids.filter((id) => !existingLocationIds.includes(id));
    setSelectedLocationIds(filtered);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-2" />
          {t('locations.addLocation')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('locations.addLocation')}</DialogTitle>
            <DialogDescription>
              {t('locations.addLocationDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {/* Location Picker */}
            <div className="grid gap-2">
              <Label className="flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                {t('locations.selectLocations')}
              </Label>
              <LocationPicker
                selectedLocationIds={selectedLocationIds}
                onChange={handleLocationChange}
                showPrimary={false}
                showCountryFilter={true}
              />
            </div>

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
              <p className="text-xs text-muted-foreground">
                {contractType === 'exclusive'
                  ? t('locations.exclusiveHint')
                  : t('locations.nonExclusiveHint')}
              </p>
            </div>

            {/* Contract Dates */}
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="contractStart" className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4" />
                  {t('locations.contractStart')}
                </Label>
                <Input
                  id="contractStart"
                  type="date"
                  value={contractStart}
                  onChange={(e) => setContractStart(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="contractEnd">{t('locations.contractEnd')}</Label>
                <Input
                  id="contractEnd"
                  type="date"
                  value={contractEnd}
                  onChange={(e) => setContractEnd(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={loading || selectedLocationIds.length === 0}>
              {loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              {t('locations.addLocation')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
