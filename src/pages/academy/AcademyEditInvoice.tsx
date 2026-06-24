import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { Loader2, CalendarIcon, Trash2, ArrowLeft, Download, CheckCircle } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import { InvoiceRecipientCard } from '@/components/invoices/InvoiceRecipientCard';
import { InvoiceStatusHistoryCard } from '@/components/invoices/InvoiceStatusHistoryCard';
import { annotateInvoiceStatusReason } from '@/lib/invoiceStatusHistory';
import { InvoiceSourceCard } from '@/components/invoices/InvoiceSourceCard';
import { InvoiceLineItemsEditor } from '@/components/invoices/InvoiceLineItemsEditor';
import { InvoiceTotalsSummary } from '@/components/invoices/InvoiceTotalsSummary';
import { computeEditInvoiceTotals, type InvoiceFormLineItem } from '@/lib/invoiceFormTotals';
import { useAcademyContext } from '@/components/academy/AcademyLayout';
import { markInvoicePaidAndSyncBookings } from '@/lib/markInvoicePaid';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
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

type LineItem = InvoiceFormLineItem;

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
  const [cancelReason, setCancelReason] = useState('');
  const [markPaidConfirmOpen, setMarkPaidConfirmOpen] = useState(false);
  const [markPaidReason, setMarkPaidReason] = useState('');

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

  const totals = useMemo(
    () => computeEditInvoiceTotals(lineItems, vatRate, pricesIncludeVat),
    [lineItems, vatRate, pricesIncludeVat],
  );
  const { subtotal, vatAmount, total, vatBreakdown } = totals;

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
    // Paid/cancelled invoices are terminal: editing amounts makes the ledger and
    // the archived PDF disagree. Correct a paid invoice with a credit note.
    if (isPaid || isCancelled) {
      toast.error(isPaid
        ? t('invoiceEdit.lockedPaid', 'Betaalde facturen kunnen niet meer worden gewijzigd. Maak een creditfactuur.')
        : t('invoiceEdit.lockedCancelled', 'Geannuleerde facturen kunnen niet meer worden gewijzigd.'));
      return;
    }
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

  const handleMarkPaid = async (reason?: string) => {
    if (!invoice) return;
    const { error, blockedCancelled } = await markInvoicePaidAndSyncBookings(
      invoice.id,
      invoice.booking_ids as string[] | null,
    );
    if (blockedCancelled || error) {
      toast.error(t('invoiceEdit.statusFailed'));
      return;
    }
    if (reason?.trim()) await annotateInvoiceStatusReason(invoice.id, reason).catch(() => {});
    setMarkPaidConfirmOpen(false);
    toast.success(tAcademy('invoices.markedAsPaid', 'Invoice marked as paid'));
    queryClient.invalidateQueries({ queryKey: ['academy-invoices'] });
    if (activeAcademy?.id) {
      invalidateAllPlayerData(queryClient, { kind: 'academy', id: activeAcademy.id });
    }
    navigate('/app/academy/invoices');
  };

  const handleDelete = async (reason?: string) => {
    if (!invoice) return;
    if (isDraft) {
      const { error } = await supabase.from('invoices').delete().eq('id', invoice.id);
      if (error) { toast.error(t('invoiceEdit.deleteFailed')); return; }
      toast.success(tAcademy('invoices.deleted', 'Invoice deleted'));
    } else {
      const { error } = await supabase.from('invoices').update({ status: 'cancelled' }).eq('id', invoice.id);
      if (error) { toast.error(t('invoiceEdit.cancelFailed')); return; }
      if (reason?.trim()) await annotateInvoiceStatusReason(invoice.id, reason).catch(() => {});
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
          <Button variant="ghost" size="icon" aria-label={t('invoiceEdit.goBack', 'Go back')} onClick={() => navigate('/app/academy/invoices')}>
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
              <Button variant="outline" size="sm" onClick={() => setMarkPaidConfirmOpen(true)}>
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
          invoiceId={invoice.id}
        />
        <InvoiceSourceCard owner="academy" bookingIds={invoice.booking_ids as string[] | null} />
        <InvoiceStatusHistoryCard invoiceId={invoice.id} />

        {/* Receiver (editable billing) */}
        <Card className={flushOnMobileCardClass()}>
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
        <InvoiceLineItemsEditor
          lineItems={lineItems}
          onChange={setLineItems}
          newRowVatRate={vatRate}
          labels={{
            title: t('invoiceEdit.lineItems'),
            description: t('invoiceEdit.description'),
            descriptionPlaceholder: t('invoiceEdit.description'),
            quantity: t('invoiceEdit.quantity'),
            price: t('invoiceEdit.price'),
            vatPercent: t('invoiceEdit.vatPercent', 'BTW %'),
            total: t('invoiceEdit.total'),
            addRow: t('invoiceEdit.addLineItem'),
            removeRow: t('invoiceEdit.removeLineItem', 'Remove line item'),
            formatMobileTotal: (amount) => `${t('invoiceEdit.total')}: ${amount}`,
          }}
          presetPicker={(addPreset) => (
            <ExtraCostPresetPicker academyProfileId={activeAcademy?.id} onSelect={addPreset} />
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
                pricesIncludeVat: t('invoiceEdit.pricesIncludeVat'),
                subtotal: t('invoiceEdit.subtotal'),
                total: t('invoiceEdit.total'),
              }}
              renderVatRateLabel={(rate) => t('invoiceEdit.vatWithRate', 'BTW {{rate}}%', { rate })}
              singleRate={{ editable: { value: vatRate, onChange: setVatRate, prefix: t('invoiceEdit.vat', 'BTW') } }}
            />

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

      {/* Delete / cancel confirmation */}
      <AlertDialog
        open={deleteConfirmOpen}
        onOpenChange={(open) => { setDeleteConfirmOpen(open); if (!open) setCancelReason(''); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isDraft ? t('invoiceEdit.deleteTitle') : t('invoiceEdit.cancelTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {isDraft ? t('invoiceEdit.deleteConfirm') : t('invoiceEdit.cancelConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!isDraft && (
            <Input
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={tAcademy('invoices.bulk.cancelReasonPlaceholder', 'Reason (optional) — e.g. email bounced, duplicate')}
              maxLength={500}
            />
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => handleDelete(cancelReason)}
            >
              {isDraft ? t('invoiceEdit.deleteAction') : t('invoiceEdit.cancelAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mark-as-paid confirmation (with optional reason) */}
      <AlertDialog
        open={markPaidConfirmOpen}
        onOpenChange={(open) => { setMarkPaidConfirmOpen(open); if (!open) setMarkPaidReason(''); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tAcademy('invoices.markPaidTitle', 'Mark invoice as paid?')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tAcademy('invoices.markPaidConfirm', 'This records the invoice as paid. Add an optional note explaining why (e.g. paid in cash).')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={markPaidReason}
            onChange={(e) => setMarkPaidReason(e.target.value)}
            placeholder={tAcademy('invoices.markPaidReasonPlaceholder', 'Reason (optional) — e.g. paid in cash, bank transfer')}
            maxLength={500}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t('back')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleMarkPaid(markPaidReason)}>
              {tAcademy('invoices.markPaid', 'Mark as paid')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
