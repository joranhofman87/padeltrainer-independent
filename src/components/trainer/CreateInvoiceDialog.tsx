import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';
import { Loader2, Plus, Trash2, FileText, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';
import { nl } from 'date-fns/locale';

interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  date?: string;
}

interface BookingData {
  id: string;
  lessonTitle: string;
  playerName: string;
  playerEmail: string;
  playerId?: string;
  date: string;
  time: string;
  price: number;
}

interface TrainerBusinessInfo {
  business_name: string | null;
  business_address: string | null;
  kvk_number: string | null;
  btw_number: string | null;
  iban: string | null;
  bic: string | null;
  payment_terms_days: number;
  invoice_prefix?: string | null;
}

interface CreateInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  booking?: BookingData;
  trainerId: string;
  trainerBusinessInfo: TrainerBusinessInfo;
  defaultVatRate?: number;
  onInvoiceCreated: () => void;
}

const VAT_RATES = [
  { value: '21', label: '21% - Standaard tarief' },
  { value: '9', label: '9% - Laag tarief' },
  { value: '0', label: '0% - Vrijgesteld / KOR' },
];

export function CreateInvoiceDialog({
  open,
  onOpenChange,
  booking,
  trainerId,
  trainerBusinessInfo,
  defaultVatRate,
  onInvoiceCreated,
}: CreateInvoiceDialogProps) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  
  const [playerName, setPlayerName] = useState('');
  const [playerAddress, setPlayerAddress] = useState('');
  const [playerBtwNumber, setPlayerBtwNumber] = useState('');
  const [vatRate, setVatRate] = useState((defaultVatRate ?? 21).toString());
  const [notes, setNotes] = useState('');
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  const isBusinessInfoComplete = 
    trainerBusinessInfo.business_name && 
    trainerBusinessInfo.business_address && 
    trainerBusinessInfo.kvk_number && 
    trainerBusinessInfo.iban;

  useEffect(() => {
    if (booking && open) {
      setPlayerName(booking.playerName);
      setLineItems([{
        description: booking.lessonTitle,
        quantity: 1,
        unit_price: booking.price,
        date: booking.date,
      }]);
    }
  }, [booking, open]);

  // Prices are VAT-inclusive: total = sum of line items, subtotal = total / (1 + vatRate/100)
  const total = lineItems.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);
  const vatRateNum = parseFloat(vatRate) || 0;
  const subtotal = vatRateNum > 0 ? total / (1 + vatRateNum / 100) : total;
  const vatAmount = total - subtotal;

  const addLineItem = () => {
    setLineItems([...lineItems, { description: '', quantity: 1, unit_price: 0 }]);
  };

  const removeLineItem = (index: number) => {
    setLineItems(lineItems.filter((_, i) => i !== index));
  };

  const updateLineItem = (index: number, field: keyof LineItem, value: string | number) => {
    const updated = [...lineItems];
    updated[index] = { ...updated[index], [field]: value };
    setLineItems(updated);
  };

  const generateInvoiceNumber = async (): Promise<string> => {
    const prefix = trainerBusinessInfo.invoice_prefix || 'INV';
    const year = new Date().getFullYear();
    
    // Get the last invoice number for this trainer this year
    const { data: lastInvoice } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('trainer_id', trainerId)
      .like('invoice_number', `${prefix}-${year}-%`)
      .order('invoice_number', { ascending: false })
      .limit(1)
      .single();
    
    let sequence = 1;
    if (lastInvoice?.invoice_number) {
      const lastSequence = parseInt(lastInvoice.invoice_number.split('-')[2] || '0');
      sequence = lastSequence + 1;
    }
    
    return `${prefix}-${year}-${sequence.toString().padStart(4, '0')}`;
  };

  const handleSubmit = async (saveAsDraft: boolean = false) => {
    if (!isBusinessInfoComplete) {
      toast({
        title: 'Ontbrekende bedrijfsgegevens',
        description: 'Vul eerst je bedrijfsgegevens in bij je profiel instellingen.',
        variant: 'destructive',
      });
      return;
    }

    if (lineItems.length === 0 || !playerName) {
      toast({
        title: 'Ontbrekende gegevens',
        description: 'Vul de klantnaam in en voeg minimaal één regel toe.',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    
    try {
      const invoiceNumber = await generateInvoiceNumber();
      const invoiceDate = new Date();
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + (trainerBusinessInfo.payment_terms_days || 14));

      const { data: invoice, error } = await supabase
        .from('invoices')
        .insert({
          trainer_id: trainerId,
          invoice_number: invoiceNumber,
          invoice_date: format(invoiceDate, 'yyyy-MM-dd'),
          due_date: format(dueDate, 'yyyy-MM-dd'),
          player_id: booking?.playerId || null,
          player_name: playerName,
          player_address: playerAddress || null,
          player_btw_number: playerBtwNumber || null,
          line_items: lineItems as unknown as Record<string, unknown>[],
          subtotal,
          vat_rate: parseFloat(vatRate),
          vat_amount: vatAmount,
          total,
          status: saveAsDraft ? 'draft' : 'sent',
          booking_ids: booking ? [booking.id] : [],
          notes: notes || null,
          sent_at: saveAsDraft ? null : new Date().toISOString(),
        } as any)
        .select()
        .single();

      if (error) throw error;

      // If not draft, generate PDF
      if (!saveAsDraft && invoice) {
        setGenerating(true);
        try {
          const { data: pdfData, error: pdfError } = await supabase.functions.invoke('generate-invoice', {
            body: { invoiceId: invoice.id },
          });
          
          if (pdfError) {
            logger.error('PDF generation error', pdfError instanceof Error ? pdfError : new Error(String(pdfError)), { component: 'CreateInvoiceDialog' });
            toast({
              title: 'Factuur aangemaakt',
              description: 'PDF genereren mislukt, maar de factuur is opgeslagen.',
            });
          }
        } catch (pdfErr) {
          logger.error('PDF error', pdfErr instanceof Error ? pdfErr : new Error(String(pdfErr)), { component: 'CreateInvoiceDialog' });
        }
        setGenerating(false);
      }

      // If booking exists, update payment status
      if (booking && !saveAsDraft) {
        await supabase
          .from('bookings')
          .update({ payment_status: 'invoiced' })
          .eq('id', booking.id);
      }

      toast({
        title: saveAsDraft ? 'Concept opgeslagen' : 'Factuur aangemaakt',
        description: saveAsDraft 
          ? `Factuur ${invoiceNumber} is opgeslagen als concept.`
          : `Factuur ${invoiceNumber} is aangemaakt.`,
      });

      onInvoiceCreated();
      onOpenChange(false);
      
      // Reset form
      setPlayerName('');
      setPlayerAddress('');
      setPlayerBtwNumber('');
      setVatRate((defaultVatRate ?? 21).toString());
      setNotes('');
      setLineItems([]);
    } catch (err: any) {
      logger.error('Error creating invoice', err instanceof Error ? err : new Error(String(err)), { component: 'CreateInvoiceDialog' });
      toast({
        title: 'Fout',
        description: err.message || 'Kon factuur niet aanmaken',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('invoices.create', 'Factuur aanmaken')}
          </DialogTitle>
          <DialogDescription>
            {t('invoices.createDescription', 'Maak een professionele factuur voor je klant')}
          </DialogDescription>
        </DialogHeader>

        {!isBusinessInfoComplete && (
          <Card className="border-orange-300 bg-orange-50 dark:bg-orange-950/20">
            <CardContent className="p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-orange-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-orange-800 dark:text-orange-200">
                  {t('invoices.missingBusinessInfo', 'Bedrijfsgegevens ontbreken')}
                </p>
                <p className="text-sm text-orange-600 dark:text-orange-300 mt-1">
                  {t('invoices.missingBusinessInfoDescription', 'Ga naar je profiel om bedrijfsgegevens in te vullen voordat je facturen kunt versturen.')}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="space-y-6 py-4">
          {/* Customer Details */}
          <div className="space-y-4">
            <h3 className="font-medium">{t('invoices.customerDetails', 'Klantgegevens')}</h3>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="playerName">{t('invoices.customerName', 'Naam klant')} *</Label>
                <Input
                  id="playerName"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="Jan Jansen"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="playerBtwNumber">{t('invoices.customerVat', 'BTW-nummer klant')}</Label>
                <Input
                  id="playerBtwNumber"
                  value={playerBtwNumber}
                  onChange={(e) => setPlayerBtwNumber(e.target.value)}
                  placeholder="NL123456789B01"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="playerAddress">{t('invoices.customerAddress', 'Adres klant')}</Label>
              <Textarea
                id="playerAddress"
                value={playerAddress}
                onChange={(e) => setPlayerAddress(e.target.value)}
                placeholder="Straatnaam 123&#10;1234 AB Amsterdam"
                rows={2}
              />
            </div>
          </div>

          <Separator />

          {/* Line Items */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">{t('invoices.lineItems', 'Regels')}</h3>
              <Button type="button" variant="outline" size="sm" onClick={addLineItem}>
                <Plus className="h-4 w-4 mr-1" />
                {t('invoices.addLine', 'Regel toevoegen')}
              </Button>
            </div>

            {lineItems.map((item, index) => (
              <Card key={index}>
                <CardContent className="p-4">
                  <div className="grid gap-4">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 space-y-2">
                        <Label>{t('invoices.description', 'Omschrijving')}</Label>
                        <Input
                          value={item.description}
                          onChange={(e) => updateLineItem(index, 'description', e.target.value)}
                          placeholder="Padel training"
                        />
                      </div>
                      {lineItems.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mt-7"
                          onClick={() => removeLineItem(index)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-2">
                        <Label>{t('invoices.date', 'Datum')}</Label>
                        <Input
                          type="date"
                          value={item.date || ''}
                          onChange={(e) => updateLineItem(index, 'date', e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('invoices.quantity', 'Aantal')}</Label>
                        <Input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) => updateLineItem(index, 'quantity', parseInt(e.target.value) || 1)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>{t('invoices.unitPrice', 'Prijs (incl. BTW)')}</Label>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={item.unit_price}
                          onChange={(e) => updateLineItem(index, 'unit_price', parseFloat(e.target.value) || 0)}
                        />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Separator />

          {/* VAT and Totals */}
          <div className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('invoices.vatRate', 'BTW-tarief')}</Label>
                <Select value={vatRate} onValueChange={setVatRate}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VAT_RATES.map((rate) => (
                      <SelectItem key={rate.value} value={rate.value}>
                        {rate.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t('invoices.notes', 'Opmerkingen')}</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Optionele opmerkingen..."
                  rows={2}
                />
              </div>
            </div>

            <Card className="bg-muted/50">
              <CardContent className="p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span>{t('invoices.subtotal', 'Subtotaal')}</span>
                  <span>€{subtotal.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>BTW {vatRate}%</span>
                  <span>€{vatAmount.toFixed(2)}</span>
                </div>
                <Separator />
                <div className="flex justify-between font-bold text-lg">
                  <span>{t('invoices.total', 'Totaal')}</span>
                  <span>€{total.toFixed(2)}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleSubmit(true)}
            disabled={loading || generating}
          >
            {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {t('invoices.saveAsDraft', 'Opslaan als concept')}
          </Button>
          <Button
            type="button"
            onClick={() => handleSubmit(false)}
            disabled={loading || generating || !isBusinessInfoComplete}
          >
            {(loading || generating) ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileText className="h-4 w-4 mr-2" />}
            {generating ? 'PDF genereren...' : t('invoices.createAndSend', 'Aanmaken')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
