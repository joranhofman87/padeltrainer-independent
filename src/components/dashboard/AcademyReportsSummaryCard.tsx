import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { startOfMonth, endOfMonth } from 'date-fns';
import { ArrowRight, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabaseClient';
import { useQuery } from '@tanstack/react-query';

/**
 * Compact "reports this month" summary for the academy dashboard — sessions, fill-rate and
 * empty slots for the current month, linking to the deep report page (`?tab=reports`). Mirrors
 * the fill-rate math in AcademyReportsTab but over a single fixed period (this month), so it
 * stays a cheap one-query teaser rather than the full interactive report.
 */
export function AcademyReportsSummaryCard({ academyId }: { academyId: string }) {
  const { t } = useTranslation('academy');
  const navigate = useNavigate();

  const { data: stats, isLoading } = useQuery({
    queryKey: ['academy-reports-summary', academyId],
    queryFn: async () => {
      const rangeStart = startOfMonth(new Date());
      const rangeEnd = endOfMonth(new Date());

      const { data: slots } = await supabase
        .from('availability_slots')
        .select('id, max_participants')
        .eq('academy_profile_id', academyId)
        .gte('start_time', rangeStart.toISOString())
        .lte('start_time', rangeEnd.toISOString());

      const slotIds = (slots || []).map((s) => s.id);
      const bookingCounts = new Map<string, number>();
      if (slotIds.length > 0) {
        const { data: bookings } = await supabase
          .from('bookings')
          .select('slot_id')
          .in('slot_id', slotIds)
          .in('status', ['confirmed', 'pending']);
        (bookings || []).forEach((b) => {
          bookingCounts.set(b.slot_id, (bookingCounts.get(b.slot_id) || 0) + 1);
        });
      }

      let totalCapacity = 0;
      let totalBooked = 0;
      let emptySlots = 0;
      for (const s of slots || []) {
        const cap = s.max_participants || 4;
        const booked = bookingCounts.get(s.id) || 0;
        totalCapacity += cap;
        totalBooked += booked;
        if (booked === 0) emptySlots += 1;
      }
      return {
        sessions: (slots || []).length,
        fillRate: totalCapacity > 0 ? Math.round((totalBooked / totalCapacity) * 100) : 0,
        emptySlots,
      };
    },
    enabled: !!academyId,
    staleTime: 5 * 60 * 1000,
  });

  const cells: Array<{ label: string; value: string }> = [
    { label: t('reports.sessions', 'Sessies'), value: isLoading ? '—' : String(stats?.sessions ?? 0) },
    { label: t('reports.fillRate', 'Bezettingsgraad'), value: isLoading ? '—' : `${stats?.fillRate ?? 0}%` },
    { label: t('reports.emptySlots', 'Lege tijdsloten'), value: isLoading ? '—' : String(stats?.emptySlots ?? 0) },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4 text-[hsl(var(--navy-600))]" />
          {t('reportsSummary.title', 'Rapporten')}
          <span className="text-xs font-normal text-muted-foreground">{t('reportsSummary.thisMonth', 'deze maand')}</span>
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => navigate('/app/academy/calendar?tab=reports')}>
          {t('reportsSummary.viewFull', 'Volledig rapport')}
          <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3">
          {cells.map((c) => (
            <div key={c.label} className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
              <p className="text-xs font-medium text-muted-foreground">{c.label}</p>
              <p className="mt-1 font-display text-xl font-semibold tabular-nums text-[hsl(var(--navy-900))]">{c.value}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
