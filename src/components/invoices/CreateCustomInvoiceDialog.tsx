import { useState, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { format, addDays } from 'date-fns';
import { formatCurrency } from '@/lib/format';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { allocateInvoiceNumber, isInvoiceNumberCollision } from '@/lib/invoiceNumber';
import { invoiceRecipientKey, resolveOrCreateAcademyInvoiceGuest } from '@/lib/invoiceCustomerInsert';
import {
  clearCreationAttempt,
  creationRequestIdFor,
  type CreationAttempt,
} from '@/lib/creationRequestId';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  vat_rate: number;
}

interface CreateCustomInvoiceDialogProps {
  open: boolean;
  onClose: () => void;
  academyProfileId: string;
  onCreated: () => void;
}

export function CreateCustomInvoiceDialog({ open, onClose, academyProfileId, onCreated }: CreateCustomInvoiceDialogProps) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();

  const [playerName, setPlayerName] = useState('');
  const [playerBusinessName, setPlayerBusinessName] = useState('');
  const [playerStreet, setPlayerStreet] = useState('');
  const [playerZipCode, setPlayerZipCode] = useState('');
  const [playerCity, setPlayerCity] = useState('');
  const [playerBtwNumber, setPlayerBtwNumber] = useState('');
  const [playerEmail, setPlayerEmail] = useState('');
  /** The create attempt for the typed recipient, so a retried save does not make a second Player. */
  const recipientAttemptRef = useRef<CreationAttempt>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { description: '', quantity: 1, unit_price: 0, amount: 0, vat_rate: 21 },
  ]);
  const [dueDate, setDueDate] = useState<Date>(addDays(new Date(), 14));
  const [notes, setNotes] = useState('');
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setPlayerName('');
    setPlayerBusinessName('');
    setPlayerStreet('');
    setPlayerZipCode('');
    setPlayerCity('');
    setPlayerBtwNumber('');
    setPlayerEmail('');
    setLineItems([{ description: '', quantity: 1, unit_price: 0, amount: 0, vat_rate: 21 }]);
    setDueDate(addDays(new Date(), 14));
    setNotes('');
    setPricesIncludeVat(true);
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
    if (!playerName.trim()) {
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

      // Always create a Player so every invoice recipient appears in the academy players list —
      // even without an email. It is a NEW Player: a recipient typed by hand is not matched against
      // the existing ones by name or address (U2), and a create that looks like an existing Player
      // files a proposal for a human instead of billing them.
      const guestPlayerId = await resolveOrCreateAcademyInvoiceGuest(
        playerName,
        playerEmail,
        academyProfileId,
        creationRequestIdFor(
          recipientAttemptRef,
          invoiceRecipientKey({ playerName, playerEmail, scope: 'academy', ownerId: academyProfileId }),
        ),
      );
      if (!guestPlayerId) {
        logger.error('Guest player resolve/create failed for invoice', undefined, { playerName });
      }

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
            player_name: playerName.trim(),
            player_business_name: playerBusinessName.trim() || null,
            player_address: [playerStreet.trim(), playerZipCode.trim(), playerCity.trim()].filter(Boolean).join('\n') || null,
            player_btw_number: playerBtwNumber.trim() || null,
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
      invalidateAllPlayerData(queryClient, { kind: 'academy', id: academyProfileId });
      resetForm();
      onCreated();
      onClose();
    } catch (err) {
      logger.error('Failed to create invoice:', err);
      toast.error(t('invoiceForm.create.createError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('invoiceForm.create.title')}</DialogTitle>
          <DialogDescription>{t('invoiceForm.create.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
          {/* Receiver details */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">{t('invoiceForm.receiver.title')}</Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.nameRequired')}</Label>
                <Input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder={t('invoiceForm.receiver.namePlaceholder')} />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.businessName')}</Label>
                <Input value={playerBusinessName} onChange={(e) => setPlayerBusinessName(e.target.value)} placeholder={t('invoiceForm.receiver.businessNamePlaceholder')} />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.btwNumber')}</Label>
                <Input value={playerBtwNumber} onChange={(e) => setPlayerBtwNumber(e.target.value)} placeholder={t('invoiceForm.receiver.btwNumberPlaceholder')} />
              </div>
              <div className="col-span-2">
                <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.street')}</Label>
                <Input value={playerStreet} onChange={(e) => setPlayerStreet(e.target.value)} placeholder={t('invoiceForm.receiver.streetPlaceholder')} />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.zipCode')}</Label>
                <Input value={playerZipCode} onChange={(e) => setPlayerZipCode(e.target.value)} placeholder={t('invoiceForm.receiver.zipCodePlaceholder')} />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.city')}</Label>
                <Input value={playerCity} onChange={(e) => setPlayerCity(e.target.value)} placeholder={t('invoiceForm.receiver.cityPlaceholder')} />
              </div>
              <div className="col-span-2">
                <Label className="text-xs text-muted-foreground">{t('invoiceForm.receiver.email')}</Label>
                <Input type="email" value={playerEmail} onChange={(e) => setPlayerEmail(e.target.value)} placeholder={t('invoiceForm.receiver.emailPlaceholder')} />
              </div>
            </div>
          </div>

          {/* Prices include VAT toggle */}
          <div className="flex items-center justify-between">
            <Label className="text-sm">{t('invoiceForm.totals.pricesIncludeVat')}</Label>
            <Switch checked={pricesIncludeVat} onCheckedChange={setPricesIncludeVat} />
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">{t('invoiceForm.lineItems.title')}</Label>
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
            <div className="space-y-2">
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
                  <Input
                    value={li.description}
                    onChange={(e) => updateLineItem(i, 'description', e.target.value)}
                    placeholder={t('invoiceForm.lineItems.descriptionPlaceholder')}
                    className="text-sm"
                  />
                  <Input
                    type="number"
                    value={li.quantity === 0 ? '' : li.quantity}
                    onChange={(e) => updateLineItem(i, 'quantity', e.target.value)}
                    onBlur={() => {
                      if (!li.quantity || li.quantity < 1) {
                        updateLineItem(i, 'quantity', 1);
                      }
                    }}
                    placeholder={t('invoiceForm.lineItems.quantity')}
                    className="text-sm"
                    min={1}
                  />
                  <Input
                    type="number"
                    value={li.unit_price || ''}
                    onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)}
                    placeholder={t('invoiceForm.lineItems.price')}
                    className="text-sm"
                    step="0.01"
                    min={0}
                  />
                  <div className="relative">
                    <Input
                      type="number"
                      value={li.vat_rate || ''}
                      onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)}
                      className="text-sm pr-5"
                      min={0}
                      max={100}
                      step={1}
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <div className="text-right text-sm font-medium py-2">
                    {formatCurrency(li.quantity * li.unit_price)}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => removeLineItem(i)}
                    disabled={lineItems.length <= 1}
                    aria-label={t('invoiceForm.lineItems.removeRow', 'Remove line item')}
                  >
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Totals */}
          <div className="border-t pt-3 space-y-1 text-sm">
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('invoiceForm.actions.cancel')}</Button>
          <Button onClick={handleSave} disabled={saving || !playerName.trim()}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('invoiceForm.create.createButton')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
