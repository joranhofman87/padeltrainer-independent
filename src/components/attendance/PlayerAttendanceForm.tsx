import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Loader2, ClipboardCheck, Save, Check, Eye } from 'lucide-react';

interface PlayerAttendanceFormProps {
  slotId: string;
  bookingId: string;
  onSaved?: () => void;
}

export function PlayerAttendanceForm({ slotId, bookingId, onSaved }: PlayerAttendanceFormProps) {
  const { t } = useTranslation('player');
  const { profile } = useAuth();
  const { toast } = useToast();

  const [sessionHappened, setSessionHappened] = useState(true);
  const [privateNotes, setPrivateNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [existingReport, setExistingReport] = useState<string | null>(null);
  const [trainerSummary, setTrainerSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profile?.id) return;
    loadData();
  }, [profile?.id, slotId]);

  const loadData = async () => {
    if (!profile?.id) return;

    // Load player's own report
    const { data: own } = await supabase
      .from('session_reports')
      .select('*')
      .eq('slot_id', slotId)
      .eq('reporter_id', profile.id)
      .maybeSingle();

    if (own) {
      setExistingReport(own.id);
      setSessionHappened(own.session_happened);
      setPrivateNotes(own.notes || '');
    }

    // Load trainer's public summary
    const { data: trainerReport } = await supabase
      .from('session_reports')
      .select('public_notes')
      .eq('slot_id', slotId)
      .eq('reporter_role', 'trainer')
      .maybeSingle();

    if (trainerReport?.public_notes) {
      setTrainerSummary(trainerReport.public_notes);
    }

    setLoading(false);
  };

  const handleSave = async () => {
    if (!profile?.id) return;
    setSaving(true);

    const reportData = {
      slot_id: slotId,
      reporter_id: profile.id,
      reporter_role: 'player' as const,
      session_happened: sessionHappened,
      attendees: [],
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
      if (!existingReport) loadData();
      onSaved?.();
    }
    setSaving(false);
  };

  if (loading) return null;

  return (
    <div className="space-y-3 mt-3 p-3 border rounded-lg bg-muted/30">
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

      {/* Trainer's session summary (read-only) */}
      {trainerSummary && (
        <div className="rounded-md bg-muted/50 p-2.5 text-xs">
          <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
            <Eye className="h-3 w-3" />
            <span className="font-medium">{t('attendance.sessionSummary', 'Session summary')}</span>
          </div>
          <p className="text-foreground">{trainerSummary}</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id={`session-happened-player-${slotId}`}
          checked={sessionHappened}
          onCheckedChange={setSessionHappened}
        />
        <Label htmlFor={`session-happened-player-${slotId}`} className="text-xs cursor-pointer">
          {t('attendance.sessionHappened', 'Did this session happen?')}
        </Label>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t('attendance.myNotes', 'My notes (private)')}</Label>
        <Textarea
          value={privateNotes}
          onChange={e => setPrivateNotes(e.target.value)}
          placeholder={t('attendance.myNotesPlaceholder', 'Notes for yourself...')}
          className="min-h-[60px] text-xs"
        />
      </div>

      <Button size="sm" onClick={handleSave} disabled={saving} className="w-full gap-1.5">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        {t('attendance.save', 'Save')}
      </Button>
    </div>
  );
}
