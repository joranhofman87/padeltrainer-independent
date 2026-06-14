import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Loader2, Sparkles } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { AppPage } from '@/components/ui/app-page';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { RatingHistoryChart } from '@/components/player/RatingHistoryChart';
import { JourneyTimelineEntry } from '@/components/player/JourneyTimelineEntry';
import {
  usePlayerJourney,
  useMarkFeedbackSeen,
  sharedCoachingNotes,
  JOURNEY_PAGE_SIZE,
} from '@/lib/playerJourney';

export default function PlayerJourney() {
  const { t } = useTranslation('common');
  const { user, profile } = useAuth();
  const profileId = profile?.id;
  const [page, setPage] = useState(0);

  const { data, isLoading } = usePlayerJourney(profileId, page);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / JOURNEY_PAGE_SIZE));

  // Clear the in-app "new feedback" indicator: mark the shared coaching notes on
  // the loaded entries as seen.
  const markSeen = useMarkFeedbackSeen(profileId);
  useEffect(() => {
    const ids = rows.flatMap((r) => sharedCoachingNotes(r).map((n) => n.id));
    if (ids.length > 0) markSeen.mutate(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  return (
    <AppPage>
      <PageHeader
        title={t('journey.title', 'My Journey')}
        description={t('journey.subtitle', 'Your progress, feedback and notes over time')}
      />

      {profileId && (
        <RatingHistoryChart
          profileId={profileId}
          currentRating={profile?.skill_rating ?? null}
          ratingSystem={(profile as { rating_system?: string } | null)?.rating_system || 'knltb'}
          playerName={profile?.full_name || ''}
        />
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-12 text-center text-muted-foreground">
          <Sparkles className="h-8 w-8 opacity-50" />
          <p>{t('journey.empty', 'Your past sessions and coach feedback will appear here')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {user?.id && profileId && rows.map((row) => (
            <JourneyTimelineEntry key={row.slot_id} row={row} authorId={user.id} profileId={profileId} />
          ))}

          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label={t('back', 'Previous')}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">{page + 1} / {pageCount}</span>
              <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} aria-label={t('next', 'Next')}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </AppPage>
  );
}
