import { useState, useEffect, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { Loader2, CalendarIcon, Plus } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { nl } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { ExtraCostPresetPicker } from '@/components/settings/ExtraCostPresetPicker';
import { Label } from '@/components/ui/label';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { Loader2, CalendarIcon } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { nl } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

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
}

interface EditInvoiceDialogProps {
  open: boolean;
  onClose: () => void;
  invoice: EditInvoiceData | null;
  onSaved: () => void;
  trainerId?: string | null;
  academyProfileId?: string | null;
}

export function EditInvoiceDialog({ open, onClose, invoice, onSaved }: EditInvoiceDialogProps) {
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [vatRate, setVatRate] = useState(21);
  const [dueDate, setDueDate] = useState<Date | undefined>();
  const [notes, setNotes] = useState('');
  const [syncToBookings, setSyncToBookings] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (invoice) {
      setLineItems((invoice.line_items || []).map((li: LineItem) => ({ ...li })));
      setVatRate(invoice.vat_rate ?? 21);
      setDueDate(invoice.due_date ? parseISO(invoice.due_date) : undefined);
      setNotes((invoice as any).notes || '');
      setSyncToBookings(false);
    }
  }, [invoice]);

  const updateLineItem = (index: number, field: keyof LineItem, value: string | number) => {
    setLineItems(prev => {
      const updated = [...prev];
      const item = { ...updated[index] };
      if (field === 'description') {
        item.description = value as string;
      } else if (field === 'quantity') {
        item.quantity = Number(value) || 0;
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

  const pricesIncludeVat = invoice?.prices_include_vat ?? true;

  const { subtotal, vatAmount, total, vatBreakdown } = useMemo(() => {
    // Check if line items have per-item vat rates
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

      // Round
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

    // Single VAT rate (original logic)
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
          toast.error('Factuur opgeslagen, maar synchronisatie naar boekingen is mislukt');
        }
      }

      toast.success('Factuur bijgewerkt');
      onSaved();
      onClose();
    } catch (err) {
      logger.error('Failed to update invoice', err instanceof Error ? err : new Error(String(err)), { component: 'EditInvoiceDialog' });
      toast.error('Kon factuur niet bijwerken');
    } finally {
      setSaving(false);
    }
  };

  if (!invoice) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Factuur bewerken</DialogTitle>
          <DialogDescription>Pas regelitems, BTW, vervaldatum of notities aan.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* Line items */}
          <div>
            <Label className="text-sm font-medium mb-2 block">Regelitems</Label>
            <div className="space-y-2">
              {lineItems.map((li, i) => (
                <div key={i} className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem] gap-2 items-center">
                  <Input
                    value={li.description}
                    onChange={(e) => updateLineItem(i, 'description', e.target.value)}
                    placeholder="Omschrijving"
                    className="text-sm"
                  />
                  <Input
                    type="number"
                    value={li.quantity}
                    onChange={(e) => updateLineItem(i, 'quantity', e.target.value)}
                    placeholder="Aantal"
                    className="text-sm"
                    min={0}
                  />
                  <Input
                    type="number"
                    value={li.unit_price}
                    onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)}
                    placeholder="Prijs"
                    className="text-sm"
                    step="0.01"
                    min={0}
                  />
                  <div className="relative">
                    <Input
                      type="number"
                      value={li.vat_rate ?? vatRate}
                      onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)}
                      className="text-sm pr-5"
                      min={0}
                      max={100}
                      step={1}
                    />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <div className="text-right text-sm font-medium py-2">
                    €{(li.quantity * li.unit_price).toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Totals */}
          <div className="border-t pt-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotaal</span>
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
              <span>Totaal</span>
              <span>€{total.toFixed(2)}</span>
            </div>
          </div>

          {/* Due date */}
          <div className="flex items-center gap-4">
            <Label className="text-sm whitespace-nowrap">Vervaldatum</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={cn("justify-start text-left font-normal", !dueDate && "text-muted-foreground")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dueDate ? format(dueDate, 'd MMM yyyy', { locale: nl }) : 'Selecteer datum'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dueDate}
                  onSelect={setDueDate}
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Notes */}
          <div>
            <Label className="text-sm mb-1 block">Notities</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optionele notities op de factuur..."
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
                Ook prijswijzigingen doorvoeren naar boekingen
              </Label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Annuleren</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Opslaan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
