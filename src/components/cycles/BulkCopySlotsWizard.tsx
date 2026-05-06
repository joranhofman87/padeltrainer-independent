import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { differenceInCalendarWeeks } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { ArrowLeft, Copy } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { getCycles, type Cycle } from '@/lib/cycles';
import { bulkCopySlotsToCycle, getBookingsBySlotIds } from '@/lib/priorityClaims';

interface Props {
  ownerType: 'trainer' | 'club' | 'academy';
  ownerId: string;
  backHref: string;
}

interface SourceSlot {
  id: string;
  start_time: string;
  end_time: string;
  cyclus_name: string | null;
  max_participants: number | null;
  price_per_session: number | null;
}

export default function BulkCopySlotsWizard({ ownerType, ownerId, backHref }: Props) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loadingCycles, setLoadingCycles] = useState(true);
  const [sourceCycleId, setSourceCycleId] = useState<string>('');
  const [targetCycleId, setTargetCycleId] = useState<string>('');
  const [sourceSlots, setSourceSlots] = useState<SourceSlot[]>([]);
  const [excludeSlotIds, setExcludeSlotIds] = useState<Set<string>>(new Set());
  const [bookingCounts, setBookingCounts] = useState<Map<string, number>>(new Map());
  const [priorityWindowDays, setPriorityWindowDays] = useState(14);
  const [createPriorityClaims, setCreatePriorityClaims] = useState(true);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  const [requireAdminReview, setRequireAdminReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getCycles(ownerType, ownerId)
      .then((c) => setCycles(c))
      .catch((e) => toast.error(e.message))
      .finally(() => setLoadingCycles(false));
  }, [ownerType, ownerId]);

  useEffect(() => {
    if (!sourceCycleId) {
      setSourceSlots([]);
      return;
    }
    (async () => {
      const { data, error } = await supabase
        .from('availability_slots')
        .select('id, start_time, end_time, cyclus_name, max_participants, price_per_session')
        .eq('cyclus_id', sourceCycleId)
        .order('start_time');
      if (error) {
        toast.error(error.message);
        return;
      }
      setSourceSlots(data || []);
      const map = await getBookingsBySlotIds((data || []).map((s) => s.id));
      const counts = new Map<string, number>();
      map.forEach((arr, k) => counts.set(k, arr.length));
      setBookingCounts(counts);
    })();
  }, [sourceCycleId]);

  const weeksOffset = useMemo(() => {
    const src = cycles.find((c) => c.id === sourceCycleId);
    const tgt = cycles.find((c) => c.id === targetCycleId);
    if (!src?.start_date || !tgt?.start_date) return 0;
    return differenceInCalendarWeeks(new Date(tgt.start_date), new Date(src.start_date));
  }, [cycles, sourceCycleId, targetCycleId]);

  const toggleExclude = (id: string) => {
    setExcludeSlotIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!sourceCycleId || !targetCycleId) {
      toast.error('Select source and target cycles');
      return;
    }
    if (sourceCycleId === targetCycleId) {
      toast.error('Source and target must be different');
      return;
    }
    setSubmitting(true);
    try {
      const result = await bulkCopySlotsToCycle({
        sourceCycleId,
        targetCycleId,
        weeksOffset,
        priorityWindowDays,
        createPriorityClaims,
        excludeSourceSlotIds: Array.from(excludeSlotIds),
      });
      toast.success(`${result.copiedSlots} slots copied, ${result.createdClaims} priority claims created.`);
      navigate(backHref);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingCycles) return <div className="container max-w-3xl mx-auto py-6"><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(backHref)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> {t('common:back', 'Back')}
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{t('bulkCopy.title', 'Copy slots to next cycle')}</h1>
        <p className="text-muted-foreground">{t('bulkCopy.subtitle', 'Reuse last cycle\'s slots and give existing players priority to rebook.')}</p>
      </div>

      <Card>
        <CardHeader><CardTitle>{t('bulkCopy.cycles', 'Cycles')}</CardTitle></CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label>{t('bulkCopy.source', 'Copy from')}</Label>
            <Select value={sourceCycleId} onValueChange={setSourceCycleId}>
              <SelectTrigger><SelectValue placeholder={t('bulkCopy.selectCycle', 'Select cycle')} /></SelectTrigger>
              <SelectContent>
                {cycles.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t('bulkCopy.target', 'Copy to')}</Label>
            <Select value={targetCycleId} onValueChange={setTargetCycleId}>
              <SelectTrigger><SelectValue placeholder={t('bulkCopy.selectCycle', 'Select cycle')} /></SelectTrigger>
              <SelectContent>
                {cycles.filter((c) => c.id !== sourceCycleId).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {targetCycleId && weeksOffset !== 0 && (
              <p className="text-xs text-muted-foreground mt-1">{t('bulkCopy.shiftWeeks', { count: weeksOffset, defaultValue: 'Slots will be shifted by {{count}} weeks.' })}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {sourceSlots.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('bulkCopy.slots', 'Slots')} ({sourceSlots.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1 max-h-80 overflow-auto">
              {sourceSlots.map((s) => {
                const start = new Date(s.start_time);
                const excluded = excludeSlotIds.has(s.id);
                const count = bookingCounts.get(s.id) ?? 0;
                return (
                  <label key={s.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted cursor-pointer">
                    <Checkbox checked={!excluded} onCheckedChange={() => toggleExclude(s.id)} />
                    <div className="flex-1 text-sm">
                      <div className="font-medium">
                        {start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}{' '}
                        {start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {count} {count === 1 ? 'player' : 'players'}{s.price_per_session ? ` - EUR ${Number(s.price_per_session).toFixed(2)}` : ''}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>{t('bulkCopy.window', 'Priority window')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-3 cursor-pointer">
            <Checkbox checked={createPriorityClaims} onCheckedChange={(v) => setCreatePriorityClaims(Boolean(v))} />
            <span className="text-sm">{t('bulkCopy.createClaims', 'Create priority claims for current players')}</span>
          </label>
          {createPriorityClaims && (
            <div className="max-w-xs">
              <Label>{t('bulkCopy.windowDays', 'Window length (days)')}</Label>
              <Input type="number" min={1} max={60} value={priorityWindowDays} onChange={(e) => setPriorityWindowDays(Number(e.target.value))} />
              <p className="text-xs text-muted-foreground mt-1">
                {t('bulkCopy.windowHint', 'Slots stay hidden from public until a player declines or this window ends.')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={submitting || !sourceCycleId || !targetCycleId}>
          <Copy className="h-4 w-4 mr-2" />
          {submitting ? t('common:saving', 'Saving...') : t('bulkCopy.confirm', 'Copy slots')}
        </Button>
      </div>
    </div>
  );
}
