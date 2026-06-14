import { useTranslation } from 'react-i18next';
import { format, parseISO } from 'date-fns';
import { nl, enUS } from 'date-fns/locale';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin, MessageSquareQuote, CheckCircle2, XCircle, TrendingUp, Video } from 'lucide-react';
import { PlayerSelfNoteEditor } from './PlayerSelfNoteEditor';
import { sharedCoachingNotes, ownNotes, type JourneyRow } from '@/lib/playerJourney';

export function JourneyTimelineEntry({
  row,
  authorId,
  profileId,
}: {
  row: JourneyRow;
  authorId: string;
  profileId: string;
}) {
  const { t, i18n } = useTranslation('common');
  const locale = i18n.language === 'nl' ? nl : enUS;
  const date = parseISO(row.start_time);
  const coachNotes = sharedCoachingNotes(row);
  const mine = ownNotes(row);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="font-medium">{format(date, 'EEEE d MMMM yyyy', { locale })}</p>
            <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
              {row.trainer_name && <span>{row.trainer_name}</span>}
              {row.location_name && (
                <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{row.location_name}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {row.rating_at_session != null && (
              <Badge variant="outline" className="gap-1 text-xs">
                <TrendingUp className="h-3 w-3" />
                {(row.rating_system || '').toUpperCase()} {row.rating_at_session}
              </Badge>
            )}
            {row.session_happened === true && (
              <Badge className="gap-1 border-0 bg-emerald-500/10 text-xs text-emerald-600">
                <CheckCircle2 className="h-3 w-3" />{t('journey.tookPlace', 'Took place')}
              </Badge>
            )}
            {row.session_happened === false && (
              <Badge variant="destructive" className="gap-1 text-xs">
                <XCircle className="h-3 w-3" />{t('journey.didNotHappen', "Didn't take place")}
              </Badge>
            )}
          </div>
        </div>

        {row.group_summary && (
          <p className="rounded-md bg-muted/50 p-2 text-sm">{row.group_summary}</p>
        )}

        {coachNotes.length > 0 && (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <MessageSquareQuote className="h-3.5 w-3.5" />
              {t('journey.coachFeedback', 'Feedback from your coach')}
            </p>
            {coachNotes.map((n) => (
              <p key={n.id} className="rounded-md border border-primary/20 bg-primary/5 p-2 text-sm">{n.body}</p>
            ))}
          </div>
        )}

        {/* video seam — wired up in a later phase */}
        <div className="flex items-center gap-1.5 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
          <Video className="h-3.5 w-3.5" />
          {t('journey.videoComingSoon', 'Practice videos coming soon')}
        </div>

        <PlayerSelfNoteEditor slotId={row.slot_id} authorId={authorId} profileId={profileId} notes={mine} />
      </CardContent>
    </Card>
  );
}
