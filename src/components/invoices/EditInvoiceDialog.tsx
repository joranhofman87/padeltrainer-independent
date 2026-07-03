import { useState, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { Loader2, Plus, Trash2, Download, CheckCircle } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { formatCurrency } from '@/lib/format';
import { toast } from 'sonner';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  vat_rate?: number;
}

interface EditInvoiceData {
  id: string;
  line_items: LineItem[];
  vat_rate: number;
  due_date: string;
  notes?: string;
  booking_ids?: string[];
  prices_include_vat?: boolean;
  player_name?: string;
  player_business_name?: string;
  player_address?: string;
  player_btw_number?: string;
}

interface EditInvoiceDialogProps {
  open: boolean;
  onClose: () => void;
  invoice: EditInvoiceData | null;
  onSaved: () => void;
  trainerId?: string | null;
  academyProfileId?: string | null;
  onDownloadPdf?: () => void;
  onMarkPaid?: () => void;
  onDelete?: () => void;
  invoiceStatus?: string;
}

function parseAddress(address?: string | null): { street: string; zipCode: string; city: string } {
  if (!address) return { street: '', zipCode: '', city: '' };
  const parts = address.split('\n');
  return {
    street: parts[0] || '',
    zipCode: parts[1] || '',
    city: parts[2] || '',
  };
}

export function EditInvoiceDialog({ open, onClose, invoice, onSaved, trainerId, academyProfileId, onDownloadPdf, onMarkPaid, onDelete, invoiceStatus }: EditInvoiceDialogProps) {
  const { t } = useTranslation('common');
  const queryClient = useQueryClient();

  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [vatRate, setVatRate] = useState(21);
  const [dueDate, setDueDate] = useState<Date | undefined>();
  const [notes, setNotes] = useState('');
  const [syncToBookings, setSyncToBookings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Receiver details
  const [playerName, setPlayerName] = useState('');
  const [playerBusinessName, setPlayerBusinessName] = useState('');
  const [playerStreet, setPlayerStreet] = useState('');
  const [playerZipCode, setPlayerZipCode] = useState('');
  const [playerCity, setPlayerCity] = useState('');
  const [playerBtwNumber, setPlayerBtwNumber] = useState('');

  useEffect(() => {
    if (invoice) {
      setLineItems((invoice.line_items || []).map((li: LineItem) => ({ ...li })));
      setVatRate(invoice.vat_rate ?? 21);
      setDueDate(invoice.due_date ? parseISO(invoice.due_date) : undefined);
      setNotes((invoice as any).notes || '');
      setSyncToBookings(false);
      setPricesIncludeVat(invoice.prices_include_vat ?? true);

      setPlayerName(invoice.player_name || '');
      setPlayerBusinessName(invoice.player_business_name || '');
      const addr = parseAddress(invoice.player_address);
      setPlayerStreet(addr.street);
      setPlayerZipCode(addr.zipCode);
      setPlayerCity(addr.city);
      setPlayerBtwNumber(invoice.player_btw_number || '');
    }
  }, [invoice]);

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
    const hasPerItemVat = lineItems.some(li => li.vat_rate !== undefined && li.vat_rate !== vatRate);
    
    if (hasPerItemVat) {
      let totalSub = 0;
      let totalVatAmt = 0;
      const breakdown: Record<number, { subtotal: number; vat: number }> = {};

      for (const li of lineItems) {
        const lineTotal = li.quantity * li.unit_price;
        const lineVatRate = li.vat_rate ?? vatRate;
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

      return { subtotal: sub, vatAmount: vat, total: tot, vatBreakdown: breakdown };
    }

    const lineTotal = lineItems.reduce((sum, li) => sum + (li.quantity * li.unit_price), 0);
    if (pricesIncludeVat) {
      const tot = Math.round(lineTotal * 100) / 100;
      const sub = Math.round((tot / (1 + vatRate / 100)) * 100) / 100;
      return { subtotal: sub, vatAmount: Math.round((tot - sub) * 100) / 100, total: tot, vatBreakdown: null };
    } else {
      const sub = Math.round(lineTotal * 100) / 100;
      const vat = Math.round(sub * (vatRate / 100) * 100) / 100;
      return { subtotal: sub, vatAmount: vat, total: Math.round((sub + vat) * 100) / 100, vatBreakdown: null };
    }
  }, [lineItems, vatRate, pricesIncludeVat]);

  const originalPrices = useMemo(() => {
    if (!invoice?.line_items) return {};
    const map: Record<number, number> = {};
    invoice.line_items.forEach((li: LineItem, i: number) => { map[i] = li.unit_price; });
    return map;
  }, [invoice]);

  const hasPriceChanges = lineItems.some((li, i) => li.unit_price !== (originalPrices[i] ?? li.unit_price));
  const hasBookings = (invoice?.booking_ids?.length ?? 0) > 0;

  const handleSave = async () => {
    if (!invoice) return;
    setSaving(true);

    try {
      const updatedItems = lineItems.map(li => ({
        ...li,
        amount: Math.round(li.quantity * li.unit_price * 100) / 100,
      }));

      const playerAddress = [playerStreet.trim(), playerZipCode.trim(), playerCity.trim()]
        .filter(Boolean).join('\n') || null;

      const { error } = await supabase
        .from('invoices')
        .update({
          line_items: updatedItems,
          vat_rate: vatRate,
          due_date: dueDate ? format(dueDate, 'yyyy-MM-dd') : invoice.due_date,
          notes: notes || null,
          subtotal,
          vat_amount: vatAmount,
          total,
          vat_breakdown: vatBreakdown || null,
          prices_include_vat: pricesIncludeVat,
          player_name: playerName.trim() || null,
          player_business_name: playerBusinessName.trim() || null,
          player_address: playerAddress,
          player_btw_number: playerBtwNumber.trim() || null,
          pdf_url: null, // force regeneration
        })
        .eq('id', invoice.id);

      if (error) throw error;

      if (syncToBookings && hasPriceChanges && hasBookings) {
        const { error: syncError } = await supabase.functions.invoke('sync-invoice-to-bookings', {
          body: { invoiceId: invoice.id },
        });
        if (syncError) {
          logger.error('Sync to bookings failed', syncError instanceof Error ? syncError : new Error(String(syncError)), { component: 'EditInvoiceDialog' });
          toast.error(t('invoiceForm.edit.syncFailed'));
        }
      }

      toast.success(t('invoiceForm.edit.savedToast'));
      if (academyProfileId) {
        invalidateAllPlayerData(queryClient, { kind: 'academy', id: academyProfileId });
      }
      if (trainerId) {
        invalidateAllPlayerData(queryClient, { kind: 'trainer', id: trainerId });
      }
      onSaved();
      onClose();
    } catch (err) {
      logger.error('Failed to update invoice', err instanceof Error ? err : new Error(String(err)), { component: 'EditInvoiceDialog' });
      toast.error(t('invoiceForm.edit.saveError'));
    } finally {
      setSaving(false);
    }
  };

  if (!invoice) return null;

  const isDraft = invoiceStatus === 'draft';

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('invoiceForm.edit.title')}</DialogTitle>
            <DialogDescription>{t('invoiceForm.edit.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            {/* Receiver details */}
            <div>
              <Label className="text-sm font-medium mb-2 block">{t('invoiceForm.receiver.title')}</Label>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder={t('invoiceForm.receiver.name')}
                  className="text-sm"
                />
                <Input
                  value={playerBusinessName}
                  onChange={(e) => setPlayerBusinessName(e.target.value)}
                  placeholder={t('invoiceForm.receiver.businessNameOptional')}
                  className="text-sm"
                />
                <Input
                  value={playerStreet}
                  onChange={(e) => setPlayerStreet(e.target.value)}
                  placeholder={t('invoiceForm.receiver.street')}
                  className="text-sm col-span-2"
                />
                <Input
                  value={playerZipCode}
                  onChange={(e) => setPlayerZipCode(e.target.value)}
                  placeholder={t('invoiceForm.receiver.zipCode')}
                  className="text-sm"
                />
                <Input
                  value={playerCity}
                  onChange={(e) => setPlayerCity(e.target.value)}
                  placeholder={t('invoiceForm.receiver.city')}
                  className="text-sm"
                />
                <Input
                  value={playerBtwNumber}
                  onChange={(e) => setPlayerBtwNumber(e.target.value)}
                  placeholder={t('invoiceForm.receiver.btwNumberOptional')}
                  className="text-sm col-span-2"
                />
              </div>
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-sm font-medium">{t('invoiceForm.lineItems.title')}</Label>
                <div className="flex items-center gap-1">
                  <ExtraCostPresetPicker
                    trainerId={trainerId}
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
                        vat_rate: vatRate,
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
                      onChange={(e) => updateLineItem(i, 'quantity', e.target.value === '' ? 0 : (parseInt(e.target.value) || 0))}
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
                      size="icon" aria-label="Delete"
                      className="h-7 w-7"
                      onClick={() => removeLineItem(i)}
                      disabled={lineItems.length <= 1}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {/* Prices include VAT toggle */}
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t('invoiceForm.totals.pricesIncludeVat')}</Label>
              <Switch checked={pricesIncludeVat} onCheckedChange={setPricesIncludeVat} />
            </div>

            {/* Totals */}
            <div className="border-t pt-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('invoiceForm.totals.subtotal')}</span>
                <span>{formatCurrency(subtotal)}</span>
              </div>
              {vatBreakdown && Object.keys(vatBreakdown).length > 1 ? (
                Object.entries(vatBreakdown)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([rate, data]) => (
                    <div key={rate} className="flex justify-between">
                      <span className="text-muted-foreground">{t('invoiceForm.totals.vatLabel', { rate })}</span>
                      <span>{formatCurrency(data.vat)}</span>
                    </div>
                  ))
              ) : (
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground flex items-center gap-2">
                    {t('invoiceForm.totals.vat')}
                    <Input
                      type="number"
                      value={vatRate}
                      onChange={(e) => setVatRate(Number(e.target.value) || 0)}
                      className="w-16 h-7 text-sm inline"
                      min={0}
                      max={100}
                      step={1}
                    />
                    %
                  </span>
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
                onChange={setDueDate}
                placeholder={t('invoiceForm.dueDate.selectDate')}
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

            {/* Sync checkbox */}
            {hasPriceChanges && hasBookings && (
              <div className="flex items-center space-x-2 bg-muted/50 p-3 rounded-md">
                <Checkbox
                  id="sync-bookings"
                  checked={syncToBookings}
                  onCheckedChange={(v) => setSyncToBookings(v === true)}
                />
                <Label htmlFor="sync-bookings" className="text-sm cursor-pointer">
                  {t('invoiceForm.edit.syncToBookings')}
                </Label>
              </div>
            )}
          </div>

          <DialogFooter className="flex-col sm:flex-row gap-2">
            {/* Management actions on the left */}
            <div className="flex gap-2 mr-auto">
              {onDownloadPdf && (
                <Button type="button" variant="outline" size="sm" onClick={onDownloadPdf}>
                  <Download className="h-4 w-4 mr-2" />
                  {t('invoiceForm.actions.downloadPdf')}
                </Button>
              )}
              {onMarkPaid && (
                <Button type="button" variant="outline" size="sm" onClick={onMarkPaid}>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  {t('invoiceForm.actions.markPaid')}
                </Button>
              )}
              {onDelete && (
                <Button type="button" variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteConfirmOpen(true)}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  {isDraft ? t('invoiceForm.actions.deleteInvoice') : t('invoiceForm.actions.cancelInvoice')}
                </Button>
              )}
            </div>
            {/* Save / Cancel on the right */}
            <Button variant="outline" onClick={onClose} disabled={saving}>{t('invoiceForm.actions.cancel')}</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t('invoiceForm.edit.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isDraft ? t('invoiceForm.deleteDialog.deleteTitle') : t('invoiceForm.deleteDialog.cancelTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {isDraft
                ? t('invoiceForm.deleteDialog.deleteDescription')
                : t('invoiceForm.deleteDialog.cancelDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('invoiceForm.deleteDialog.back')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                onDelete?.();
                setDeleteConfirmOpen(false);
              }}
            >
              {isDraft ? t('invoiceForm.deleteDialog.delete') : t('invoiceForm.deleteDialog.cancelInvoice')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
