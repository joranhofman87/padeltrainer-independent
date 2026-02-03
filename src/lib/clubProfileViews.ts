import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';

// Generate or retrieve a session ID for deduplication
function getSessionId(): string {
  const key = 'club_view_session';
  let sessionId = sessionStorage.getItem(key);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    sessionStorage.setItem(key, sessionId);
  }
  return sessionId;
}

// Check if this club was already viewed in this session
function hasViewedInSession(clubProfileId: string): boolean {
  const key = `viewed_club_${clubProfileId}`;
  return sessionStorage.getItem(key) === 'true';
}

// Mark club as viewed in this session
function markViewedInSession(clubProfileId: string): void {
  const key = `viewed_club_${clubProfileId}`;
  sessionStorage.setItem(key, 'true');
}

export async function recordClubProfileView(clubProfileId: string): Promise<void> {
  // Dedupe: don't record multiple views in the same session
  if (hasViewedInSession(clubProfileId)) {
    return;
  }

  try {
    const { error } = await supabase
      .from('club_profile_views')
      .insert({
        club_profile_id: clubProfileId,
        session_id: getSessionId(),
      });

    if (!error) {
      markViewedInSession(clubProfileId);
    }
  } catch (err) {
    // Silently fail - don't break the page for analytics
    logger.warn('Failed to record club profile view', { error: err });
  }
}

export async function getClubViewCount(
  clubProfileId: string,
  days?: number
): Promise<number> {
  let query = supabase
    .from('club_profile_views')
    .select('id', { count: 'exact', head: true })
    .eq('club_profile_id', clubProfileId);

  if (days) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    query = query.gte('viewed_at', since.toISOString());
  }

  const { count } = await query;
  return count || 0;
}

export async function getClubViewStats(clubProfileId: string): Promise<{
  last7Days: number;
  last30Days: number;
  total: number;
}> {
  const [last7Days, last30Days, total] = await Promise.all([
    getClubViewCount(clubProfileId, 7),
    getClubViewCount(clubProfileId, 30),
    getClubViewCount(clubProfileId),
  ]);

  return { last7Days, last30Days, total };
}
