import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { supabase } from '@/lib/supabaseClient';
import { Loader2, CalendarIcon, Plus, Trash2 } from 'lucide-react';
import { format, addDays } from 'date-fns';
import { nl } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
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
  const [playerName, setPlayerName] = useState('');
  const [playerBusinessName, setPlayerBusinessName] = useState('');
  const [playerStreet, setPlayerStreet] = useState('');
  const [playerZipCode, setPlayerZipCode] = useState('');
  const [playerCity, setPlayerCity] = useState('');
  const [playerBtwNumber, setPlayerBtwNumber] = useState('');
  const [playerEmail, setPlayerEmail] = useState('');
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
    const t = pricesIncludeVat
      ? Math.round(lineItems.reduce((s, li) => s + li.quantity * li.unit_price, 0) * 100) / 100
      : Math.round((sub + vat) * 100) / 100;

    return {
      subtotal: sub,
      vatAmount: vat,
      total: t,
      vatBreakdown: hasMultipleRates ? breakdown : null,
    };
  }, [lineItems, pricesIncludeVat]);

  const handleSave = async () => {
    if (!playerName.trim()) {
      toast.error('Naam ontvanger is verplicht');
      return;
    }
    if (lineItems.length === 0 || lineItems.every(li => !li.description.trim())) {
      toast.error('Voeg minimaal één regelitem toe');
      return;
    }

    setSaving(true);
    try {
      // Fetch academy invoice settings
      const { data: academy, error: academyError } = await supabase
        .from('academy_profiles')
        .select('invoice_prefix, invoice_next_number, default_vat_rate, payment_terms_days')
        .eq('id', academyProfileId)
        .single();

      if (academyError || !academy) throw new Error('Academy niet gevonden');

      const prefix = academy.invoice_prefix || 'INV';
      const nextNumber = academy.invoice_next_number || 1;
      const invoiceNumber = `${prefix}-${new Date().getFullYear()}-${String(nextNumber).padStart(4, '0')}`;

      // Create guest player if email provided
      let guestPlayerId: string | null = null;
      if (playerEmail.trim()) {
        const { data: guestPlayer, error: guestError } = await supabase
          .from('guest_players')
          .insert({
            full_name: playerName.trim(),
            email: playerEmail.trim(),
            academy_profile_id: academyProfileId,
          })
          .select('id')
          .single();

        if (guestError) {
          console.error('Guest player creation failed:', guestError);
        } else {
          guestPlayerId = guestPlayer.id;
        }
      }

      const primaryVatRate = lineItems[0]?.vat_rate ?? 21;

      const updatedItems = lineItems.map(li => ({
        ...li,
        amount: Math.round(li.quantity * li.unit_price * 100) / 100,
      }));

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

      if (insertError) throw insertError;

      // Increment invoice_next_number
      await supabase
        .from('academy_profiles')
        .update({ invoice_next_number: nextNumber + 1 })
        .eq('id', academyProfileId);

      toast.success(`Factuur ${invoiceNumber} aangemaakt`);
      resetForm();
      onCreated();
      onClose();
    } catch (err) {
      console.error('Failed to create invoice:', err);
      toast.error('Kon factuur niet aanmaken');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { onClose(); } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nieuwe factuur aanmaken</DialogTitle>
          <DialogDescription>Maak een handmatige factuur aan met eigen gegevens en regelitems.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 max-h-[60vh] overflow-y-auto pr-1">
          {/* Receiver details */}
          <div className="space-y-3">
            <Label className="text-sm font-medium">Ontvanger</Label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Naam *</Label>
                <Input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="Naam ontvanger" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Bedrijfsnaam</Label>
                <Input value={playerBusinessName} onChange={(e) => setPlayerBusinessName(e.target.value)} placeholder="Optioneel" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">BTW-nummer</Label>
                <Input value={playerBtwNumber} onChange={(e) => setPlayerBtwNumber(e.target.value)} placeholder="NL000000000B01" />
              </div>
              <div className="col-span-2">
                <Label className="text-xs text-muted-foreground">Straat + huisnummer</Label>
                <Input value={playerStreet} onChange={(e) => setPlayerStreet(e.target.value)} placeholder="Kapelweg 12" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Postcode</Label>
                <Input value={playerZipCode} onChange={(e) => setPlayerZipCode(e.target.value)} placeholder="3951AC" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Plaats</Label>
                <Input value={playerCity} onChange={(e) => setPlayerCity(e.target.value)} placeholder="Maarn" />
              </div>
              <div className="col-span-2">
                <Label className="text-xs text-muted-foreground">E-mailadres (voor verzending)</Label>
                <Input type="email" value={playerEmail} onChange={(e) => setPlayerEmail(e.target.value)} placeholder="ontvanger@voorbeeld.nl" />
              </div>
            </div>
          </div>

          {/* Prices include VAT toggle */}
          <div className="flex items-center justify-between">
            <Label className="text-sm">Prijzen zijn inclusief BTW</Label>
            <Switch checked={pricesIncludeVat} onCheckedChange={setPricesIncludeVat} />
          </div>

          {/* Line items */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">Regelitems</Label>
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
                  Regel toevoegen
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center text-xs font-medium text-muted-foreground px-1">
                <span>Omschrijving</span>
                <span>Aantal</span>
                <span>Prijs</span>
                <span>BTW %</span>
                <span>Totaal</span>
                <span></span>
              </div>
              {lineItems.map((li, i) => (
                <div key={i} className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center">
                  <Input
                    value={li.description}
                    onChange={(e) => updateLineItem(i, 'description', e.target.value)}
                    placeholder="Omschrijving"
                    className="text-sm"
                  />
                  <Input
                    type="number"
                    value={li.quantity || ''}
                    onChange={(e) => updateLineItem(i, 'quantity', e.target.value)}
                    placeholder="Aantal"
                    className="text-sm"
                    min={0}
                  />
                  <Input
                    type="number"
                    value={li.unit_price || ''}
                    onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)}
                    placeholder="Prijs"
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
                    €{(li.quantity * li.unit_price).toFixed(2)}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => removeLineItem(i)}
                    disabled={lineItems.length <= 1}
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
              <span className="text-muted-foreground">Subtotaal</span>
              <span>€{subtotal.toFixed(2)}</span>
            </div>
            {vatBreakdown ? (
              Object.entries(vatBreakdown)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([rate, data]) => (
                  <div key={rate} className="flex justify-between">
                    <span className="text-muted-foreground">BTW {rate}%</span>
                    <span>€{data.vat.toFixed(2)}</span>
                  </div>
                ))
            ) : (
              <div className="flex justify-between">
                <span className="text-muted-foreground">BTW {lineItems[0]?.vat_rate ?? 21}%</span>
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
                <Button variant="outline" size="sm" className={cn("justify-start text-left font-normal")}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(dueDate, 'd MMM yyyy', { locale: nl })}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={dueDate}
                  onSelect={(d) => d && setDueDate(d)}
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Annuleren</Button>
          <Button onClick={handleSave} disabled={saving || !playerName.trim()}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Factuur aanmaken
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
