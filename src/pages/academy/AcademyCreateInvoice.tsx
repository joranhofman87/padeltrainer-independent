import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, ArrowLeft } from 'lucide-react';
import { format, addDays } from 'date-fns';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { allocateInvoiceNumber, isInvoiceNumberCollision } from '@/lib/invoiceNumber';
import { invalidateAllPlayerData, playerKeys } from '@/lib/playerQueryKeys';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import { InvoiceLineItemsEditor } from '@/components/invoices/InvoiceLineItemsEditor';
import { InvoiceTotalsSummary } from '@/components/invoices/InvoiceTotalsSummary';
import { computeCreateInvoiceTotals, type InvoiceFormLineItem } from '@/lib/invoiceFormTotals';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { useQueryClient } from '@tanstack/react-query';
import { InvoiceCustomerSection } from '@/components/invoices/InvoiceCustomerSection';
import {
  billingToReceiverFields,
  parseInvoicePlayerIdParam,
  type InvoicePlayerLink,
  type InvoiceReceiverFormFields,
} from '@/lib/invoiceCustomer';
import {
  buildInvoicePlayerAddress,
  invoiceRecipientKey,
  resolveInvoiceGuestPlayerId,
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

export default function AcademyCreateInvoice() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const queryClient = useQueryClient();

  const [receiver, setReceiver] = useState<InvoiceReceiverFormFields>(emptyReceiver);
  const [playerLink, setPlayerLink] = useState<InvoicePlayerLink>({
    profileId: null,
    guestPlayerId: null,
    linkedDisplayName: null,
  });
  const [oneTimeMode, setOneTimeMode] = useState(false);
  /** The create attempt for the typed recipient, so a retried save does not make a second Player. */
  const recipientAttemptRef = useRef<CreationAttempt>(null);
  const [prefilledFromProfile, setPrefilledFromProfile] = useState(false);
  const [lineItems, setLineItems] = useState<InvoiceFormLineItem[]>([
    { description: '', quantity: 1, unit_price: 0, amount: 0, vat_rate: 21 },
  ]);
  const [dueDate, setDueDate] = useState<Date>(addDays(new Date(), 14));
  const [notes, setNotes] = useState('');
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [saving, setSaving] = useState(false);

  const academyProfileId = activeAcademy?.id;

  const [playerSearch, setPlayerSearch] = useState('');
  const debouncedPlayerSearch = useDebouncedValue(playerSearch);

  const { data: selectablePlayers = [], isLoading: playersLoading } = useQuery({
    queryKey: playerKeys.picker('academy', academyProfileId, debouncedPlayerSearch),
    queryFn: () =>
      searchInvoiceSelectablePlayers(
        { kind: 'academy', id: academyProfileId! },
        debouncedPlayerSearch,
      ),
    enabled: !!academyProfileId,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    const parsed = parseInvoicePlayerIdParam(searchParams.get('playerId'));
    if (!parsed || !academyProfileId) return;

    let cancelled = false;
    void (async () => {
      const player = await fetchInvoicePlayerForPrefill(parsed, {
        kind: 'academy',
        academyProfileId,
      });
      if (cancelled || !player) return;
      setPlayerLink({
        profileId: player.profileId,
        guestPlayerId: player.guestPlayerId,
        linkedDisplayName: player.full_name,
      });
      setReceiver(billingToReceiverFields(player));
      setOneTimeMode(false);
      setPrefilledFromProfile(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, academyProfileId]);

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
    if (!academyProfileId) return;
    if (!receiver.playerName.trim()) {
      toast.error(t('invoiceForm.receiver.nameRequiredError'));
      return;
    }
    if (lineItems.length === 0 || lineItems.every(li => !li.description.trim())) {
      toast.error(t('invoiceForm.lineItems.minimumOneItemError'));
      return;
    }

    setSaving(true);
    try {
      const { data: academy, error: academyError } = await supabase
        .from('academy_profiles')
        .select('invoice_prefix, invoice_next_number, invoice_include_year, default_vat_rate, payment_terms_days')
        .eq('id', academyProfileId)
        .single();

      if (academyError || !academy) throw new Error('Academy not found');

      const prefix = academy.invoice_prefix ?? '';
      const includeYear = (academy as any).invoice_include_year ?? true;

      const effectiveLink = oneTimeMode
        ? { profileId: null, guestPlayerId: null, linkedDisplayName: null }
        : playerLink;

      const guestPlayerId = await resolveInvoiceGuestPlayerId({
        playerLink: effectiveLink,
        oneTimeMode,
        receiver,
        scope: 'academy',
        academyProfileId,
        // One id for this save ATTEMPT: a retry with the same recipient replays into the same
        // Player, while editing the recipient is honestly a different attempt (U2).
        creationRequestId: creationRequestIdFor(
          recipientAttemptRef,
          invoiceRecipientKey({
            playerName: receiver.playerName,
            playerEmail: receiver.playerEmail,
            scope: 'academy',
            ownerId: academyProfileId,
          }),
        ),
      });

      const primaryVatRate = lineItems[0]?.vat_rate ?? 21;

      const updatedItems = lineItems.map(li => ({
        ...li,
        amount: Math.round(li.quantity * li.unit_price * 100) / 100,
      }));

      // M-10: allocate the number atomically via the DB (no read-increment-write),
      // and retry on the rare collision with a concurrent creator.
      let invoiceNumber = '';
      for (let attempt = 0; ; attempt++) {
        const allocation = await allocateInvoiceNumber({
          profileType: 'academy',
          profileId: academyProfileId,
          prefix,
          includeYear,
        });
        invoiceNumber = allocation.invoiceNumber;

        const { error: insertError } = await supabase
          .from('invoices')
          .insert({
            invoice_number: invoiceNumber,
            invoice_date: format(new Date(), 'yyyy-MM-dd'),
            due_date: format(dueDate, 'yyyy-MM-dd'),
            player_name: receiver.playerName.trim(),
            player_business_name: receiver.playerBusinessName.trim() || null,
            player_address: buildInvoicePlayerAddress(receiver),
            player_btw_number: receiver.playerBtwNumber.trim() || null,
            player_id: oneTimeMode ? null : playerLink.profileId,
            guest_player_id: guestPlayerId,
            academy_profile_id: academyProfileId,
            trainer_id: null,
            line_items: updatedItems,
            subtotal,
            vat_rate: primaryVatRate,
            vat_amount: vatAmount,
            vat_breakdown: vatBreakdown || null,
            total,
            status: 'draft',
            prices_include_vat: pricesIncludeVat,
            notes: notes.trim() || null,
          });

        if (!insertError) break;
        if (!isInvoiceNumberCollision(insertError) || attempt >= 2) throw insertError;
      }

      // the attempt is finished: the next invoice is a new one, not a retry of this
      clearCreationAttempt(recipientAttemptRef);
      toast.success(t('invoiceForm.create.createdToast', { number: invoiceNumber }));
      queryClient.invalidateQueries({ queryKey: ['academy-invoices'] });
      invalidateAllPlayerData(queryClient, { kind: 'academy', id: academyProfileId });
      navigate('/app/academy/invoices');
    } catch (err) {
      logger.error('Failed to create invoice:', err);
      toast.error(t('invoiceForm.create.createError'));
    } finally {
      setSaving(false);
    }
  };

  if (!academyProfileId) return null;

  return (
    <div className="container mx-auto px-4 py-6 max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" aria-label={t('goBack', 'Go back')} onClick={() => navigate('/app/academy/invoices')}>
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
          <ExtraCostPresetPicker academyProfileId={academyProfileId} onSelect={addPreset} />
        )}
      />

      {/* Settings + Totals */}
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

          {/* Due date */}
          <div className="flex items-center gap-4">
            <Label className="text-sm whitespace-nowrap">{t('invoiceForm.dueDate.label')}</Label>
            <DatePickerPopover
              value={dueDate}
              onChange={(d) => d && setDueDate(d)}
              size="sm"
            />
          </div>

          {/* Notes */}
          <div>
            <Label className="text-sm mb-1 block">{t('invoiceForm.notes.label')}</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t('invoiceForm.notes.placeholder')}
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => navigate('/app/academy/invoices')} disabled={saving}>
          {t('invoiceForm.actions.cancel')}
        </Button>
        <Button onClick={handleSave} disabled={saving || !receiver.playerName.trim()}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {t('invoiceForm.create.createButton')}
        </Button>
      </div>
    </div>
  );
}
