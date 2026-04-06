import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { supabase } from '@/lib/supabaseClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ClipboardCheck, AlertTriangle, Check, X, MessageSquare, Eye, EyeOff } from 'lucide-react';

interface SessionReport {
  id: string;
  slot_id: string;
  reporter_id: string;
  reporter_role: string;
  session_happened: boolean;
  attendees: string[];
  notes: string | null;
  public_notes: string | null;
  reporter_name?: string;
}

interface SlotAttendanceCardProps {
  slotId: string;
  bookedPlayers: Array<{ id: string; name: string; profileId?: string }>;
  isPastSlot: boolean;
}

export function SlotAttendanceCard({ slotId, bookedPlayers, isPastSlot }: SlotAttendanceCardProps) {
  const { t } = useTranslation('academy');
  const [reports, setReports] = useState<SessionReport[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slotId || !isPastSlot) {
      setLoading(false);
      return;
    }
    fetchReports();
  }, [slotId, isPastSlot]);

  const fetchReports = async () => {
    const { data, error } = await supabase
      .from('session_reports')
      .select('id, slot_id, reporter_id, reporter_role, session_happened, attendees, notes, public_notes')
      .eq('slot_id', slotId);

    if (!error && data) {
      // Enrich with reporter names
      const reporterIds = data.map(r => r.reporter_id);
      const { data: profiles } = await supabase
        .from('profiles_public')
        .select('id, full_name')
        .in('id', reporterIds);
      const profileMap = new Map(profiles?.map(p => [p.id, p.full_name]) || []);

      setReports(data.map(r => ({
        ...r,
        attendees: r.attendees || [],
        reporter_name: profileMap.get(r.reporter_id) || undefined,
      })));
    }
    setLoading(false);
  };

  if (!isPastSlot) return null;
  if (loading) return null;

  const trainerReport = reports.find(r => r.reporter_role === 'trainer');
  const playerReports = reports.filter(r => r.reporter_role === 'player');

  // Check for conflicts: trainer says happened but a player says it didn't (or vice versa)
  const hasConflict = trainerReport && playerReports.some(
    pr => pr.session_happened !== trainerReport.session_happened
  );

  if (reports.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4" />
            {t('attendance.title', 'Attendance')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            {t('attendance.noReports', 'No attendance reports submitted yet')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4" />
            {t('attendance.title', 'Attendance')}
          </CardTitle>
          {hasConflict && (
            <Badge variant="destructive" className="text-[10px] h-5 px-1.5 gap-1">
              <AlertTriangle className="h-2.5 w-2.5" />
              {t('attendance.conflict', 'Conflict')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Trainer report */}
        {trainerReport && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('attendance.trainerReport', 'Trainer report')}</span>
              {trainerReport.session_happened ? (
                <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-300 gap-0.5">
                  <Check className="h-2.5 w-2.5" />
                  {t('attendance.sessionHappened', 'Session happened')}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-red-600 border-red-300 gap-0.5">
                  <X className="h-2.5 w-2.5" />
                  {t('attendance.sessionCancelled', 'Session cancelled')}
                </Badge>
              )}
            </div>

            {/* Attendees */}
            {trainerReport.session_happened && trainerReport.attendees.length > 0 && (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">{t('attendance.attendees', 'Attendees')}:</span>{' '}
                {bookedPlayers
                  .filter(p => trainerReport.attendees.includes(p.profileId || p.id))
                  .map(p => p.name)
                  .join(', ') || `${trainerReport.attendees.length} ${t('attendance.players', 'players')}`}
              </div>
            )}

            {/* Session summary (public) */}
            {trainerReport.public_notes && (
              <div className="rounded-md bg-muted/50 p-2.5 text-xs">
                <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
                  <Eye className="h-3 w-3" />
                  <span className="font-medium">{t('attendance.sessionSummary', 'Session summary')}</span>
                </div>
                <p className="text-foreground">{trainerReport.public_notes}</p>
              </div>
            )}

            {/* Trainer private notes */}
            {trainerReport.notes && (
              <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 p-2.5 text-xs">
                <div className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400 mb-1">
                  <EyeOff className="h-3 w-3" />
                  <span className="font-medium">{t('attendance.trainerNotes', 'Trainer notes (private)')}</span>
                </div>
                <p className="text-foreground">{trainerReport.notes}</p>
              </div>
            )}
          </div>
        )}

        {/* Player confirmations */}
        {playerReports.length > 0 && (
          <div className="space-y-2">
            <span className="text-sm font-medium">{t('attendance.playerConfirmations', 'Player confirmations')}</span>
            <div className="space-y-1">
              {playerReports.map(pr => {
                const isConflicting = trainerReport && pr.session_happened !== trainerReport.session_happened;
                return (
                  <div key={pr.id} className={`flex items-center justify-between text-xs py-1.5 px-2 rounded ${isConflicting ? 'bg-red-50 dark:bg-red-950/20' : ''}`}>
                    <span className="font-medium">{pr.reporter_name || t('attendance.unknownPlayer', 'Player')}</span>
                    <div className="flex items-center gap-2">
                      {pr.session_happened ? (
                        <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-emerald-600 border-emerald-300 gap-0.5">
                          <Check className="h-2.5 w-2.5" />
                          {t('attendance.confirmed', 'Confirmed')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-red-600 border-red-300 gap-0.5">
                          <X className="h-2.5 w-2.5" />
                          {t('attendance.denied', 'Denied')}
                        </Badge>
                      )}
                      {isConflicting && <AlertTriangle className="h-3 w-3 text-red-500" />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
