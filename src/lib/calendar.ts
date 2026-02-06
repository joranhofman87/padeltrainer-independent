import { supabase } from '@/lib/supabaseClient';

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
    console.error('Error fetching calendar connection:', error);
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
      console.error('Error initiating Google auth:', error);
      return null;
    }

    return data.authUrl;
  } catch (err) {
    console.error('Failed to initiate Google Calendar auth:', err);
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
      console.error('Error disconnecting calendar:', error);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Failed to disconnect Google Calendar:', err);
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
      console.error('Error toggling calendar sync:', error);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Failed to toggle calendar sync:', err);
    return false;
  }
}
