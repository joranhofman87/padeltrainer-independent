import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { useAuth } from '@/hooks/useAuth';
import { Loader2, CalendarIcon, Plus, Trash2, ArrowLeft } from 'lucide-react';
import { format, addDays } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
interface LineItem {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  vat_rate: number;
}

export default function TrainerCreateInvoice() {
  const { t, i18n } = useTranslation('trainer');
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const dateFnsLocale = i18n.language === 'nl' ? nl : enUS;

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

  const { data: trainerProfile } = useQuery({
    queryKey: ["trainer-profile-for-invoice", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("trainer_profiles")
        .select("id, invoice_prefix, invoice_next_number, default_vat_rate, payment_terms_days")
        .eq("user_id", user.id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!user?.id,
  });

  const trainerId = trainerProfile?.id;

  const updateLineItem = (index: number, field: keyof LineItem, value: string | number) => {
    setLineItems(prev => {
      const updated = [...prev];
      const item = { ...updated[index] };
      if (field === 'description') item.description = value as string;
      else if (field === 'quantity') item.quantity = value === '' || value === 0 ? 0 : (parseInt(String(value)) || 0);
      else if (field === 'unit_price') item.unit_price = Number(value) || 0;
      else if (field === 'vat_rate') item.vat_rate = Number(value) || 0;
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
    let totalSub = 0, totalVatAmt = 0;
    const breakdown: Record<number, { subtotal: number; vat: number }> = {};

    for (const li of lineItems) {
      const lineTotal = li.quantity * li.unit_price;
      const lineVatRate = li.vat_rate;
      let lineSub: number, lineVat: number;
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

    return { subtotal: sub, vatAmount: vat, total: t, vatBreakdown: hasMultipleRates ? breakdown : null };
  }, [lineItems, pricesIncludeVat]);

  const handleSave = async () => {
    if (!trainerId) return;
    if (!playerName.trim()) { toast.error('Naam ontvanger is verplicht'); return; }
    if (lineItems.length === 0 || lineItems.every(li => !li.description.trim())) { toast.error('Voeg minimaal één regelitem toe'); return; }

    setSaving(true);
    try {
      const prefix = trainerProfile?.invoice_prefix ?? '';
      const nextNumber = trainerProfile?.invoice_next_number || 1;
      const invoiceNumber = formatInvoiceNumber(prefix, new Date().getFullYear(), nextNumber);

      let guestPlayerId: string | null = null;
      if (playerEmail.trim()) {
        const { data: guestPlayer } = await supabase
          .from('guest_players')
          .insert({ full_name: playerName.trim(), email: playerEmail.trim(), trainer_id: trainerId })
          .select('id')
          .single();
        if (guestPlayer) guestPlayerId = guestPlayer.id;
      }

      const primaryVatRate = lineItems[0]?.vat_rate ?? 21;
      const updatedItems = lineItems.map(li => ({ ...li, amount: Math.round(li.quantity * li.unit_price * 100) / 100 }));

      const { error: insertError } = await supabase.from('invoices').insert({
        invoice_number: invoiceNumber,
        invoice_date: format(new Date(), 'yyyy-MM-dd'),
        due_date: format(dueDate, 'yyyy-MM-dd'),
        player_name: playerName.trim(),
        player_business_name: playerBusinessName.trim() || null,
        player_address: [playerStreet.trim(), playerZipCode.trim(), playerCity.trim()].filter(Boolean).join('\n') || null,
        player_btw_number: playerBtwNumber.trim() || null,
        guest_player_id: guestPlayerId,
        trainer_id: trainerId,
        academy_profile_id: null,
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

      await supabase.from('trainer_profiles').update({ invoice_next_number: nextNumber + 1 }).eq('id', trainerId);

      toast.success(`Factuur ${invoiceNumber} aangemaakt`);
      queryClient.invalidateQueries({ queryKey: ['trainer-invoices'] });
      navigate('/app/trainer/invoices');
    } catch (err) {
      logger.error('Failed to create invoice:', err);
      toast.error('Kon factuur niet aanmaken');
    } finally {
      setSaving(false);
    }
  };

  if (!trainerId) return null;

  return (
    <div className="container mx-auto px-4 py-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/app/trainer/invoices')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{t('invoices.createInvoice', 'Nieuwe factuur')}</h1>
          <p className="text-sm text-muted-foreground">{t('invoices.createDescription', 'Maak een handmatige factuur aan.')}</p>
        </div>
      </div>

      {/* Receiver */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">Ontvanger</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><Label className="text-xs text-muted-foreground">Naam *</Label><Input value={playerName} onChange={(e) => setPlayerName(e.target.value)} placeholder="Naam ontvanger" /></div>
            <div><Label className="text-xs text-muted-foreground">Bedrijfsnaam</Label><Input value={playerBusinessName} onChange={(e) => setPlayerBusinessName(e.target.value)} placeholder="Optioneel" /></div>
            <div><Label className="text-xs text-muted-foreground">BTW-nummer</Label><Input value={playerBtwNumber} onChange={(e) => setPlayerBtwNumber(e.target.value)} placeholder="NL000000000B01" /></div>
            <div className="sm:col-span-2"><Label className="text-xs text-muted-foreground">Straat + huisnummer</Label><Input value={playerStreet} onChange={(e) => setPlayerStreet(e.target.value)} placeholder="Kapelweg 12" /></div>
            <div><Label className="text-xs text-muted-foreground">Postcode</Label><Input value={playerZipCode} onChange={(e) => setPlayerZipCode(e.target.value)} placeholder="3951AC" /></div>
            <div><Label className="text-xs text-muted-foreground">Plaats</Label><Input value={playerCity} onChange={(e) => setPlayerCity(e.target.value)} placeholder="Maarn" /></div>
            <div className="sm:col-span-2"><Label className="text-xs text-muted-foreground">E-mailadres (voor verzending)</Label><Input type="email" value={playerEmail} onChange={(e) => setPlayerEmail(e.target.value)} placeholder="ontvanger@voorbeeld.nl" /></div>
          </div>
        </CardContent>
      </Card>

      {/* Line items */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Regelitems</CardTitle>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setLineItems(prev => [...prev, { description: '', quantity: 1, unit_price: 0, amount: 0, vat_rate: 21 }])}>
              <Plus className="h-3 w-3 mr-1" />Regel toevoegen
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {/* Desktop */}
            <div className="hidden md:block space-y-2">
              <div className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center text-xs font-medium text-muted-foreground px-1">
                <span>Omschrijving</span><span>Aantal</span><span>Prijs</span><span>BTW %</span><span>Totaal</span><span></span>
              </div>
              {lineItems.map((li, i) => (
                <div key={i} className="grid grid-cols-[1fr_4rem_5rem_4rem_5rem_2rem] gap-2 items-center">
                  <Input value={li.description} onChange={(e) => updateLineItem(i, 'description', e.target.value)} placeholder="Omschrijving" className="text-sm" />
                  <Input type="number" value={li.quantity === 0 ? '' : li.quantity} onChange={(e) => updateLineItem(i, 'quantity', e.target.value)} onBlur={() => { if (!li.quantity || li.quantity < 1) updateLineItem(i, 'quantity', 1); }} className="text-sm" min={1} />
                  <Input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)} className="text-sm" step="0.01" min={0} />
                  <div className="relative">
                    <Input type="number" value={li.vat_rate || ''} onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)} className="text-sm pr-5" min={0} max={100} step={1} />
                    <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <div className="text-right text-sm font-medium py-2">€{(li.quantity * li.unit_price).toFixed(2)}</div>
                  <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1}>
                    <Trash2 className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
            {/* Mobile */}
            <div className="md:hidden space-y-3">
              {lineItems.map((li, i) => (
                <div key={i} className="border rounded-lg p-3 space-y-2 bg-muted/30">
                  <div className="flex items-center gap-2">
                    <Input value={li.description} onChange={(e) => updateLineItem(i, 'description', e.target.value)} placeholder="Omschrijving" className="text-sm flex-1" />
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => removeLineItem(i)} disabled={lineItems.length <= 1}>
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div><Label className="text-xs text-muted-foreground">Aantal</Label><Input type="number" value={li.quantity === 0 ? '' : li.quantity} onChange={(e) => updateLineItem(i, 'quantity', e.target.value)} onBlur={() => { if (!li.quantity || li.quantity < 1) updateLineItem(i, 'quantity', 1); }} className="text-sm" min={1} /></div>
                    <div><Label className="text-xs text-muted-foreground">Prijs</Label><Input type="number" value={li.unit_price || ''} onChange={(e) => updateLineItem(i, 'unit_price', e.target.value)} className="text-sm" step="0.01" min={0} /></div>
                    <div><Label className="text-xs text-muted-foreground">BTW %</Label><div className="relative"><Input type="number" value={li.vat_rate || ''} onChange={(e) => updateLineItem(i, 'vat_rate', e.target.value)} className="text-sm pr-5" min={0} max={100} step={1} /><span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span></div></div>
                  </div>
                  <div className="text-right text-sm font-medium">Totaal: €{(li.quantity * li.unit_price).toFixed(2)}</div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Totals */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center justify-between">
            <Label className="text-sm">Prijzen zijn inclusief BTW</Label>
            <Switch checked={pricesIncludeVat} onCheckedChange={setPricesIncludeVat} />
          </div>
          <Separator />
          <div className="space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Subtotaal</span><span>€{subtotal.toFixed(2)}</span></div>
            {vatBreakdown ? (
              Object.entries(vatBreakdown).sort(([a], [b]) => Number(a) - Number(b)).map(([rate, data]) => (
                <div key={rate} className="flex justify-between"><span className="text-muted-foreground">BTW {rate}%</span><span>€{data.vat.toFixed(2)}</span></div>
              ))
            ) : (
              <div className="flex justify-between"><span className="text-muted-foreground">BTW {lineItems[0]?.vat_rate ?? 21}%</span><span>€{vatAmount.toFixed(2)}</span></div>
            )}
            <div className="flex justify-between font-bold text-base border-t pt-2"><span>Totaal</span><span>€{total.toFixed(2)}</span></div>
          </div>
          <Separator />
          <div className="flex items-center gap-4">
            <Label className="text-sm whitespace-nowrap">Vervaldatum</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className={cn('justify-start text-left font-normal')}>
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {format(dueDate, 'd MMM yyyy', { locale: dateFnsLocale })}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dueDate} onSelect={(d) => d && setDueDate(d)} className={cn('p-3 pointer-events-auto')} />
              </PopoverContent>
            </Popover>
          </div>
          <div><Label className="text-sm mb-1 block">Notities</Label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optionele notities op de factuur..." rows={2} /></div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={() => navigate('/app/trainer/invoices')} disabled={saving}>Annuleren</Button>
        <Button onClick={handleSave} disabled={saving || !playerName.trim()}>
          {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Factuur aanmaken
        </Button>
      </div>
    </div>
  );
}
