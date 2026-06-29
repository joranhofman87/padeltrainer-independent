import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle, CalendarPlus } from 'lucide-react';
import { DateInputField } from '@/components/ui/date-input-field';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { findSlotsAfterDate, type OutOfRangeSlots } from '@/lib/cycles';
import { previewCycleExtension, type CycleExtensionPreview } from '@/lib/cycleExtension';

/** The end-date editing intent the parent reads to drive the save (via `applyCycleEndDate`). */
export interface CycleEndDatePlan {
  endDate: string;
  /** End date is before the start date → save must be blocked. */
  invalid: boolean;
  /** New sessions a later end date would generate (0 when not extending). */
  willAdd: number;
  /** Out-of-range EMPTY sessions a shorter end date could remove (booked ones excluded). */
  removableIds: string[];
  /** Out-of-range sessions kept because they have bookings. */
  protectedCount: number;
  /** Whether the user opted to remove the empty out-of-range sessions. */
  removeUnbooked: boolean;
}

interface Props {
  cyclusId: string | null;
  /** Gate the preview effects so they only run while the host dialog is open. */
  open: boolean;
  /** The cycle's start date (min + validation). */
  startDate: string | null;
  /** The cycle's current end date (the shorten/extend reference). */
  originalEnd: string | null;
  /** Controlled end-date value (yyyy-mm-dd). */
  value: string;
  onChange: (endDate: string) => void;
  /** Reports the current plan up so the parent can validate + apply it on save. */
  onPlanChange: (plan: CycleEndDatePlan) => void;
  disabled?: boolean;
  /** i18n namespace (default 'cycles'). */
  namespace?: string;
}

/**
 * Shared end-date editor BODY: the date input + a "X sessions will be generated" preview when
 * extending and a "remove the Y empty sessions" opt-in when shortening (booked sessions always kept).
 * Presentation + preview effects only — the caller owns the write via `applyCycleEndDate(cyclusId,
 * plan.endDate, { removableIds, removeUnbooked })`. Used by BOTH the standalone EditCycleEndDateDialog
 * (cycles list) and the consolidated cycle editor (CycleDetailView) so the two can't diverge.
 */
export function CycleEndDateFields({
  cyclusId,
  open,
  startDate,
  originalEnd,
  value,
  onChange,
  onPlanChange,
  disabled = false,
  namespace = 'cycles',
}: Props) {
  const { t } = useTranslation(namespace);
  const [outOfRange, setOutOfRange] = useState<OutOfRangeSlots | null>(null);
  const [checking, setChecking] = useState(false);
  const [removeUnbooked, setRemoveUnbooked] = useState(false);
  const [extendPreview, setExtendPreview] = useState<CycleExtensionPreview | null>(null);
  const [previewingExtend, setPreviewingExtend] = useState(false);

  const invalid = Boolean(value && startDate && value < startDate);
  // Shortened when the new end is brought in (or a cycle that had no end date now gets one — both can
  // leave sessions past the new end).
  const shortened = Boolean(value && !invalid && (originalEnd ? value < originalEnd : true));

  // Preview the now-out-of-range sessions when the end date is shortened.
  useEffect(() => {
    if (!open || !cyclusId || !value || invalid || !shortened) {
      setOutOfRange(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    findSlotsAfterDate(cyclusId, value)
      .then((r) => { if (!cancelled) setOutOfRange(r); })
      .catch(() => { if (!cancelled) setOutOfRange(null); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [open, cyclusId, value, invalid, shortened]);

  // Preview how many NEW sessions extending to this date would generate (0 when not extending).
  useEffect(() => {
    if (!open || !cyclusId || !value || invalid) {
      setExtendPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewingExtend(true);
    previewCycleExtension(cyclusId, value)
      .then((p) => { if (!cancelled) setExtendPreview(p); })
      .catch(() => { if (!cancelled) setExtendPreview(null); })
      .finally(() => { if (!cancelled) setPreviewingExtend(false); });
    return () => { cancelled = true; };
  }, [open, cyclusId, value, invalid]);

  const willAdd = extendPreview?.count ?? 0;
  const removableIds = outOfRange?.removableIds ?? [];
  const removableCount = removableIds.length;
  const protectedCount = outOfRange?.protectedCount ?? 0;
  const totalOutOfRange = removableCount + protectedCount;
  const removableKey = removableIds.join(',');

  // Report the plan up whenever any input to it changes (primitive deps → no render loop).
  useEffect(() => {
    onPlanChange({ endDate: value, invalid, willAdd, removableIds, protectedCount, removeUnbooked });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, invalid, willAdd, removableKey, protectedCount, removeUnbooked]);

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="cycle-end-date">{t('editEndDate.label', 'Nieuwe einddatum')}</Label>
        <DateInputField
          id="cycle-end-date"
          value={value}
          min={startDate ?? undefined}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
        <p className="text-xs text-muted-foreground">
          {t('editEndDate.hintV2', 'Een latere datum maakt extra wekelijkse sessies aan; een eerdere datum kan lege sessies verwijderen. Facturen blijven ongewijzigd.')}
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
                  <Checkbox checked={removeUnbooked} onCheckedChange={(v) => setRemoveUnbooked(!!v)} disabled={disabled} />
                  <span>{t('editEndDate.removeUnbooked', 'Verwijder de {{count}} lege sessies (zonder boekingen)', { count: removableCount })}</span>
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {!invalid && value && (previewingExtend || willAdd > 0) && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          {previewingExtend ? (
            <span className="text-muted-foreground inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('editEndDate.checking', 'Sessies controleren…')}
            </span>
          ) : (
            <p className="flex items-start gap-2">
              <CalendarPlus className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
              <span>{t('editEndDate.willAdd', 'Er worden {{count}} nieuwe wekelijkse sessies aangemaakt (zelfde dag, tijd, trainer en prijs).', { count: willAdd })}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
