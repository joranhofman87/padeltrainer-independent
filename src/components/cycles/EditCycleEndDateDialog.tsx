import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, AlertTriangle } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  getCycleDates, findSlotsAfterDate, deleteUnbookedSlots, updateCycle, type OutOfRangeSlots,
} from '@/lib/cycles';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cyclusId: string | null;
  cyclusName: string;
  /** Called after a successful save so the caller can refresh its list. */
  onSaved: () => void;
}

/**
 * Scoped editor for a cyclus's END DATE only. Reuses the invoice-safe `updateCycle`
 * write (a plain one-row update — no invoice recompute), and, when the end date is
 * shortened, offers to remove the now-out-of-range sessions that have NO bookings
 * (booked/paid sessions are always protected). Deliberately does not touch price,
 * weeks, capacity or invoices.
 */
export function EditCycleEndDateDialog({ open, onOpenChange, cyclusId, cyclusName, onSaved }: Props) {
  const { t } = useTranslation('cycles');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [originalEnd, setOriginalEnd] = useState<string | null>(null);
  const [endDate, setEndDate] = useState('');
  const [outOfRange, setOutOfRange] = useState<OutOfRangeSlots | null>(null);
  const [checking, setChecking] = useState(false);
  const [removeUnbooked, setRemoveUnbooked] = useState(false);

  // Load the cyclus's current dates when the dialog opens.
  useEffect(() => {
    if (!open || !cyclusId) return;
    let cancelled = false;
    setLoading(true);
    setOutOfRange(null);
    setRemoveUnbooked(false);
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

  const invalid = Boolean(endDate && startDate && endDate < startDate);
  // Preview out-of-range sessions whenever the end date is brought in (or a cycle that had
  // no end date gets one) — both cases can leave sessions past the new end.
  const shortened = Boolean(endDate && !invalid && (originalEnd ? endDate < originalEnd : true));

  // When the end date is shortened, preview the now-out-of-range sessions.
  useEffect(() => {
    if (!open || !cyclusId || !endDate || invalid || !shortened) { setOutOfRange(null); return; }
    let cancelled = false;
    setChecking(true);
    findSlotsAfterDate(cyclusId, endDate)
      .then((r) => { if (!cancelled) setOutOfRange(r); })
      .catch(() => { if (!cancelled) setOutOfRange(null); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [open, cyclusId, endDate, invalid, shortened]);

  const removableCount = outOfRange?.removableIds.length ?? 0;
  const protectedCount = outOfRange?.protectedCount ?? 0;
  const totalOutOfRange = removableCount + protectedCount;

  const handleSave = async () => {
    if (!cyclusId || !endDate || invalid) return;
    setSaving(true);
    try {
      await updateCycle(cyclusId, { end_date: endDate });
      let removed = 0;
      if (removeUnbooked && removableCount > 0 && outOfRange) {
        removed = await deleteUnbookedSlots(outOfRange.removableIds);
      }
      toast.success(
        removed > 0
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
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="cycle-end-date">{t('editEndDate.label', 'Nieuwe einddatum')}</Label>
              <Input
                id="cycle-end-date"
                type="date"
                value={endDate}
                min={startDate ?? undefined}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">
                {t('editEndDate.hint', 'Dit verandert alleen de einddatum van de cyclus. Facturen blijven ongewijzigd.')}
              </p>
              {invalid && (
                <p className="text-xs text-rose-600">{t('editEndDate.invalid', 'De einddatum moet op of na de startdatum liggen.')}</p>
              )}
            </div>

            {shortened && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm">
                {checking ? (
                  <span className="text-muted-foreground inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> {t('editEndDate.checking', 'Sessies controleren…')}
                  </span>
                ) : totalOutOfRange === 0 ? (
                  <span className="text-muted-foreground">{t('editEndDate.noneAfter', 'Geen sessies na deze datum.')}</span>
                ) : (
                  <div className="space-y-2">
                    <p className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
                      <span>
                        {t('editEndDate.afterCount', '{{count}} sessies vallen na de nieuwe einddatum.', { count: totalOutOfRange })}
                        {protectedCount > 0 && ' ' + t('editEndDate.protected', '{{count}} hiervan hebben boekingen en blijven behouden.', { count: protectedCount })}
                      </span>
                    </p>
                    {removableCount > 0 && (
                      <label className="flex items-center gap-2 cursor-pointer">
                        <Checkbox checked={removeUnbooked} onCheckedChange={(v) => setRemoveUnbooked(!!v)} disabled={saving} />
                        <span>{t('editEndDate.removeUnbooked', 'Verwijder de {{count}} lege sessies (zonder boekingen)', { count: removableCount })}</span>
                      </label>
                    )}
                  </div>
                )}
              </div>
            )}
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
