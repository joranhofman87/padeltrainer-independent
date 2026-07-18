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
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { Separator } from '@/components/ui/separator';
import { supabase } from '@/lib/supabaseClient';
import { deleteOrCancelInvoices } from '@/lib/invoices';
import { logger } from '@/lib/logger';
import { markInvoicePaidAndSyncBookings } from '@/lib/markInvoicePaid';
import { invalidateAllPlayerData } from '@/lib/playerQueryKeys';
import { Loader2, Trash2, ArrowLeft, Download, CheckCircle } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { toast } from 'sonner';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import { InvoiceRecipientCard } from '@/components/invoices/InvoiceRecipientCard';
import { fetchPersonRefSet } from '@/lib/playerDetailData';
import { InvoiceSourceCard } from '@/components/invoices/InvoiceSourceCard';
import { InvoiceLineItemsEditor } from '@/components/invoices/InvoiceLineItemsEditor';
import { InvoiceTotalsSummary } from '@/components/invoices/InvoiceTotalsSummary';
import { computeEditInvoiceTotals, type InvoiceFormLineItem } from '@/lib/invoiceFormTotals';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

type LineItem = InvoiceFormLineItem;

function parseAddress(address?: string | null): { street: string; zipCode: string; city: string } {
  if (!address) return { street: '', zipCode: '', city: '' };
  const parts = address.split('\n');
  return { street: parts[0] || '', zipCode: parts[1] || '', city: parts[2] || '' };
}

export default function TrainerEditInvoice() {
  const { t: tTrainer } = useTranslation('trainer');
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const queryClient = useQueryClient();

  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [vatRate, setVatRate] = useState(21);
  const [dueDate, setDueDate] = useState<Date | undefined>();
  const [notes, setNotes] = useState('');
  const [syncToBookings, setSyncToBookings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pricesIncludeVat, setPricesIncludeVat] = useState(true);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      const { data, error } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
      if (error) throw error;
      return data;
    },
    enabled: !!invoiceId,
  });

  // Phase 3.5c: badge keys on person-level login (falls back to seat pre-deploy)
  const { data: personHasLogin } = useQuery({
    queryKey: ['invoice-person-has-login', invoice?.id],
    queryFn: async () => {
      const refs = await fetchPersonRefSet(
        { kind: 'trainer', id: invoice!.trainer_id! },
        { kind: 'guest', id: invoice!.guest_player_id! },
      );
      return refs.hasLogin ?? null;
    },
    enabled: !!invoice?.guest_player_id && !!invoice?.trainer_id,
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
    // the archived PDF disagree (and clears nothing that proves payment). Correct
    // a paid invoice with a credit note, not by overwriting it.
    if (isPaid || isCancelled) {
      toast.error(isPaid
        ? t('invoiceEdit.lockedPaid', 'Betaalde facturen kunnen niet meer worden gewijzigd. Maak een creditfactuur.')
        : t('invoiceEdit.lockedCancelled', 'Geannuleerde facturen kunnen niet meer worden gewijzigd.'));
      return;
    }
    setSaving(true);
    try {
      const updatedItems = lineItems.map(li => ({ ...li, amount: Math.round(li.quantity * li.unit_price * 100) / 100 }));
      const playerAddress = [playerStreet.trim(), playerZipCode.trim(), playerCity.trim()].filter(Boolean).join('\n') || null;
      const { error } = await supabase.from('invoices').update({
        line_items: updatedItems, vat_rate: vatRate,
        due_date: dueDate ? format(dueDate, 'yyyy-MM-dd') : invoice.due_date,
        notes: notes || null, subtotal, vat_amount: vatAmount, total,
        vat_breakdown: vatBreakdown || null, prices_include_vat: pricesIncludeVat,
        player_name: playerName.trim() || null, player_business_name: playerBusinessName.trim() || null,
        player_address: playerAddress, player_btw_number: playerBtwNumber.trim() || null, pdf_url: null,
      }).eq('id', invoice.id);
      if (error) throw error;
      toast.success(t('invoiceEdit.saved'));
      queryClient.invalidateQueries({ queryKey: ['trainer-invoices'] });
      navigate('/app/trainer/invoices');
    } catch (err) {
      logger.error('Failed to update invoice', err instanceof Error ? err : new Error(String(err)), { component: 'TrainerEditInvoice' });
      toast.error(t('invoiceEdit.saveError'));
    } finally { setSaving(false); }
  };

  const handleDownloadPdf = async () => {
    if (!invoice) return;
    try {
      const { downloadInvoicePdf } = await import('@/lib/downloadInvoicePdf');
      const ok = await downloadInvoicePdf(invoice.id, invoice.invoice_number);
      if (!ok) toast.error(tTrainer('invoices.noPdf', 'No PDF available'));
    } catch { toast.error(tTrainer('invoices.noPdf', 'No PDF available')); }
  };

  const handleMarkPaid = async () => {
    if (!invoice) return;
    const { error, blockedCancelled } = await markInvoicePaidAndSyncBookings(
      invoice.id,
      invoice.booking_ids as string[] | null,
    );
    if (blockedCancelled) { toast.error(t('invoiceEdit.statusFailed', t('invoiceEdit.saveError'))); return; }
    if (error) { toast.error(t('invoiceEdit.saveError')); return; }
    toast.success(tTrainer('invoices.markedAsPaid', 'Marked as paid'));
    queryClient.invalidateQueries({ queryKey: ['trainer-invoices'] });
    invalidateAllPlayerData(queryClient, { kind: 'trainer', id: invoice.trainer_id as string });
    navigate('/app/trainer/invoices');
  };

  const handleDelete = async () => {
    if (!invoice) return;
    // Draft → hard-delete; anything else → soft-cancel (audit trail). The facade
    // owns that partition so a paid invoice can never be hard-deleted here.
    const { deleteError, cancelError } = await deleteOrCancelInvoices([invoice]);
    if (deleteError || cancelError) { toast.error(t('invoiceEdit.deleteError')); return; }
    toast.success(isDraft ? tTrainer('invoices.deleted', 'Invoice deleted') : tTrainer('invoices.cancelled', 'Invoice cancelled'));
    queryClient.invalidateQueries({ queryKey: ['trainer-invoices'] });
    navigate('/app/trainer/invoices');
  };

  if (isLoading) return <div className="flex justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  if (!invoice) return (
    <div className="container mx-auto px-4 py-12 text-center">
      <p className="text-muted-foreground">{t('invoiceEdit.notFound')}</p>
      <Button variant="outline" className="mt-4" onClick={() => navigate('/app/trainer/invoices')}>{t('invoiceEdit.backToInvoices')}</Button>
    </div>
  );

  return (
    <>
      <div className="container mx-auto px-4 py-6 max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" aria-label="Go back" onClick={() => navigate('/app/trainer/invoices')}><ArrowLeft className="h-5 w-5" /></Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{t('invoiceEdit.title')}</h1>
            <p className="text-sm text-muted-foreground font-mono">{invoice.invoice_number}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleDownloadPdf}><Download className="h-4 w-4 mr-2" />PDF</Button>
            {!isPaid && !isCancelled && (
              <Button variant="outline" size="sm" onClick={handleMarkPaid}><CheckCircle className="h-4 w-4 mr-2" />{t('invoiceEdit.markPaid')}</Button>
            )}
            {!isCancelled && (
              <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteConfirmOpen(true)}>
                <Trash2 className="h-4 w-4 mr-2" />{isDraft ? t('delete') : t('cancel')}
              </Button>
            )}
          </div>
        </div>

        <InvoiceRecipientCard
          owner="trainer"
          playerName={invoice.player_name}
          playerId={invoice.player_id}
          guestPlayerId={invoice.guest_player_id}
          invoiceId={invoice.id}
          personHasLogin={personHasLogin ?? undefined}
        />
        <InvoiceSourceCard owner="trainer" bookingIds={invoice.booking_ids as string[] | null} />

        {/* Receiver (editable billing) */}
        <Card className={flushOnMobileCardClass()}>
          <CardHeader className="pb-3"><CardTitle className="text-base">{t('invoiceEdit.receiver')}</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder={t('invoiceEdit.name')} className="text-sm" />
              <Input value={playerBusinessName} onChange={(e) => setPlayerBusinessName(e.target.value)} placeholder={t('invoiceEdit.businessNameOptional')} className="text-sm" />
              <Input value={playerStreet} onChange={(e) => setPlayerStreet(e.target.value)} placeholder={t('invoiceEdit.street')} className="text-sm sm:col-span-2" />
              <Input value={playerZipCode} onChange={(e) => setPlayerZipCode(e.target.value)} placeholder={t('invoiceEdit.zipCode')} className="text-sm" />
              <Input value={playerCity} onChange={(e) => setPlayerCity(e.target.value)} placeholder={t('invoiceEdit.city')} className="text-sm" />
              <Input value={playerBtwNumber} onChange={(e) => setPlayerBtwNumber(e.target.value)} placeholder={t('invoiceEdit.vatNumberOptional')} className="text-sm sm:col-span-2" />
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
            vatPercent: t('invoiceEdit.vatPercent'),
            total: t('invoiceEdit.total'),
            addRow: t('invoiceEdit.addLine'),
            removeRow: t('invoiceEdit.removeLineItem', 'Remove line item'),
            formatMobileTotal: (amount) => `${t('invoiceEdit.total')}: ${amount}`,
          }}
          presetPicker={(addPreset) => (
            <ExtraCostPresetPicker trainerId={(invoice?.trainer_id as string) || null} onSelect={addPreset} />
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
                pricesIncludeVat: t('invoiceEdit.pricesIncludeVat'),
                subtotal: t('invoiceEdit.subtotal'),
                total: t('invoiceEdit.total'),
              }}
              renderVatRateLabel={(rate) => `BTW ${rate}%`}
              singleRate={{ editable: { value: vatRate, onChange: setVatRate, prefix: 'BTW' } }}
            />
            <Separator />
            <div className="flex items-center gap-4">
              <Label className="text-sm whitespace-nowrap">{t('invoiceEdit.dueDate')}</Label>
              <DatePickerPopover
                value={dueDate}
                onChange={setDueDate}
                placeholder={t('invoiceEdit.selectDate')}
                size="sm"
              />
            </div>
            <div><Label className="text-sm mb-1 block">{t('invoiceEdit.notes')}</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('invoiceEdit.notesPlaceholder')} rows={2} /></div>
            {hasPriceChanges && hasBookings && (
              <div className="flex items-center space-x-2 bg-muted/50 p-3 rounded-md">
                <Checkbox id="sync-bookings" checked={syncToBookings} onCheckedChange={(v) => setSyncToBookings(v === true)} />
                <Label htmlFor="sync-bookings" className="text-sm cursor-pointer">{t('invoiceEdit.syncPriceChanges')}</Label>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={() => navigate('/app/trainer/invoices')} disabled={saving}>{t('cancel')}</Button>
          <Button onClick={handleSave} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{t('save')}</Button>
        </div>
      </div>

      {/* Delete / cancel confirmation. The old AlertDialog auto-closed on click and ran
          the delete detached; ConfirmDialog stays open while `deleting` (blocking
          dismissal + double-fire) and closes on settle — success OR error. */}
      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title={isDraft ? t('invoiceEdit.deleteTitle') : t('invoiceEdit.cancelTitle')}
        description={isDraft ? t('invoiceEdit.deleteConfirm') : t('invoiceEdit.cancelConfirm')}
        confirmLabel={isDraft ? t('delete') : t('cancel')}
        cancelLabel={t('back')}
        loading={deleting}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await handleDelete();
          } finally {
            setDeleting(false);
            setDeleteConfirmOpen(false);
          }
        }}
      />
    </>
  );
}
