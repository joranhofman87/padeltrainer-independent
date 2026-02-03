import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';

// Generate or retrieve a session ID for deduplication
function getSessionId(): string {
  const key = 'profile_view_session';
  let sessionId = sessionStorage.getItem(key);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    sessionStorage.setItem(key, sessionId);
  }
  return sessionId;
}

// Check if this trainer was already viewed in this session
function hasViewedInSession(trainerId: string): boolean {
  const key = `viewed_trainer_${trainerId}`;
  return sessionStorage.getItem(key) === 'true';
}

// Mark trainer as viewed in this session
function markViewedInSession(trainerId: string): void {
  const key = `viewed_trainer_${trainerId}`;
  sessionStorage.setItem(key, 'true');
}

export async function recordProfileView(trainerId: string): Promise<void> {
  // Dedupe: don't record multiple views in the same session
  if (hasViewedInSession(trainerId)) {
    return;
  }

  try {
    const { error } = await supabase
      .from('trainer_profile_views')
      .insert({
        trainer_id: trainerId,
        session_id: getSessionId(),
      });

    if (!error) {
      markViewedInSession(trainerId);
    }
  } catch (err) {
    // Silently fail - don't break the page for analytics
    logger.warn('Failed to record profile view', { error: err });
  }
}

export async function getTrainerViewCount(
  trainerId: string,
  days?: number
): Promise<number> {
  let query = supabase
    .from('trainer_profile_views')
    .select('id', { count: 'exact', head: true })
    .eq('trainer_id', trainerId);

  if (days) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    query = query.gte('viewed_at', since.toISOString());
  }

  const { count } = await query;
  return count || 0;
}
