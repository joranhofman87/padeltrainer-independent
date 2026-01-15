import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    // Parse state to get user ID and redirect URL
    let stateData: { userId: string; redirectUrl: string; timestamp: number } | null = null;
    try {
      stateData = state ? JSON.parse(atob(state)) : null;
    } catch {
      console.error('Failed to parse state');
    }

    const redirectUrl = stateData?.redirectUrl || '/settings/calendar';

    if (error) {
      console.error('OAuth error:', error);
      return Response.redirect(`${redirectUrl}?error=${encodeURIComponent(error)}`);
    }

    if (!code || !stateData?.userId) {
      return Response.redirect(`${redirectUrl}?error=missing_code`);
    }

    const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID');
    const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');

    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      return Response.redirect(`${redirectUrl}?error=not_configured`);
    }

    // Exchange code for tokens
    const redirectUri = `${SUPABASE_URL}/functions/v1/google-calendar-callback`;
    
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      console.error('Token exchange error:', tokenData);
      return Response.redirect(`${redirectUrl}?error=${encodeURIComponent(tokenData.error)}`);
    }

    const { access_token, refresh_token, expires_in } = tokenData;

    // Calculate token expiration time
    const tokenExpiresAt = new Date(Date.now() + (expires_in * 1000)).toISOString();

    // Get user email from Google
    let userEmail = '';
    try {
      const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      const userInfo = await userInfoResponse.json();
      userEmail = userInfo.email || '';
    } catch (e) {
      console.error('Failed to get user info:', e);
    }

    // Store tokens in database using service role
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Upsert calendar connection
    const { error: dbError } = await supabase
      .from('user_calendar_connections')
      .upsert({
        user_id: stateData.userId,
        provider: 'google',
        access_token,
        refresh_token,
        token_expires_at: tokenExpiresAt,
        calendar_id: userEmail || 'primary',
        is_active: true,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,provider'
      });

    if (dbError) {
      console.error('Database error:', dbError);
      return Response.redirect(`${redirectUrl}?error=database_error`);
    }

    // Redirect back to settings with success
    return Response.redirect(`${redirectUrl}?success=true`);
  } catch (error: unknown) {
    console.error('Callback error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.redirect(`/settings/calendar?error=${encodeURIComponent(message)}`);
  }
});
