import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface CalendarEvent {
  summary: string;
  description: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders?: {
    useDefault: boolean;
    overrides?: { method: string; minutes: number }[];
  };
}

async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{ access_token: string; expires_in: number } | null> {
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const data = await response.json();
    if (data.error) {
      console.error('Token refresh error:', data);
      return null;
    }

    return { access_token: data.access_token, expires_in: data.expires_in };
  } catch (error) {
    console.error('Failed to refresh token:', error);
    return null;
  }
}

async function createGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEvent
): Promise<{ id: string } | null> {
  try {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Failed to create event:', error);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Error creating calendar event:', error);
    return null;
  }
}

async function deleteGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    return response.ok || response.status === 404; // 404 means already deleted
  } catch (error) {
    console.error('Error deleting calendar event:', error);
    return false;
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID');
    const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET');

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.log('Google Calendar not configured, skipping sync');
      return new Response(
        JSON.stringify({ success: true, message: 'Calendar sync not configured' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { booking_id, action } = await req.json();

    if (!booking_id || !action) {
      return new Response(
        JSON.stringify({ error: 'Missing booking_id or action' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Fetch booking with related data
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select(`
        id,
        notes,
        status,
        lesson_id,
        player_id,
        slot_id
      `)
      .eq('id', booking_id)
      .single();

    if (bookingError || !booking) {
      console.error('Booking not found:', bookingError);
      return new Response(
        JSON.stringify({ error: 'Booking not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch lesson details if exists
    let lesson: { title: string; description: string | null; duration_minutes: number; location: string | null; trainer_id: string } | null = null;
    if (booking.lesson_id) {
      const { data: lessonData } = await supabase
        .from('lessons')
        .select('title, description, duration_minutes, location, trainer_id')
        .eq('id', booking.lesson_id)
        .single();
      lesson = lessonData;
    }

    // Fetch availability slot
    const { data: slot } = await supabase
      .from('availability_slots')
      .select('start_time, end_time, trainer_id')
      .eq('id', booking.slot_id)
      .single();

    if (!slot) {
      console.error('Slot not found');
      return new Response(
        JSON.stringify({ error: 'Slot not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get player profile
    const { data: playerProfile } = await supabase
      .from('profiles')
      .select('user_id, full_name, email')
      .eq('id', booking.player_id)
      .single();

    // Get trainer profile and user_id
    const trainerId = lesson?.trainer_id || slot?.trainer_id;
    const { data: trainerProfile } = await supabase
      .from('trainer_profiles')
      .select('user_id')
      .eq('id', trainerId)
      .single();

    const { data: trainerUserProfile } = await supabase
      .from('profiles')
      .select('full_name, email')
      .eq('user_id', trainerProfile?.user_id)
      .single();

    // Get both user IDs for calendar sync
    const userIds = [
      playerProfile?.user_id,
      trainerProfile?.user_id,
    ].filter(Boolean);

    if (userIds.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No users to sync' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get calendar connections for both users
    const { data: connections } = await supabase
      .from('user_calendar_connections')
      .select('*')
      .in('user_id', userIds)
      .eq('provider', 'google')
      .eq('is_active', true);

    if (!connections || connections.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No active calendar connections' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const results: { userId: string; success: boolean; eventId?: string }[] = [];

    for (const connection of connections) {
      let accessToken = connection.access_token;

      // Check if token needs refresh
      const tokenExpiresAt = connection.token_expires_at 
        ? new Date(connection.token_expires_at) 
        : new Date(0);

      if (tokenExpiresAt <= new Date() && connection.refresh_token) {
        const refreshResult = await refreshAccessToken(
          connection.refresh_token,
          GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET
        );

        if (refreshResult) {
          accessToken = refreshResult.access_token;
          const newExpiresAt = new Date(Date.now() + refreshResult.expires_in * 1000);

          // Update stored token
          await supabase
            .from('user_calendar_connections')
            .update({
              access_token: accessToken,
              token_expires_at: newExpiresAt.toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', connection.id);
        } else {
          console.error('Failed to refresh token for user:', connection.user_id);
          results.push({ userId: connection.user_id, success: false });
          continue;
        }
      }

      const calendarId = connection.calendar_id || 'primary';

      if (action === 'create') {
        // Determine if this user is the player or trainer
        const isPlayer = connection.user_id === playerProfile?.user_id;
        const otherPersonName = isPlayer ? trainerUserProfile?.full_name : playerProfile?.full_name;
        const roleLabel = isPlayer ? 'Trainer' : 'Player';

        // Create event
        const event: CalendarEvent = {
          summary: `Tennis: ${lesson?.title || 'Lesson'}`,
          description: [
            `${roleLabel}: ${otherPersonName || 'TBD'}`,
            lesson?.description || '',
            booking.notes ? `Notes: ${booking.notes}` : '',
          ].filter(Boolean).join('\n'),
          location: lesson?.location || undefined,
          start: {
            dateTime: slot.start_time,
            timeZone: 'Europe/Amsterdam',
          },
          end: {
            dateTime: slot.end_time,
            timeZone: 'Europe/Amsterdam',
          },
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: 60 },
              { method: 'email', minutes: 1440 },
            ],
          },
        };

        const createdEvent = await createGoogleCalendarEvent(accessToken, calendarId, event);

        if (createdEvent) {
          // Store event reference
          await supabase.from('calendar_events').insert({
            booking_id,
            user_id: connection.user_id,
            google_event_id: createdEvent.id,
          });

          results.push({ userId: connection.user_id, success: true, eventId: createdEvent.id });
        } else {
          results.push({ userId: connection.user_id, success: false });
        }
      } else if (action === 'delete') {
        // Find existing calendar event
        const { data: calendarEvent } = await supabase
          .from('calendar_events')
          .select('id, google_event_id')
          .eq('booking_id', booking_id)
          .eq('user_id', connection.user_id)
          .single();

        if (calendarEvent) {
          const deleted = await deleteGoogleCalendarEvent(
            accessToken,
            calendarId,
            calendarEvent.google_event_id
          );

          if (deleted) {
            await supabase.from('calendar_events').delete().eq('id', calendarEvent.id);
          }

          results.push({ userId: connection.user_id, success: deleted });
        } else {
          results.push({ userId: connection.user_id, success: true }); // No event to delete
        }
      }
    }

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Sync error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
