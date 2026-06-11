import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { Loader2, CalendarIcon, Plus, Trash2, ArrowLeft, Download, CheckCircle } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import { InvoiceRecipientCard } from '@/components/invoices/InvoiceRecipientCard';
import { InvoiceSourceCard } from '@/components/invoices/InvoiceSourceCard';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
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

function parseAddress(address?: string | null): { street: string; zipCode: string; city: string } {
  if (!address) return { street: '', zipCode: '', city: '' };
  const parts = address.split('\n');
  return { street: parts[0] || '', zipCode: parts[1] || '', city: parts[2] || '' };
}

export default function AcademyEditInvoice() {
  const { t: tAcademy, i18n } = useTranslation('academy');
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const { activeAcademy } = useAcademyContext();
  const queryClient = useQueryClient();
  const dateFnsLocale = i18n.language === 'nl' ? nl : enUS;

  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [vatRate, setVatRate] = useState(21);
  const [dueDate, setDueDate] = useState<Date | undefined>();
  const [notes, setNotes] = useState('');
  const [syncToBookings, setSyncToBookings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const [playerName, setPlayerName] = useState('');
  const [playerBusinessName, setPlayerBusinessName] = useState('');
  const [playerStreet, setPlayerStreet] = useState('');
  const [playerZipCode, setPlayerZipCode] = useState('');
  const [playerCity, setPlayerCity] = useState('');
  const [playerBtwNumber, setPlayerBtwNumber] = useState('');

  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoice-detail', invoiceId],
    queryFn: async () => {
      if (!invoiceId) return null;
      const { data, error } = await supabase
        .from('invoices')
        .select('*')
        .eq('id', invoiceId)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!invoiceId,
  });

  useEffect(() => {
    if (invoice) {
      setLineItems(((invoice.line_items as unknown as LineItem[]) || []).map((li: LineItem) => ({ ...li })));
      setVatRate(invoice.vat_rate ?? 21);
      setDueDate(invoice.due_date ? parseISO(invoice.due_date) : undefined);
      setNotes(invoice.notes || '');
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
      const t = pricesIncludeVat
        ? Math.round(lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0) * 100) / 100
        : Math.round((sub + vat) * 100) / 100;

      return { subtotal: sub, vatAmount: vat, total: t, vatBreakdown: breakdown };
    }

    const lineTotal = lineItems.reduce((sum, li) => sum + (li.quantity * li.unit_price), 0);
    if (pricesIncludeVat) {
      const t = Math.round(lineTotal * 100) / 100;
      const sub = Math.round((t / (1 + vatRate / 100)) * 100) / 100;
      return { subtotal: sub, vatAmount: Math.round((t - sub) * 100) / 100, total: t, vatBreakdown: null };
    } else {
      const sub = Math.round(lineTotal * 100) / 100;
      const vat = Math.round(sub * (vatRate / 100) * 100) / 100;
      return { subtotal: sub, vatAmount: vat, total: Math.round((sub + vat) * 100) / 100, vatBreakdown: null };
    }
  }, [lineItems, vatRate, pricesIncludeVat]);

  const originalPrices = useMemo(() => {
    if (!invoice?.line_items) return {};
    const map: Record<number, number> = {};
    ((invoice.line_items as unknown as LineItem[]) || []).forEach((li: LineItem, i: number) => { map[i] = li.unit_price; });
    return map;
  }, [invoice]);

  const hasPriceChanges = lineItems.some((li, i) => li.unit_price !== (originalPrices[i] ?? li.unit_price));
  const hasBookings = ((invoice?.booking_ids as string[])?.length ?? 0) > 0;
  const isDraft = invoice?.status === 'draft';
  const isCancelled = invoice?.status === 'cancelled';
  const isPaid = invoice?.status === 'paid';

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
          pdf_url: null,
        })
        .eq('id', invoice.id);

      if (error) throw error;

      if (syncToBookings && hasPriceChanges && hasBookings) {
        const { error: syncError } = await supabase.functions.invoke('sync-invoice-to-bookings', {
          body: { invoiceId: invoice.id },
        });
        if (syncError) {
          logger.error('Sync to bookings failed', syncError instanceof Error ? syncError : new Error(String(syncError)), { component: 'AcademyEditInvoice' });
          toast.error(t('invoiceEdit.savedSyncFailed'));
        }
      }

      toast.success(t('invoiceEdit.saved'));
      queryClient.invalidateQueries({ queryKey: ['academy-invoices'] });
      navigate('/app/academy/invoices');
    } catch (err) {
      logger.error('Failed to update invoice', err instanceof Error ? err : new Error(String(err)), { component: 'AcademyEditInvoice' });
      toast.error(t('invoiceEdit.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!invoice) return;
    try {
      const { downloadInvoicePdf } = await import('@/lib/downloadInvoicePdf');
      const ok = await downloadInvoicePdf(invoice.id, invoice.invoice_number);
      if (!ok) toast.error(t('invoiceEdit.noPdf', tAcademy('invoices.noPdf', 'No PDF available')));
    } catch {
      toast.error(tAcademy('invoices.noPdf', 'No PDF available'));
    }
  };

  const handleMarkPaid = async () => {
    if (!invoice) return;
    const { error } = await supabase
      .from('invoices')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', invoice.id);
    if (error) {
      toast.error(t('invoiceEdit.statusFailed'));
      return;
    }
    toast.success(tAcademy('invoices.markedAsPaid', 'Invoice marked as paid'));
    queryClient.invalidateQueries({ queryKey: ['academy-invoices'] });
    navigate('/app/academy/invoices');
  };

  const handleDelete = async () => {
    if (!invoice) return;
    if (isDraft) {
      const { error } = await supabase.from('invoices').delete().eq('id', invoice.id);
      if (error) { toast.error(t('invoiceEdit.deleteFailed')); return; }
      toast.success(tAcademy('invoices.deleted', 'Invoice deleted'));
    } else {
      const { error } = await supabase.from('invoices').update({ status: 'cancelled' }).eq('id', invoice.id);
      if (error) { toast.error(t('invoiceEdit.cancelFailed')); return; }
      toast.success(tAcademy('invoices.cancelled', 'Invoice cancelled'));
    }
    queryClient.invalidateQueries({ queryKey: ['academy-invoices'] });
    navigate('/app/academy/invoices');
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="container mx-auto px-4 py-12 text-center">
        <p className="text-muted-foreground">{t('invoiceEdit.notFound')}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/app/academy/invoices')}>
          {t('invoiceEdit.backToInvoices')}
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="container mx-auto px-4 py-6 max-w-3xl space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate('/app/academy/invoices')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{t('invoiceEdit.title')}</h1>
            <p className="text-sm text-muted-foreground font-mono">{invoice.invoice_number}</p>
          </div>
          {/* Management actions */}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleDownloadPdf}>
              <Download className="h-4 w-4 mr-2" />
              PDF
            </Button>
            {!isPaid && !isCancelled && (
              <Button variant="outline" size="sm" onClick={handleMarkPaid}>
                <CheckCircle className="h-4 w-4 mr-2" />
                {t('invoiceEdit.paid')}
              </Button>
            )}
            {!isCancelled && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {isDraft ? t('invoiceEdit.deleteAction') : t('invoiceEdit.cancelAction')}
              </Button>
            )}
          </div>
        </div>

        <InvoiceRecipientCard
          owner="academy"
          playerName={invoice.player_name}
          playerId={invoice.player_id}
          guestPlayerId={invoice.guest_player_id}
        />
        <InvoiceSourceCard owner="academy" bookingIds={invoice.booking_ids as string[] | null} />

        {/* Receiver (editable billing) */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t('invoiceEdit.receiver')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <Input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder={t('invoiceEdit.namePlaceholder')} className="text-sm" />
              <Input value={playerBusinessName} onChange={(e) => setPlayerBusinessName(e.target.value)} placeholder={t('invoiceEdit.businessNamePlaceholder')} className="text-sm" />
              <Input value={playerStreet} onChange={(e) => setPlayerStreet(e.target.value)} placeholder={t('invoiceEdit.streetPlaceholder')} className="text-sm col-span-2" />
              <Input value={playerZipCode} onChange={(e) => setPlayerZipCode(e.target.value)} placeholder={t('invoiceEdit.zipCodePlaceholder')} className="text-sm" />
              <Input value={playerCity} onChange={(e) => setPlayerCity(e.target.value)} placeholder={t('invoiceEdit.cityPlaceholder')} className="text-sm" />
              <Input value={playerBtwNumber} onChange={(e) => setPlayerBtwNumber(e.target.value)} placeholder={t('invoiceEdit.btwPlaceholder')} className="text-sm col-span-2" />
            </div>
          </CardContent>
        </Card>

        {/* Line items */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">{t('invoiceEdit.lineItems')}</CardTitle>
              <div className="flex items-center gap-1">
                <ExtraCostPresetPicker
                  academyProfileId={activeAcademy?.id}
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
                  {t('invoiceEdit.addLineItem')}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {/* Desktop grid */}
              <div className="hidden md:block space-y-2">
              <div className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center text-xs font-medium text-muted-foreground px-1">
                <span>{t('invoiceEdit.description')}</span>
                <span>{t('invoiceEdit.quantity')}</span>
                <span>{t('invoiceEdit.price')}</span>
                <span>BTW %</span>
                <span>{t('invoiceEdit.total')}</span>
                <span></span>
              </div>
              {lineItems.map((li, i) => (
                <div key={i} className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center">
                  <Input value={li.description} onChange={(e) => updateLineItem(i, 'description', e.target.value)} placeholder={t('invoiceEdit.description')} className="text-sm" />
                  <Input type="number" value={li.quantity === 0 ? '' : li.quantity} onChange={(e) => updateLineItem(i, 'quantity', e.target.value === '' ? 0 : (parseInt(e.target.value) || 0))} onBlur={() => { if (!li.quantity || li.quantity < 1) updateLineItem(i, 'quantity', 1); }} className="text-sm" min={1} />
                  <Input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)} className="text-sm" step="0.01" min={0} />
                  <div className="relative">
                    <Input type="number" value={li.vat_rate || ''} onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)} className="text-sm pr-5" min={0} max={100} step={1} />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <div className="text-right text-sm font-medium py-2">€{(li.quantity * li.unit_price).toFixed(2)}</div>
                  <Button type="button" variant="ghost" size="icon" aria-label="Delete" className="h-7 w-7" onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1}>
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
              </div>
            {/* Mobile stacked cards */}
            <div className="md:hidden space-y-3">
              {lineItems.map((li, i) => (
                <div key={i} className="border rounded-lg p-3 space-y-2 bg-muted/30">
                  <div className="flex items-center gap-2">
                    <Input value={li.description} onChange={(e) => updateLineItem(i, 'description', e.target.value)} placeholder={t('invoiceEdit.description')} className="text-sm flex-1" />
                    <Button type="button" variant="ghost" size="sm" aria-label={t('invoiceEdit.removeLineItem', 'Remove line item')} className="h-7 w-7 p-0 shrink-0" onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1}>
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">{t('invoiceEdit.quantity')}</Label>
                      <Input type="number" value={li.quantity === 0 ? '' : li.quantity} onChange={(e) => updateLineItem(i, 'quantity', e.target.value === '' ? 0 : (parseInt(e.target.value) || 0))} onBlur={() => { if (!li.quantity || li.quantity < 1) updateLineItem(i, 'quantity', 1); }} className="text-sm" min={1} />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">{t('invoiceEdit.price')}</Label>
                      <Input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)} className="text-sm" step="0.01" min={0} />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">BTW %</Label>
                      <div className="relative">
                        <Input type="number" value={li.vat_rate || ''} onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)} className="text-sm pr-5" min={0} max={100} step={1} />
                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                  </div>
                  <div className="text-right text-sm font-medium">{t('invoiceEdit.total')}: €{(li.quantity * li.unit_price).toFixed(2)}</div>
                </div>
              ))}
            </div>
            </div>
          </CardContent>
        </Card>

        {/* Settings + Totals */}
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t('invoiceEdit.pricesIncludeVat')}</Label>
              <Switch checked={pricesIncludeVat} onCheckedChange={setPricesIncludeVat} />
            </div>

            <Separator />

            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('invoiceEdit.subtotal')}</span>
                <span>€{subtotal.toFixed(2)}</span>
              </div>
              {vatBreakdown && Object.keys(vatBreakdown).length > 1 ? (
                Object.entries(vatBreakdown)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([rate, data]) => (
                    <div key={rate} className="flex justify-between">
                      <span className="text-muted-foreground">BTW {rate}%</span>
                      <span>€{data.vat.toFixed(2)}</span>
                    </div>
                  ))
              ) : (
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground flex items-center gap-2">
                    BTW
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
                  <span>€{vatAmount.toFixed(2)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-base border-t pt-2">
                <span>{t('invoiceEdit.total')}</span>
                <span>€{total.toFixed(2)}</span>
              </div>
            </div>

            <Separator />

            {/* Due date */}
            <div className="flex items-center gap-4">
              <Label className="text-sm whitespace-nowrap">{t('invoiceEdit.dueDate')}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className={cn('justify-start text-left font-normal', !dueDate && 'text-muted-foreground')}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {dueDate ? format(dueDate, 'd MMM yyyy', { locale: dateFnsLocale }) : t('invoiceEdit.selectDate')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dueDate} onSelect={setDueDate} className={cn('p-3 pointer-events-auto')} />
                </PopoverContent>
              </Popover>
            </div>

            {/* Notes */}
            <div>
              <Label className="text-sm mb-1 block">{t('invoiceEdit.notes')}</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('invoiceEdit.notesPlaceholder')} rows={2} />
            </div>

            {/* Sync checkbox */}
            {hasPriceChanges && hasBookings && (
              <div className="flex items-center space-x-2 bg-muted/50 p-3 rounded-md">
                <Checkbox id="sync-bookings" checked={syncToBookings} onCheckedChange={(v) => setSyncToBookings(v === true)} />
                <Label htmlFor="sync-bookings" className="text-sm cursor-pointer">
                  {t('invoiceEdit.syncToBookings')}
                </Label>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => navigate('/app/academy/invoices')} disabled={saving}>{t('cancel')}</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isDraft ? t('invoiceEdit.deleteTitle') : t('invoiceEdit.cancelTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {isDraft ? t('invoiceEdit.deleteConfirm') : t('invoiceEdit.cancelConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              {isDraft ? t('invoiceEdit.deleteAction') : t('invoiceEdit.cancelAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
