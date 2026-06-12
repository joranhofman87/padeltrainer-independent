import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, CalendarIcon, Plus, Trash2, ArrowLeft } from 'lucide-react';
import { format, addDays } from 'date-fns';
import { getDateFnsLocale } from '@/lib/dateFnsLocale';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { formatCurrency } from '@/lib/format';
import { allocateInvoiceNumber, isInvoiceNumberCollision } from '@/lib/invoiceNumber';
import { invalidateAllPlayerData, playerKeys } from '@/lib/playerQueryKeys';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
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
  resolveInvoiceGuestPlayerId,
} from '@/lib/invoiceCustomerInsert';
import {
  fetchInvoicePlayerForPrefill,
  searchInvoiceSelectablePlayers,
} from '@/lib/invoiceSelectablePlayers';

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  vat_rate: number;
}

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
  const { t, i18n } = useTranslation('common');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { activeAcademy } = useAcademyContext();
  const queryClient = useQueryClient();
  const dateFnsLocale = getDateFnsLocale(i18n.language);

  const [receiver, setReceiver] = useState<InvoiceReceiverFormFields>(emptyReceiver);
  const [playerLink, setPlayerLink] = useState<InvoicePlayerLink>({
    profileId: null,
    guestPlayerId: null,
    linkedDisplayName: null,
  });
  const [oneTimeMode, setOneTimeMode] = useState(false);
  const [prefilledFromProfile, setPrefilledFromProfile] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([
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

  const updateLineItem = (index: number, field: keyof LineItem, value: string | number) => {
    setLineItems(prev => {
      const updated = [...prev];
      const item = { ...updated[index] };
      if (field === 'description') {
        item.description = value as string;
      } else if (field === 'quantity') {
        item.quantity = value === '' || value === 0 ? 0 : (parseInt(String(value)) || 0);
      } else if (field === 'unit_price') {
        item.unit_price = Number(value) || 0;
      } else if (field === 'vat_rate') {
        item.vat_rate = Number(value) || 0;
      }
      item.amount = Math.round(item.quantity * item.unit_price * 100) / 100;
      updated[index] = item;
      return updated;
    });
  };

  const removeLineItem = (index: number) => {
    setLineItems(prev => prev.filter((_, i) => i !== index));
  };

  const { subtotal, vatAmount, total, vatBreakdown } = useMemo(() => {
    const hasMultipleRates = new Set(lineItems.map(li => li.vat_rate)).size > 1;

    let totalSub = 0;
    let totalVatAmt = 0;
    const breakdown: Record<number, { subtotal: number; vat: number }> = {};

    for (const li of lineItems) {
      const lineTotal = li.quantity * li.unit_price;
      const lineVatRate = li.vat_rate;
      let lineSub: number;
      let lineVat: number;

      if (pricesIncludeVat) {
        lineSub = lineTotal / (1 + lineVatRate / 100);
        lineVat = lineTotal - lineSub;
      } else {
        lineSub = lineTotal;
        lineVat = lineSub * (lineVatRate / 100);
      }

      totalSub += lineSub;
      totalVatAmt += lineVat;

      if (!breakdown[lineVatRate]) breakdown[lineVatRate] = { subtotal: 0, vat: 0 };
      breakdown[lineVatRate].subtotal += lineSub;
      breakdown[lineVatRate].vat += lineVat;
    }

    for (const rate in breakdown) {
      breakdown[rate].subtotal = Math.round(breakdown[rate].subtotal * 100) / 100;
      breakdown[rate].vat = Math.round(breakdown[rate].vat * 100) / 100;
    }

    const sub = Math.round(totalSub * 100) / 100;
    const vat = Math.round(totalVatAmt * 100) / 100;
    const tot = pricesIncludeVat
      ? Math.round(lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0) * 100) / 100
      : Math.round((sub + vat) * 100) / 100;

    return {
      subtotal: sub,
      vatAmount: vat,
      total: tot,
      vatBreakdown: hasMultipleRates ? breakdown : null,
    };
  }, [lineItems, pricesIncludeVat]);

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
        <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate('/app/academy/invoices')}>
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
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('invoiceForm.lineItems.title')}</CardTitle>
            <div className="flex items-center gap-1">
              <ExtraCostPresetPicker
                academyProfileId={academyProfileId}
                onSelect={(cost) => {
                  setLineItems(prev => [...prev, {
                    description: cost.description,
                    quantity: 1,
                    unit_price: cost.price,
                    amount: cost.price,
                    vat_rate: cost.vat_rate,
                  }]);
                }}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => {
                  setLineItems(prev => [...prev, {
                    description: '',
                    quantity: 1,
                    unit_price: 0,
                    amount: 0,
                    vat_rate: 21,
                  }]);
                }}
              >
                <Plus className="h-3 w-3 mr-1" />
                {t('invoiceForm.lineItems.addRow')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {/* Desktop grid */}
            <div className="hidden md:block space-y-2">
              <div className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center text-xs font-medium text-muted-foreground px-1">
                <span>{t('invoiceForm.lineItems.description')}</span>
                <span>{t('invoiceForm.lineItems.quantity')}</span>
                <span>{t('invoiceForm.lineItems.price')}</span>
                <span>{t('invoiceForm.lineItems.vatPercent')}</span>
                <span>{t('invoiceForm.lineItems.total')}</span>
                <span></span>
              </div>
              {lineItems.map((li, i) => (
                <div key={i} className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center">
                  <Input value={li.description} onChange={(e) => updateLineItem(i, 'description', e.target.value)} placeholder={t('invoiceForm.lineItems.descriptionPlaceholder')} className="text-sm" />
                  <Input type="number" value={li.quantity === 0 ? '' : li.quantity} onChange={(e) => updateLineItem(i, 'quantity', e.target.value)} onBlur={() => { if (!li.quantity || li.quantity < 1) updateLineItem(i, 'quantity', 1); }} className="text-sm" min={1} />
                  <Input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)} className="text-sm" step="0.01" min={0} />
                  <div className="relative">
                    <Input type="number" value={li.vat_rate || ''} onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)} className="text-sm pr-5" min={0} max={100} step={1} />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <div className="text-right text-sm font-medium py-2">{formatCurrency(li.quantity * li.unit_price)}</div>
                  <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={t('invoiceForm.lineItems.removeRow', 'Remove row')} onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1}>
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
            {/* Mobile stacked cards */}
            <div className="md:hidden space-y-3">
              {lineItems.map((li, i) => (
                <div key={i} className="border rounded-lg p-3 space-y-2 bg-muted/30">
                  <div className="flex items-center gap-2">
                    <Input value={li.description} onChange={(e) => updateLineItem(i, 'description', e.target.value)} placeholder={t('invoiceForm.lineItems.descriptionPlaceholder')} className="text-sm flex-1" />
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" aria-label={t('invoiceForm.lineItems.removeRow', 'Remove row')} onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1}>
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">{t('invoiceForm.lineItems.quantity')}</Label>
                      <Input type="number" value={li.quantity === 0 ? '' : li.quantity} onChange={(e) => updateLineItem(i, 'quantity', e.target.value)} onBlur={() => { if (!li.quantity || li.quantity < 1) updateLineItem(i, 'quantity', 1); }} className="text-sm" min={1} />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">{t('invoiceForm.lineItems.price')}</Label>
                      <Input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)} className="text-sm" step="0.01" min={0} />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">{t('invoiceForm.lineItems.vatPercent')}</Label>
                      <div className="relative">
                        <Input type="number" value={li.vat_rate || ''} onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)} className="text-sm pr-5" min={0} max={100} step={1} />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right text-sm font-medium">{t('invoiceForm.lineItems.totalLabel', { amount: formatCurrency(li.quantity * li.unit_price) })}</div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Settings + Totals */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          {/* VAT toggle */}
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('invoiceForm.totals.pricesIncludeVat')}</Label>
            <Switch checked={pricesIncludeVat} onCheckedChange={setPricesIncludeVat} />
          </div>

          <Separator />

          {/* Totals */}
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('invoiceForm.totals.subtotal')}</span>
              <span>{formatCurrency(subtotal)}</span>
            </div>
            {vatBreakdown ? (
              Object.entries(vatBreakdown)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([rate, data]) => (
                  <div key={rate} className="flex justify-between">
                    <span className="text-muted-foreground">{t('invoiceForm.totals.vatLabel', { rate })}</span>
                    <span>{formatCurrency(data.vat)}</span>
                  </div>
                ))
            ) : (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('invoiceForm.totals.vatLabel', { rate: lineItems[0]?.vat_rate ?? 21 })}</span>
                <span>{formatCurrency(vatAmount)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-base border-t pt-2">
              <span>{t('invoiceForm.totals.total')}</span>
              <span>{formatCurrency(total)}</span>
            </div>
          </div>

          <Separator />

          {/* Due date */}
          <div className="flex items-center gap-4">
            <Label className="text-sm whitespace-nowrap">{t('invoiceForm.dueDate.label')}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={cn('justify-start text-left font-normal')}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(dueDate, 'd MMM yyyy', { locale: dateFnsLocale })}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dueDate}
                  onSelect={(d) => d && setDueDate(d)}
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
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
