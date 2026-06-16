import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, Save, X } from 'lucide-react';
import { format } from 'date-fns';
import { upsertSessionReport } from '@/lib/sessionReports';
import { PlayerSessionReport } from '@/components/attendance/PlayerSessionReport';

interface PendingSlot {
  slotId: string;
  startTime: string;
  cyclusName: string | null;
  locationName: string | null;
  players: Array<{ id: string; name: string }>;
  bookingId?: string; // for player mode
  trainerSummary?: string | null;
}

interface PendingAttendanceCardProps {
  mode: 'trainer' | 'player';
  trainerId?: string; // trainer_profile.id for trainer mode
  profileId?: string; // profile.id for player mode
}

async function fetchPendingTrainerSlots(trainerId: string): Promise<PendingSlot[]> {
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const now = new Date();

  // Get past slots with confirmed bookings
  const { data: slots } = await supabase
    .from('availability_slots')
    .select(`
      id, start_time, cyclus_name, location_id,
      locations:location_id (name),
      bookings (id, player_id, guest_player_id, status,
        profiles:player_id (id, full_name),
        guest_players:guest_player_id (id, full_name)
      )
    `)
    .eq('trainer_id', trainerId)
    .gte('start_time', fourteenDaysAgo.toISOString())
    .lt('start_time', now.toISOString())
    .order('start_time', { ascending: false })
    .limit(50);

  if (!slots || slots.length === 0) return [];

  // Get trainer's profile ID for checking reports
  const { data: trainerProfile } = await supabase
    .from('trainer_profiles')
    .select('user_id')
    .eq('id', trainerId)
    .single();

  if (!trainerProfile) return [];

  const { data: profileData } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', trainerProfile.user_id)
    .single();

  if (!profileData) return [];

  // Get existing reports from this trainer
  const slotIds = slots.map(s => s.id);
  const { data: reports } = await supabase
    .from('session_reports')
    .select('slot_id')
    .in('slot_id', slotIds)
    .eq('reporter_id', profileData.id);

  const reportedSlotIds = new Set(reports?.map(r => r.slot_id) || []);

  return slots
    .filter(slot => {
      if (reportedSlotIds.has(slot.id)) return false;
      const bookings = (slot.bookings as any[]) || [];
      return bookings.some(b => ['confirmed', 'completed'].includes(b.status));
    })
    .map(slot => {
      const bookings = (slot.bookings as any[]) || [];
      const confirmedBookings = bookings.filter(b => ['confirmed', 'completed'].includes(b.status));
      const players = confirmedBookings.map(b => {
        const profile = b.profiles as any;
        const guest = b.guest_players as any;
        return {
          id: b.player_id || b.guest_player_id || b.id,
          name: profile?.full_name || guest?.full_name || '—',
        };
      });
      return {
        slotId: slot.id,
        startTime: slot.start_time,
        cyclusName: slot.cyclus_name,
        locationName: (slot.locations as any)?.name || null,
        players,
      };
    });
}

async function fetchPendingPlayerSlots(profileId: string): Promise<PendingSlot[]> {
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
  const now = new Date();

  const { data: bookings } = await supabase
    .from('bookings')
    .select(`
      id, status, slot_id,
      availability_slots!inner (id, start_time, cyclus_name, location_id, locations:location_id (name))
    `)
    .eq('player_id', profileId)
    .in('status', ['confirmed', 'completed'])
    .gte('availability_slots.start_time', fourteenDaysAgo.toISOString())
    .lt('availability_slots.start_time', now.toISOString())
    .order('created_at', { ascending: false })
    .limit(50);

  if (!bookings || bookings.length === 0) return [];

  // Check which slots already have player's report
  const slotIds = bookings.map(b => b.slot_id);
  const { data: reports } = await supabase
    .from('session_reports')
    .select('slot_id')
    .in('slot_id', slotIds)
    .eq('reporter_id', profileId);

  const reportedSlotIds = new Set(reports?.map(r => r.slot_id) || []);

  // Fetch trainer summaries for unreported slots
  const unreportedSlotIds = slotIds.filter(id => !reportedSlotIds.has(id));
  const trainerSummaryMap = new Map<string, string>();
  if (unreportedSlotIds.length > 0) {
    const { data: trainerReports } = await supabase
      .from('session_reports')
      .select('slot_id, public_notes')
      .in('slot_id', unreportedSlotIds)
      .eq('reporter_role', 'trainer');
    trainerReports?.forEach(r => {
      if (r.public_notes) trainerSummaryMap.set(r.slot_id, r.public_notes);
    });
  }

  return bookings
    .filter(b => !reportedSlotIds.has(b.slot_id))
    .map(b => {
      const slot = b.availability_slots as any;
      return {
        slotId: b.slot_id,
        startTime: slot.start_time,
        cyclusName: slot.cyclus_name,
        locationName: slot.locations?.name || null,
        players: [],
        bookingId: b.id,
        trainerSummary: trainerSummaryMap.get(b.slot_id) || null,
      };
    });
}

// --- Inline report form for a single slot ---

function TrainerReportForm({ slot, reporterId, onDone }: {
  slot: PendingSlot;
  reporterId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation('trainer');
  const { toast } = useToast();
  const [sessionHappened, setSessionHappened] = useState(true);
  const [attendees, setAttendees] = useState<string[]>(slot.players.map(p => p.id));
  const [publicNotes, setPublicNotes] = useState('');
  const [privateNotes, setPrivateNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleAttendee = (id: string) => {
    setAttendees(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const handleSave = async () => {
    setSaving(true);
    const { error } = await upsertSessionReport({
      slot_id: slot.slotId,
      reporter_id: reporterId,
      reporter_role: 'trainer',
      session_happened: sessionHappened,
      attendees: sessionHappened ? attendees : [],
      public_notes: publicNotes.trim() || null,
      notes: privateNotes.trim() || null,
    });
    if (error) {
      toast({ title: t('attendance.saveError', 'Failed to save'), variant: 'destructive' });
    } else {
      toast({ title: t('attendance.saved', 'Attendance saved') });
      onDone();
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3 mt-2 p-3 rounded-lg border bg-background">
      <div className="flex items-center gap-2">
        <Switch id={`sh-${slot.slotId}`} checked={sessionHappened} onCheckedChange={setSessionHappened} />
        <Label htmlFor={`sh-${slot.slotId}`} className="text-xs cursor-pointer">
          {t('attendance.sessionHappened', 'Session happened')}
        </Label>
      </div>

      {sessionHappened && slot.players.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">{t('attendance.whoAttended', 'Who attended?')}</span>
          {slot.players.map(p => (
            <label key={p.id} className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
              <Checkbox checked={attendees.includes(p.id)} onCheckedChange={() => toggleAttendee(p.id)} />
              {p.name}
            </label>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs">{t('attendance.sessionSummary', 'Session summary (visible to players)')}</Label>
        <Textarea value={publicNotes} onChange={e => setPublicNotes(e.target.value)}
          placeholder={t('attendance.sessionSummaryPlaceholder', 'What was practiced today...')}
          className="min-h-[50px] text-xs" />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t('attendance.privateNotes', 'Private notes (not visible to players)')}</Label>
        <Textarea value={privateNotes} onChange={e => setPrivateNotes(e.target.value)}
          placeholder={t('attendance.privateNotesPlaceholder', 'Internal notes...')}
          className="min-h-[50px] text-xs" />
      </div>

      <Button size="sm" onClick={handleSave} disabled={saving} className="w-full gap-1.5">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        {t('attendance.save', 'Save attendance')}
      </Button>
    </div>
  );
}

// --- Main card ---

export function PendingAttendanceCard({ mode, trainerId, profileId }: PendingAttendanceCardProps) {
  const { profile } = useAuth();
  const { t } = useTranslation(mode === 'trainer' ? 'trainer' : 'player');
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(true);
  const [expandedSlotId, setExpandedSlotId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  const queryKey = mode === 'trainer'
    ? ['pending-attendance-trainer', trainerId]
    : ['pending-attendance-player', profileId];

  const { data: pendingSlots = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => mode === 'trainer'
      ? fetchPendingTrainerSlots(trainerId!)
      : fetchPendingPlayerSlots(profileId!),
    enabled: mode === 'trainer' ? !!trainerId : !!profileId,
    staleTime: 60_000,
  });

  const visibleSlots = pendingSlots.filter(s => !dismissedIds.has(s.slotId));

  if (isLoading || visibleSlots.length === 0) return null;

  const reporterId = profile?.id;
  if (!reporterId) return null;

  const handleDone = (slotId: string) => {
    setExpandedSlotId(null);
    setDismissedIds(prev => new Set(prev).add(slotId));
    queryClient.invalidateQueries({ queryKey });
  };

  const handleDismiss = (slotId: string) => {
    setDismissedIds(prev => new Set(prev).add(slotId));
    if (expandedSlotId === slotId) setExpandedSlotId(null);
  };

  return (
    <Card className="border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 mb-6">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="pb-2 cursor-pointer">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span>{t('pendingAttendance.title', 'Action Required')}</span>
                <Badge variant="secondary" className="text-xs bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200">
                  {visibleSlots.length}
                </Badge>
              </CardTitle>
              {isOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('pendingAttendance.subtitle', '{{count}} session(s) need your attendance report', { count: visibleSlots.length })}
            </p>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 space-y-2">
            {visibleSlots.map(slot => (
              <div key={slot.slotId} className="rounded-lg border bg-background p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{slot.cyclusName || t('pendingAttendance.trainingSession', 'Training Session')}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(slot.startTime), 'EEE dd MMM, HH:mm')}
                      {slot.locationName && ` · ${slot.locationName}`}
                      {mode === 'trainer' && slot.players.length > 0 && ` · ${slot.players.length} ${t('pendingAttendance.players', 'players')}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {expandedSlotId !== slot.slotId && (
                      <Button size="sm" variant="default" className="h-7 text-xs px-3"
                        onClick={() => setExpandedSlotId(slot.slotId)}>
                        {t('pendingAttendance.report', 'Report')}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                      aria-label={t('pendingAttendance.dismiss', 'Dismiss')}
                      onClick={() => handleDismiss(slot.slotId)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {expandedSlotId === slot.slotId && (
                  mode === 'trainer' ? (
                    <TrainerReportForm slot={slot} reporterId={reporterId} onDone={() => handleDone(slot.slotId)} />
                  ) : (
                    <div className="mt-2 rounded-lg border bg-background p-3">
                      <PlayerSessionReport
                        slotId={slot.slotId}
                        trainerSummary={slot.trainerSummary}
                        onDone={() => handleDone(slot.slotId)}
                      />
                    </div>
                  )
                )}
              </div>
            ))}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
