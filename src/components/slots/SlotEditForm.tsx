import { useState, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { Loader2, Save, X, DollarSign, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DateInputField } from '@/components/ui/date-input-field';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SlotRatingPicker } from '@/components/slots/SlotRatingPicker';
import { ExtraCostsEditor, type ExtraCost } from '@/components/slots/ExtraCostsEditor';

/** The slot fields the form reads to initialise itself (a subset of the role pages' slot detail). */
export interface SlotEditFormSlot {
  start_time: string;
  end_time: string;
  trainer_id: string;
  location_id: string | null;
  max_participants: number;
  rating_system: string | null;
  min_rating: number | null;
  max_rating: number | null;
  cyclus_id: string | null;
  cyclus_name: string | null;
  is_public: boolean;
  price_per_session: number | null;
  total_price: number | null;
  split_payment: boolean;
  prices_include_vat: boolean;
  extra_costs: ExtraCost[] | null;
}

/** The raw field values the form emits on save. The CALLER owns the write (time parsing, the
 *  apply-to-cyclus relative shift, invoice sync) — these are exactly the `edit*` values the role
 *  pages' handleSave already reads, so adoption is a 1:1 swap. */
export interface SlotEditFormValues {
  date: string; // yyyy-MM-dd
  startTime: string; // HH:mm
  duration: number; // minutes
  trainerId: string;
  locationId: string; // 'none' or a location id
  maxParticipants: number;
  ratingSystem: string | null;
  minRating: number | null;
  maxRating: number | null;
  cyclusName: string;
  isMarkedFull: boolean; // = !is_public
  pricePerSession: string; // raw <input> string
  totalPrice: string;
  splitPayment: boolean;
  pricesIncludeVat: boolean;
  extraCosts: ExtraCost[];
}

interface SlotEditFormProps {
  slot: SlotEditFormSlot;
  /**
   * The role's own i18n namespace ('academy' | 'trainer'). The shared "calendar-operation" keys
   * (duration / trainer / location / maxParticipants / price / cyclusName / applyToCyclus) live ONLY
   * in trainer.json, so they always read from the 'trainer' namespace — this reproduces each page's
   * exact current wording (academy reads those via tTrainer today; trainer reads everything via t).
   */
  namespace: string;
  /** Academy passes the trainer list → shows the trainer select. Trainer omits it (always self). */
  trainers?: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  /** Locks the rating system in the picker to the owner's configured system. */
  fixedRatingSystem?: string | null;
  /** Academy: open cycle pricing for a cycle slot. Omit → the callout shows static text only. */
  onEditCyclePricing?: () => void;
  cyclePricingLoading?: boolean;
  isSaving?: boolean;
  /**
   * Hide the price-related fields (per-session + total price, the cycle-pricing callout, VAT / split
   * toggles, extra-costs editor). Used by the consolidated cycle editor, which renders EDITABLE cycle
   * pricing in `extraSections` instead (price for a cycle is a cycle-level concern). Default false →
   * the slot-detail pages are unchanged.
   */
  hidePricing?: boolean;
  /** Extra content rendered just before the Save/Cancel footer (e.g. the cycle price + looptijd sections). */
  extraSections?: ReactNode;
  onSubmit: (values: SlotEditFormValues, applyToCyclus: boolean) => void;
  onCancel: () => void;
}

/**
 * Shared, role-neutral slot-edit form (Phase 4 F3b) — the inline editor extracted verbatim from
 * AcademySlotDetail + TrainerSlotDetail, which had diverged. Owns the field state + initialises from
 * the slot (the pages' old startEditing). Composes the already-shared ExtraCostsEditor + SlotRatingPicker.
 * Price fields are disabled for a cycle slot (price is managed at the cycle level via updateCyclePricing).
 *
 * Presentation only: it emits raw values via onSubmit; the caller keeps the write. Init runs once on
 * mount — render it under `key={slot.id}` so switching/re-opening a slot re-initialises (matches the
 * pages, which only mount the form when entering edit mode).
 */
export function SlotEditForm({
  slot,
  namespace,
  trainers,
  locations,
  fixedRatingSystem,
  onEditCyclePricing,
  cyclePricingLoading = false,
  isSaving = false,
  hidePricing = false,
  extraSections,
  onSubmit,
  onCancel,
}: SlotEditFormProps) {
  const { t: tRole } = useTranslation(namespace);
  const { t: tCal } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');

  const isCycleSlot = !!slot.cyclus_id;

  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [duration, setDuration] = useState(60);
  const [trainerId, setTrainerId] = useState('');
  const [locationId, setLocationId] = useState('none');
  const [maxParticipants, setMaxParticipants] = useState(4);
  const [ratingSystem, setRatingSystem] = useState<string | null>(null);
  const [minRating, setMinRating] = useState<number | null>(null);
  const [maxRating, setMaxRating] = useState<number | null>(null);
  const [cyclusName, setCyclusName] = useState('');
  const [pricePerSession, setPricePerSession] = useState('');
  const [totalPrice, setTotalPrice] = useState('');
  const [splitPayment, setSplitPayment] = useState(false);
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [extraCosts, setExtraCosts] = useState<ExtraCost[]>([]);
  const [isMarkedFull, setIsMarkedFull] = useState(false);
  const [applyToCyclus, setApplyToCyclus] = useState(false);

  // Initialise the fields from the slot (verbatim from the pages' startEditing). Runs once on mount;
  // callers pass key={slot.id} so a different/re-opened slot remounts and re-initialises.
  useEffect(() => {
    const start = new Date(slot.start_time);
    const end = new Date(slot.end_time);
    setDate(format(start, 'yyyy-MM-dd'));
    setStartTime(format(start, 'HH:mm'));
    setDuration(Math.round((end.getTime() - start.getTime()) / 60000));
    setTrainerId(slot.trainer_id);
    setLocationId(slot.location_id || 'none');
    setMaxParticipants(slot.max_participants);
    setRatingSystem(slot.rating_system);
    setMinRating(slot.min_rating);
    setMaxRating(slot.max_rating);
    setCyclusName(slot.cyclus_name || '');
    setPricePerSession(slot.price_per_session != null ? String(slot.price_per_session) : '');
    setTotalPrice(slot.total_price != null ? String(slot.total_price) : '');
    setSplitPayment(slot.split_payment);
    setPricesIncludeVat(slot.prices_include_vat);
    setExtraCosts(slot.extra_costs ? [...slot.extra_costs] : []);
    setIsMarkedFull(!slot.is_public);
    setApplyToCyclus(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () =>
    onSubmit(
      {
        date,
        startTime,
        duration,
        trainerId,
        locationId,
        maxParticipants,
        ratingSystem,
        minRating,
        maxRating,
        cyclusName,
        isMarkedFull,
        pricePerSession,
        totalPrice,
        splitPayment,
        pricesIncludeVat,
        extraCosts,
      },
      applyToCyclus,
    );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{tRole('calendar.date', 'Date')}</Label>
          <DateInputField value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{tRole('calendar.time', 'Time')}</Label>
          <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{tCal('calendar.duration', 'Duration')}</Label>
        <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[30, 45, 60, 90, 120].map((m) => (
              <SelectItem key={m} value={String(m)}>
                {tRole('calendar.durationMinutes', '{{minutes}} min', { minutes: m })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {trainers && trainers.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs">{tCal('calendar.trainer', 'Trainer')}</Label>
          <Select value={trainerId} onValueChange={setTrainerId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {trainers.map((tr) => (
                <SelectItem key={tr.id} value={tr.id}>
                  {tr.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {locations.length > 0 && (
        <div className="space-y-1.5">
          <Label className="text-xs">{tCal('calendar.location', 'Location')}</Label>
          <Select value={locationId} onValueChange={setLocationId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{tCal('calendar.noLocation', 'No location')}</SelectItem>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className={hidePricing ? 'space-y-1.5' : 'grid grid-cols-1 sm:grid-cols-2 gap-3'}>
        <div className="space-y-1.5">
          <Label className="text-xs">{tCal('calendar.maxParticipants', 'Max participants')}</Label>
          <Input
            type="number"
            min={1}
            max={20}
            value={maxParticipants}
            onChange={(e) => setMaxParticipants(Number(e.target.value))}
          />
        </div>
        {!hidePricing && (
          <div className="space-y-1.5">
            <Label className="text-xs">{tCal('calendar.price', 'Price')}</Label>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={pricePerSession}
              onChange={(e) => setPricePerSession(e.target.value)}
              placeholder="€"
              disabled={isCycleSlot}
              className={isCycleSlot ? 'opacity-60' : ''}
            />
          </div>
        )}
      </div>

      {!hidePricing && (
        <div className="space-y-1.5">
          <Label className="text-xs">{tRole('calendar.totalPrice', 'Total price (full cyclus)')}</Label>
          <Input
            type="number"
            step="0.01"
            min={0}
            value={totalPrice}
            onChange={(e) => setTotalPrice(e.target.value)}
            placeholder="€"
            disabled={isCycleSlot}
            className={isCycleSlot ? 'opacity-60' : ''}
          />
        </div>
      )}

      {!hidePricing && isCycleSlot && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <DollarSign className="h-3.5 w-3.5 shrink-0" />
          <span>{tRole('calendar.pricingManagedByCycle', 'Pricing is managed at the cycle level.')}</span>
          {onEditCyclePricing && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs ml-auto"
              disabled={cyclePricingLoading}
              onClick={onEditCyclePricing}
            >
              {cyclePricingLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                tRole('calendar.editCyclePricing', 'Edit cycle pricing →')
              )}
            </Button>
          )}
        </div>
      )}

      {!hidePricing && (
        <>
          <Separator />

          <div className="flex items-center justify-between">
            <Label className="text-xs">{tRole('calendar.pricesIncludeVat', 'Prices include VAT')}</Label>
            <Switch checked={pricesIncludeVat} onCheckedChange={setPricesIncludeVat} disabled={isCycleSlot} />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-xs">{tRole('calendar.splitPayment', 'Split payment')}</Label>
              <p className="text-[10px] text-muted-foreground">
                {tRole('calendar.splitPaymentDesc', 'Each player pays individually')}
              </p>
            </div>
            <Switch checked={splitPayment} onCheckedChange={setSplitPayment} disabled={isCycleSlot} />
          </div>
        </>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-muted-foreground" />
          <Label className="text-xs">{tRole('calendar.markPrivate', 'Mark as private')}</Label>
        </div>
        <Switch checked={isMarkedFull} onCheckedChange={setIsMarkedFull} />
      </div>

      {!hidePricing && (
        <>
          <Separator />
          <ExtraCostsEditor value={extraCosts} onChange={setExtraCosts} disabled={isCycleSlot} namespace={namespace} />
        </>
      )}

      <Separator />

      <SlotRatingPicker
        ratingSystem={ratingSystem}
        minRating={minRating}
        maxRating={maxRating}
        onChange={(vals) => {
          setRatingSystem(vals.ratingSystem);
          setMinRating(vals.minRating);
          setMaxRating(vals.maxRating);
        }}
        fixedRatingSystem={fixedRatingSystem}
      />

      {isCycleSlot && (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs">{tCal('calendar.cyclusName', 'Cyclus name')}</Label>
            <Input value={cyclusName} onChange={(e) => setCyclusName(e.target.value)} />
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox id="apply-cyclus" checked={applyToCyclus} onCheckedChange={(c) => setApplyToCyclus(!!c)} />
            <Label htmlFor="apply-cyclus" className="text-xs font-normal cursor-pointer">
              {tCal('calendar.applyToCyclus', 'Apply to all future slots in this cyclus')}
            </Label>
          </div>
        </>
      )}

      {extraSections}

      <div className="flex gap-2 pt-2">
        <Button size="sm" onClick={handleSave} disabled={isSaving} className="gap-1.5">
          {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {tCommon('save', 'Save')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={isSaving} className="gap-1.5">
          <X className="h-3.5 w-3.5" />
          {tCommon('cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  );
}
