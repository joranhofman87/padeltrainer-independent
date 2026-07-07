import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, ClipboardCheck, Save, Check } from 'lucide-react';

interface TrainerAttendanceFormProps {
  slotId: string;
  players: Array<{ id: string; name: string; profileId?: string; playerId?: string }>;
  onSaved?: () => void;
}

const attendeeId = (p: { id: string; profileId?: string; playerId?: string }) =>
  p.playerId || p.profileId || p.id;

export function TrainerAttendanceForm({ slotId, players, onSaved }: TrainerAttendanceFormProps) {
  const { t } = useTranslation('trainer');
  const { profile } = useAuth();
  const { toast } = useToast();

  const [sessionHappened, setSessionHappened] = useState(true);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [publicNotes, setPublicNotes] = useState('');
  const [privateNotes, setPrivateNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [existingReport, setExistingReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [touched, setTouched] = useState(false);
  // Player ids the form has already seen — lets the roster-sync effect tell a
  // freshly ADDED player apart from one the trainer manually unchecked.
  const knownIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!profile?.id) return;
    loadExistingReport();
  }, [profile?.id, slotId]);

  const loadExistingReport = async () => {
    if (!profile?.id) return;
    const { data } = await supabase
      .from('session_reports')
      .select('*')
      .eq('slot_id', slotId)
      .eq('reporter_id', profile.id)
      .maybeSingle();

    if (data) {
      setExistingReport(data.id);
      setSessionHappened(data.session_happened);
      setAttendees(data.attendees || []);
      setPublicNotes(data.public_notes || '');
      setPrivateNotes(data.notes || '');
    } else {
      // Default: all players attended
      setAttendees(players.map(attendeeId));
    }
    knownIdsRef.current = new Set(players.map(attendeeId));
    setLoading(false);
  };

  // The host page can edit the roster while the form is mounted (slot detail's
  // add/remove player). The one-shot default above would then record a freshly
  // added player as ABSENT (their checkbox appears unchecked) and keep ghost ids
  // for removed players. Keep membership in sync: prune removed ids, check newly
  // added ones (they were just added because they were there), and never override
  // a manual uncheck (a fresh id is one the form has never seen).
  useEffect(() => {
    if (loading) return;
    const ids = players.map(attendeeId);
    const fresh = ids.filter(id => !knownIdsRef.current.has(id));
    setAttendees(prev => {
      const next = !existingReport && !touched
        ? ids
        : [...prev.filter(id => ids.includes(id)), ...fresh.filter(id => !prev.includes(id))];
      return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
    });
    if (fresh.length > 0) knownIdsRef.current = new Set([...knownIdsRef.current, ...fresh]);
  }, [players, existingReport, touched, loading]);

  const toggleAttendee = (playerId: string) => {
    setTouched(true);
    setAttendees(prev =>
      prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]
    );
  };

  const handleSave = async () => {
    if (!profile?.id) return;
    setSaving(true);

    const reportData = {
      slot_id: slotId,
      reporter_id: profile.id,
      reporter_role: 'trainer' as const,
      session_happened: sessionHappened,
      attendees: sessionHappened ? attendees : [],
      public_notes: publicNotes.trim() || null,
      notes: privateNotes.trim() || null,
    };

    let error;
    if (existingReport) {
      ({ error } = await supabase
        .from('session_reports')
        .update(reportData)
        .eq('id', existingReport));
    } else {
      ({ error } = await supabase
        .from('session_reports')
        .insert(reportData));
    }

    if (error) {
      toast({ title: t('attendance.saveError', 'Failed to save'), variant: 'destructive' });
    } else {
      toast({ title: t('attendance.saved', 'Attendance saved') });
      if (!existingReport) {
        // Reload to get the ID
        loadExistingReport();
      }
      onSaved?.();
    }
    setSaving(false);
  };

  if (loading) return null;

  return (
    <div className="space-y-3 p-3 border rounded-lg bg-muted/30">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium flex items-center gap-1.5">
          <ClipboardCheck className="h-3.5 w-3.5" />
          {t('attendance.title', 'Attendance')}
        </span>
        {existingReport && (
          <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-300 gap-0.5">
            <Check className="h-2.5 w-2.5" />
            {t('attendance.reported', 'Reported')}
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id={`session-happened-${slotId}`}
          checked={sessionHappened}
          onCheckedChange={setSessionHappened}
        />
        <Label htmlFor={`session-happened-${slotId}`} className="text-xs cursor-pointer">
          {t('attendance.sessionHappened', 'Session happened')}
        </Label>
      </div>

      {sessionHappened && players.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-muted-foreground">{t('attendance.whoAttended', 'Who attended?')}</span>
          {players.map(player => {
            const pid = player.playerId || player.profileId || player.id;
            return (
              <label key={pid} className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
                <Checkbox
                  checked={attendees.includes(pid)}
                  onCheckedChange={() => toggleAttendee(pid)}
                />
                {player.name}
              </label>
            );
          })}
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs">{t('attendance.sessionSummary', 'Session summary (visible to players)')}</Label>
        <Textarea
          value={publicNotes}
          onChange={e => setPublicNotes(e.target.value)}
          placeholder={t('attendance.sessionSummaryPlaceholder', 'What was practiced today...')}
          className="min-h-[60px] md:text-xs"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t('attendance.privateNotes', 'Private notes (not visible to players)')}</Label>
        <Textarea
          value={privateNotes}
          onChange={e => setPrivateNotes(e.target.value)}
          placeholder={t('attendance.privateNotesPlaceholder', 'Internal notes...')}
          className="min-h-[60px] md:text-xs"
        />
      </div>

      <Button size="sm" onClick={handleSave} disabled={saving} className="w-full gap-1.5">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        {t('attendance.save', 'Save attendance')}
      </Button>
    </div>
  );
}
