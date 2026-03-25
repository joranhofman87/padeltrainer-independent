import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabaseClient';
import { Plus, Trash2, Loader2, Package } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Preset {
  id: string;
  description: string;
  price: number;
  vat_rate: number;
  type: string;
}

interface ExtraCostPresetsCardProps {
  trainerId?: string | null;
  academyProfileId?: string | null;
}

export function ExtraCostPresetsCard({ trainerId, academyProfileId }: ExtraCostPresetsCardProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // New preset form
  const [newDescription, setNewDescription] = useState('');
  const [newPrice, setNewPrice] = useState<number | ''>('');
  const [newVatRate, setNewVatRate] = useState(21);
  const [newType, setNewType] = useState<'per_session' | 'one_time'>('per_session');

  useEffect(() => {
    fetchPresets();
  }, [trainerId, academyProfileId]);

  const fetchPresets = async () => {
    setLoading(true);
    let query = supabase.from('extra_cost_presets').select('*');
    if (trainerId) query = query.eq('trainer_id', trainerId);
    else if (academyProfileId) query = query.eq('academy_profile_id', academyProfileId);
    else { setLoading(false); return; }

    const { data } = await query.order('created_at');
    setPresets(data || []);
    setLoading(false);
  };

  const handleAdd = async () => {
    if (!newDescription.trim() || !newPrice) return;
    setSaving(true);

    const { error } = await supabase.from('extra_cost_presets').insert({
      trainer_id: trainerId || null,
      academy_profile_id: academyProfileId || null,
      description: newDescription.trim(),
      price: Number(newPrice),
      vat_rate: newVatRate,
      type: newType,
    } as any);

    if (error) {
      toast.error('Kon preset niet opslaan');
    } else {
      toast.success('Preset toegevoegd');
      setNewDescription('');
      setNewPrice('');
      setNewVatRate(21);
      setNewType('per_session');
      fetchPresets();
    }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from('extra_cost_presets').delete().eq('id', id);
    if (error) {
      toast.error('Kon preset niet verwijderen');
    } else {
      setPresets(prev => prev.filter(p => p.id !== id));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-5 w-5 text-primary" />
          Extra kosten presets
        </CardTitle>
        <CardDescription>
          Sla veelgebruikte extra kosten op zodat je ze snel kunt toevoegen bij het aanmaken van cycli en sessies.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <>
            {/* Existing presets */}
            {presets.length > 0 && (
              <div className="space-y-2">
                {presets.map((preset) => (
                  <div key={preset.id} className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{preset.description}</p>
                      <p className="text-xs text-muted-foreground">
                        €{Number(preset.price).toFixed(2)} · {preset.vat_rate}% BTW · {preset.type === 'one_time' ? 'Eenmalig' : 'Per sessie'}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(preset.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new preset */}
            <div className="space-y-3 pt-2 border-t">
              <Label className="text-sm font-medium">Nieuwe preset</Label>
              <div className="grid grid-cols-[1fr_5rem_5rem] gap-2">
                <Input
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Omschrijving (bijv. Balhuur)"
                />
                <div className="relative">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">€</span>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={newPrice}
                    onChange={(e) => setNewPrice(e.target.value ? parseFloat(e.target.value) : '')}
                    placeholder="0.00"
                    className="pl-6"
                  />
                </div>
                <div className="relative">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={newVatRate}
                    onChange={(e) => setNewVatRate(Number(e.target.value) || 0)}
                    className="pr-6"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex gap-2">
                  <label className={cn(
                    "flex items-center gap-1.5 text-xs cursor-pointer px-2 py-1 rounded-md border transition-colors",
                    newType === 'per_session' ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground"
                  )}>
                    <input type="radio" checked={newType === 'per_session'} onChange={() => setNewType('per_session')} className="sr-only" />
                    Per sessie
                  </label>
                  <label className={cn(
                    "flex items-center gap-1.5 text-xs cursor-pointer px-2 py-1 rounded-md border transition-colors",
                    newType === 'one_time' ? "border-primary bg-primary/5 text-primary" : "border-transparent text-muted-foreground"
                  )}>
                    <input type="radio" checked={newType === 'one_time'} onChange={() => setNewType('one_time')} className="sr-only" />
                    Eenmalig
                  </label>
                </div>
                <Button
                  size="sm"
                  onClick={handleAdd}
                  disabled={saving || !newDescription.trim() || !newPrice}
                >
                  {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                  Toevoegen
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
