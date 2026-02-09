import { supabase } from '@/lib/supabaseClient';
import { logger } from '@/lib/logger';

export interface CalendarConnection {
  id: string;
  user_id: string;
  provider: string;
  calendar_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export async function getCalendarConnection(): Promise<CalendarConnection | null> {
  const { data, error } = await supabase
    .from('user_calendar_connections')
    .select('id, user_id, provider, calendar_id, is_active, created_at, updated_at')
    .eq('provider', 'google')
    .maybeSingle();

  if (error) {
    logger.error('Error fetching calendar connection', error as Error, { component: 'calendar' });
    return null;
  }

  return data;
}

export async function initiateGoogleCalendarAuth(redirectUrl?: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.functions.invoke('google-calendar-auth', {
      body: { redirectUrl },
    });

    if (error) {
      logger.error('Error initiating Google auth', error as Error, { component: 'calendar' });
      return null;
    }

    return data.authUrl;
  } catch (err) {
    logger.error('Failed to initiate Google Calendar auth', err as Error, { component: 'calendar' });
    return null;
  }
}

export async function disconnectGoogleCalendar(): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('user_calendar_connections')
      .delete()
      .eq('provider', 'google');

    if (error) {
      logger.error('Error disconnecting calendar', error as Error, { component: 'calendar' });
      return false;
    }

    return true;
  } catch (err) {
    logger.error('Failed to disconnect Google Calendar', err as Error, { component: 'calendar' });
    return false;
  }
}

export async function toggleCalendarSync(isActive: boolean): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('user_calendar_connections')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('provider', 'google');

    if (error) {
      logger.error('Error toggling calendar sync', error as Error, { component: 'calendar' });
      return false;
    }

    return true;
  } catch (err) {
    logger.error('Failed to toggle calendar sync', err as Error, { component: 'calendar' });
    return false;
  }
}
