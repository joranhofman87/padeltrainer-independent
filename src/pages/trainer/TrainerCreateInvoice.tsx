import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { Loader2, ArrowLeft } from 'lucide-react';
import { format, addDays } from 'date-fns';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { allocateInvoiceNumber, isInvoiceNumberCollision } from '@/lib/invoiceNumber';
import type { Json } from '@/integrations/supabase/types';
import { invalidateAllPlayerData, playerKeys } from '@/lib/playerQueryKeys';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import { InvoiceCustomerSection } from '@/components/invoices/InvoiceCustomerSection';
import { InvoiceLineItemsEditor } from '@/components/invoices/InvoiceLineItemsEditor';
import { InvoiceTotalsSummary } from '@/components/invoices/InvoiceTotalsSummary';
import { computeCreateInvoiceTotals, type InvoiceFormLineItem } from '@/lib/invoiceFormTotals';
import {
  billingToReceiverFields,
  parseInvoicePlayerIdParam,
  type InvoicePlayerLink,
  type InvoiceReceiverFormFields,
} from '@/lib/invoiceCustomer';
import {
  buildInvoicePlayerAddress,
  createDraftInvoiceForPerson,
  invoiceRecipientKey,
  resolveInvoicePersonId,
} from '@/lib/invoiceCustomerInsert';
import {
  clearCreationAttempt,
  creationRequestIdFor,
  type CreationAttempt,
} from '@/lib/creationRequestId';
import {
  fetchInvoicePlayerForPrefill,
  searchInvoiceSelectablePlayers,
} from '@/lib/invoiceSelectablePlayers';
const emptyReceiver = (): InvoiceReceiverFormFields => ({
  playerName: '',
  playerBusinessName: '',
  playerStreet: '',
  playerZipCode: '',
  playerCity: '',
  playerBtwNumber: '',
  playerEmail: '',
});

export default function TrainerCreateInvoice() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [receiver, setReceiver] = useState<InvoiceReceiverFormFields>(emptyReceiver);
  /** The create attempt for the typed recipient, so a retried save does not make a second Player. */
  const recipientAttemptRef = useRef<CreationAttempt>(null);
  const [playerLink, setPlayerLink] = useState<InvoicePlayerLink>({
    profileId: null,
    guestPlayerId: null,
    personId: null,
    linkedDisplayName: null,
  });
  const [oneTimeMode, setOneTimeMode] = useState(false);
  const [prefilledFromProfile, setPrefilledFromProfile] = useState(false);
  const [lineItems, setLineItems] = useState<InvoiceFormLineItem[]>([
    { description: '', quantity: 1, unit_price: 0, amount: 0, vat_rate: 21 },
  ]);
  const [dueDate, setDueDate] = useState<Date>(addDays(new Date(), 14));
  const [notes, setNotes] = useState('');
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [saving, setSaving] = useState(false);

  const { data: trainerProfile } = useQuery({
    queryKey: ["trainer-profile-for-invoice", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, invoice_prefix, invoice_next_number, invoice_include_year, default_vat_rate, payment_terms_days")
        .eq("user_id", user.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  const trainerId = trainerProfile?.id;

  const [playerSearch, setPlayerSearch] = useState('');
  const debouncedPlayerSearch = useDebouncedValue(playerSearch);

  const { data: selectablePlayers = [], isLoading: playersLoading } = useQuery({
    queryKey: playerKeys.picker('trainer', trainerId, debouncedPlayerSearch),
    queryFn: () =>
      searchInvoiceSelectablePlayers({ kind: 'trainer', id: trainerId! }, debouncedPlayerSearch),
    enabled: !!trainerId,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    const parsed = parseInvoicePlayerIdParam(searchParams.get('playerId'));
    if (!parsed || !trainerId) return;

    let cancelled = false;
    void (async () => {
      const player = await fetchInvoicePlayerForPrefill(parsed, {
        kind: 'trainer',
        trainerId,
      });
      if (cancelled || !player) return;
      setPlayerLink({
        profileId: player.profileId,
        guestPlayerId: player.guestPlayerId,
        personId: player.personId,
        linkedDisplayName: player.full_name,
      });
      setReceiver(billingToReceiverFields(player));
      setOneTimeMode(false);
      setPrefilledFromProfile(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, trainerId]);

  const patchReceiver = (patch: Partial<InvoiceReceiverFormFields>) => {
    setReceiver((prev) => ({ ...prev, ...patch }));
  };

  const totals = useMemo(
    () => computeCreateInvoiceTotals(lineItems, pricesIncludeVat),
    [lineItems, pricesIncludeVat],
  );
  const { subtotal, vatAmount, total, vatBreakdown } = totals;

  // U-09: warn on tab close/refresh while there is unsaved typed input.
  // Receiver fields are ignored when prefilled from a profile (no typing lost).
  const hasUnsavedInput =
    lineItems.some(li => li.description.trim() !== '' || li.unit_price !== 0) ||
    notes.trim() !== '' ||
    (!prefilledFromProfile && Object.values(receiver).some(v => v.trim() !== ''));
  useUnsavedChangesGuard(hasUnsavedInput);

  const handleSave = async () => {
    if (!trainerId) return;
    if (!receiver.playerName.trim()) { toast.error(t('invoiceForm.receiver.nameRequiredError')); return; }
    if (lineItems.length === 0 || lineItems.every(li => !li.description.trim())) { toast.error(t('invoiceForm.lineItems.minimumOneItemError')); return; }

    setSaving(true);
    try {
      const prefix = trainerProfile?.invoice_prefix ?? '';
      const includeYear = (trainerProfile as any)?.invoice_include_year ?? true;

      const effectiveLink = oneTimeMode
        ? { profileId: null, guestPlayerId: null, personId: null, linkedDisplayName: null }
        : playerLink;

      const personId = await resolveInvoicePersonId({
        playerLink: effectiveLink,
        oneTimeMode,
        receiver,
        scope: 'trainer',
        trainerId,
        // One id for this save ATTEMPT: a retry with the same recipient replays into the same
        // Player, while editing the recipient is honestly a different attempt (U2).
        creationRequestId: creationRequestIdFor(
          recipientAttemptRef,
          invoiceRecipientKey({
            playerName: receiver.playerName,
            playerEmail: receiver.playerEmail,
            scope: 'trainer',
            ownerId: trainerId,
          }),
        ),
      });

      const primaryVatRate = lineItems[0]?.vat_rate ?? 21;
      const updatedItems = lineItems.map(li => ({ ...li, amount: Math.round(li.quantity * li.unit_price * 100) / 100 }));

      // M-10: allocate the number atomically via the DB (no read-increment-write),
      // and retry on the rare collision with a concurrent creator. The INSERT itself happens
      // server-side in `invoice_create_for_person`, which derives the legacy link columns from the
      // person — no legacy id passes through here (U2, owner correction 2026-08-09).
      let invoiceNumber = '';
      for (let attempt = 0; ; attempt++) {
        const allocation = await allocateInvoiceNumber({
          profileType: 'trainer',
          profileId: trainerId,
          prefix,
          includeYear,
        });
        invoiceNumber = allocation.invoiceNumber;

        try {
          await createDraftInvoiceForPerson({
            scope: 'trainer',
            ownerId: trainerId,
            personId,
            invoiceNumber,
            invoiceDate: format(new Date(), 'yyyy-MM-dd'),
            dueDate: format(dueDate, 'yyyy-MM-dd'),
            playerName: receiver.playerName.trim(),
            playerBusinessName: receiver.playerBusinessName.trim() || null,
            playerAddress: buildInvoicePlayerAddress(receiver),
            playerBtwNumber: receiver.playerBtwNumber.trim() || null,
            lineItems: updatedItems as unknown as Json,
            subtotal,
            vatRate: primaryVatRate,
            vatAmount,
            vatBreakdown: (vatBreakdown || null) as Json | null,
            total,
            pricesIncludeVat,
            notes: notes.trim() || null,
          });
          break;
        } catch (insertError) {
          if (!isInvoiceNumberCollision(insertError) || attempt >= 2) throw insertError;
        }
      }

      // the attempt is finished: the next invoice is a new one, not a retry of this
      clearCreationAttempt(recipientAttemptRef);
      toast.success(t('invoiceForm.create.createdToast', { number: invoiceNumber }));
      queryClient.invalidateQueries({ queryKey: ['trainer-invoices'] });
      invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerId });
      navigate('/app/trainer/invoices');
    } catch (err) {
      logger.error('Failed to create invoice:', err);
      toast.error(t('invoiceForm.create.createError'));
    } finally {
      setSaving(false);
    }
  };

  if (!trainerId) return null;

  return (
    <div className="container mx-auto px-4 py-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate('/app/trainer/invoices')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{t('invoiceForm.create.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('invoiceForm.create.description')}</p>
        </div>
      </div>

      <InvoiceCustomerSection
        players={selectablePlayers}
        playersLoading={playersLoading}
        playerLink={playerLink}
        onPlayerLinkChange={setPlayerLink}
        receiver={receiver}
        onReceiverChange={patchReceiver}
        hidePlayerSearch={prefilledFromProfile}
        oneTimeMode={oneTimeMode}
        onOneTimeModeChange={setOneTimeMode}
        searchValue={playerSearch}
        onSearchValueChange={setPlayerSearch}
      />

      {/* Line items */}
      <InvoiceLineItemsEditor
        lineItems={lineItems}
        onChange={setLineItems}
        newRowVatRate={21}
        labels={{
          title: t('invoiceForm.lineItems.title'),
          description: t('invoiceForm.lineItems.description'),
          descriptionPlaceholder: t('invoiceForm.lineItems.descriptionPlaceholder'),
          quantity: t('invoiceForm.lineItems.quantity'),
          price: t('invoiceForm.lineItems.price'),
          vatPercent: t('invoiceForm.lineItems.vatPercent'),
          total: t('invoiceForm.lineItems.total'),
          addRow: t('invoiceForm.lineItems.addRow'),
          removeRow: t('invoiceForm.lineItems.removeRow', 'Remove row'),
          formatMobileTotal: (amount) => t('invoiceForm.lineItems.totalLabel', { amount }),
        }}
        presetPicker={(addPreset) => (
          <ExtraCostPresetPicker trainerId={trainerId} onSelect={addPreset} />
        )}
      />

      {/* Totals */}
      <Card className={flushOnMobileCardClass()}>
        <CardContent className="pt-6 space-y-4">
          <InvoiceTotalsSummary
            totals={totals}
            pricesIncludeVat={pricesIncludeVat}
            onPricesIncludeVatChange={setPricesIncludeVat}
            labels={{
              pricesIncludeVat: t('invoiceForm.totals.pricesIncludeVat'),
              subtotal: t('invoiceForm.totals.subtotal'),
              total: t('invoiceForm.totals.total'),
            }}
            renderVatRateLabel={(rate) => t('invoiceForm.totals.vatLabel', { rate })}
            singleRate={{ label: t('invoiceForm.totals.vatLabel', { rate: lineItems[0]?.vat_rate ?? 21 }) }}
          />
          <Separator />
          <div className="flex items-center gap-4">
            <Label className="text-sm whitespace-nowrap">{t('invoiceForm.dueDate.label')}</Label>
            <DatePickerPopover
              value={dueDate}
              onChange={(d) => d && setDueDate(d)}
              size="sm"
            />
          </div>
          <div><Label className="text-sm mb-1 block">{t('invoiceForm.notes.label')}</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('invoiceForm.notes.placeholder')} rows={2} /></div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => navigate('/app/trainer/invoices')} disabled={saving}>{t('invoiceForm.actions.cancel')}</Button>
        <Button onClick={handleSave} disabled={saving || !receiver.playerName.trim()}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {t('invoiceForm.create.createButton')}
        </Button>
      </div>
    </div>
  );
}
