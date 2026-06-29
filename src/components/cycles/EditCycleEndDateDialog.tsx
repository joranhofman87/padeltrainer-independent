import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getCycleDates } from '@/lib/cycles';
import { applyCycleEndDate } from '@/lib/cycleExtension';
import { CycleEndDateFields, type CycleEndDatePlan } from './CycleEndDateFields';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cyclusId: string | null;
  cyclusName: string;
  /** Called after a successful save so the caller can refresh its list. */
  onSaved: () => void;
}

/**
 * Scoped editor for a cyclus's END DATE only — used as a per-row action on the cycles list. A later
 * date GENERATES the missing weekly sessions; an earlier date can trim the now-out-of-range EMPTY
 * sessions (booked ones are always kept). The fields + previews live in the shared CycleEndDateFields
 * (reused by the consolidated cycle editor); this dialog just hosts them + owns the save. Invoice-safe.
 */
export function EditCycleEndDateDialog({ open, onOpenChange, cyclusId, cyclusName, onSaved }: Props) {
  const { t } = useTranslation('cycles');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [originalEnd, setOriginalEnd] = useState<string | null>(null);
  const [endDate, setEndDate] = useState('');
  const [plan, setPlan] = useState<CycleEndDatePlan | null>(null);

  // Load the cyclus's current dates when the dialog opens.
  useEffect(() => {
    if (!open || !cyclusId) return;
    let cancelled = false;
    setLoading(true);
    getCycleDates(cyclusId)
      .then((d) => {
        if (cancelled) return;
        setStartDate(d.start_date);
        setOriginalEnd(d.end_date);
        setEndDate(d.end_date ?? '');
      })
      .catch(() => { if (!cancelled) toast.error(t('editEndDate.loadFailed', 'Kon de cyclus niet laden.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, cyclusId, t]);

  const invalid = plan?.invalid ?? false;

  const handleSave = async () => {
    if (!cyclusId || !endDate || invalid) return;
    setSaving(true);
    try {
      const { added, removed } = await applyCycleEndDate(cyclusId, endDate, {
        removableIds: plan?.removableIds,
        removeUnbooked: plan?.removeUnbooked,
      });
      toast.success(
        added > 0
          ? t('editEndDate.savedWithAdd', 'Einddatum bijgewerkt · {{count}} sessies toegevoegd', { count: added })
          : removed > 0
            ? t('editEndDate.savedWithTrim', 'Einddatum bijgewerkt · {{count}} sessies verwijderd', { count: removed })
            : t('editEndDate.saved', 'Einddatum bijgewerkt'),
      );
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error(t('editEndDate.saveFailed', 'Kon de einddatum niet bijwerken. Probeer het opnieuw.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('editEndDate.title', 'Einddatum aanpassen')}</DialogTitle>
          <DialogDescription className="truncate">{cyclusName}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 flex justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="py-2">
            <CycleEndDateFields
              cyclusId={cyclusId}
              open={open}
              startDate={startDate}
              originalEnd={originalEnd}
              value={endDate}
              onChange={setEndDate}
              onPlanChange={setPlan}
              disabled={saving}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common:cancel', 'Annuleren')}
          </Button>
          <Button onClick={handleSave} disabled={saving || loading || !endDate || invalid}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {t('editEndDate.save', 'Opslaan')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
