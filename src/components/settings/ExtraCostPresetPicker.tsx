import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { supabase } from '@/lib/supabaseClient';
import { Package, Plus } from 'lucide-react';
import type { ExtraCost } from '@/lib/cycles';

interface Preset {
  id: string;
  description: string;
  price: number;
  vat_rate: number;
  type: string;
}

interface ExtraCostPresetPickerProps {
  trainerId?: string | null;
  academyProfileId?: string | null;
  onSelect: (cost: ExtraCost) => void;
}

export function ExtraCostPresetPicker({ trainerId, academyProfileId, onSelect }: ExtraCostPresetPickerProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (open && !loaded) {
      fetchPresets();
    }
  }, [open]);

  const fetchPresets = async () => {
    let query = supabase.from('extra_cost_presets').select('*');
    if (trainerId) query = query.eq('trainer_id', trainerId);
    else if (academyProfileId) query = query.eq('academy_profile_id', academyProfileId);
    else return;

    const { data } = await query.order('created_at');
    setPresets(data || []);
    setLoaded(true);
  };

  if (!trainerId && !academyProfileId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="gap-1">
          <Package className="h-3.5 w-3.5" />
          Kies uit presets
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        {presets.length === 0 ? (
          <p className="text-sm text-muted-foreground p-2">
            Geen presets gevonden. Voeg ze toe in je instellingen.
          </p>
        ) : (
          <div className="space-y-1">
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="w-full text-left px-3 py-2 rounded-md hover:bg-accent text-sm transition-colors"
                onClick={() => {
                  onSelect({
                    description: preset.description,
                    price: Number(preset.price),
                    type: preset.type as 'per_session' | 'one_time',
                    vat_rate: preset.vat_rate,
                  });
                  setOpen(false);
                }}
              >
                <div className="font-medium">{preset.description}</div>
                <div className="text-xs text-muted-foreground">
                  €{Number(preset.price).toFixed(2)} · {preset.vat_rate}% BTW · {preset.type === 'one_time' ? 'Eenmalig' : 'Per sessie'}
                </div>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
