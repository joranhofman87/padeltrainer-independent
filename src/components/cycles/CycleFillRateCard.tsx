import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';

interface Props {
  cyclusId: string;
}

interface Stats {
  claimed: number;
  pending: number;
  declined: number;
  booked: number;
}

export default function CycleFillRateCard({ cyclusId }: Props) {
  const { t } = useTranslation('cycles');
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: slots } = await supabase
        .from('availability_slots')
        .select('id')
        .eq('cyclus_id', cyclusId);
      const slotIds = (slots || []).map((s: any) => s.id);
      if (slotIds.length === 0) {
        if (!cancelled) setStats({ claimed: 0, pending: 0, declined: 0, booked: 0 });
        return;
      }
      const [{ data: claims }, { data: bookings }] = await Promise.all([
        supabase.from('slot_priority_claims').select('status').in('slot_id', slotIds),
        supabase.from('bookings').select('id').in('slot_id', slotIds).in('status', ['pending', 'confirmed']),
      ]);
      const acc: Stats = { claimed: 0, pending: 0, declined: 0, booked: bookings?.length || 0 };
      (claims || []).forEach((c: any) => {
        if (c.status === 'claimed') acc.claimed++;
        else if (c.status === 'pending') acc.pending++;
        else if (c.status === 'declined' || c.status === 'released' || c.status === 'expired') acc.declined++;
      });
      if (!cancelled) setStats(acc);
    })();
    return () => { cancelled = true; };
  }, [cyclusId]);

  if (!stats) return null;
  if (stats.claimed + stats.pending + stats.declined + stats.booked === 0) return null;

  const items: { label: string; value: number }[] = [
    { label: t('fillRate.booked', 'Booked'), value: stats.booked },
    { label: t('fillRate.claimed', 'Claimed'), value: stats.claimed },
    { label: t('fillRate.pending', 'Pending'), value: stats.pending },
    { label: t('fillRate.declined', 'Declined'), value: stats.declined },
  ];

  return (
    <div className="border rounded-lg p-3 bg-muted/30">
      <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
        {t('fillRate.title', 'Fill rate')}
      </p>
      <div className="grid grid-cols-4 gap-2">
        {items.map((it) => (
          <div key={it.label} className="text-center">
            <p className="text-lg font-bold">{it.value}</p>
            <p className="text-[10px] text-muted-foreground">{it.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
