import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { sendResendEmail } from "../_shared/resend-send.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { notifySlackEdgeError } from "../_shared/edge-slack.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

interface AuthEmailRequest {
  type: "email_verification" | "password_reset";
  email: string;
  redirectTo?: string;
}

const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;
const BRAND_ORANGE = "#f45d25";

const getEmailTemplate = (type: string, data: { userName?: string; actionLink: string }) => {
  const baseStyle = `
    font-family: Arial, sans-serif;
    max-width: 600px;
    margin: 0 auto;
    padding: 20px;
  `;
  
  const buttonStyle = `
    background: ${BRAND_ORANGE};
    color: white;
    padding: 14px 28px;
    text-decoration: none;
    border-radius: 6px;
    display: inline-block;
    font-weight: bold;
  `;

  if (type === "email_verification") {
    return {
      subject: "Confirm your email - PadelTrainer",
      html: `
        <div style="${baseStyle}">
          ${EMAIL_LOGO}
          
          <h2 style="color: #333;">Confirm your email address</h2>
          
          <p>Hi${data.userName ? ` ${data.userName}` : ''},</p>
          
          <p>Thanks for signing up for PadelTrainer! Please confirm your email address by clicking the button below:</p>
          
          <p style="text-align: center; margin: 30px 0;">
            <a href="${data.actionLink}" style="${buttonStyle}">Confirm Email</a>
          </p>
          
          <p style="color: #666; font-size: 14px;">
            If you didn't create an account with PadelTrainer, you can safely ignore this email.
          </p>
          
          <p style="color: #666; font-size: 14px;">
            Or copy and paste this link into your browser:<br>
            <a href="${data.actionLink}" style="color: ${BRAND_ORANGE}; word-break: break-all;">${data.actionLink}</a>
          </p>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
          
          <p style="color: #999; font-size: 12px; text-align: center;">
            © ${new Date().getFullYear()} PadelTrainer.ai - Find your perfect padel trainer
          </p>
        </div>
      `,
    };
  }

  if (type === "password_reset") {
    return {
      subject: "Reset your password - PadelTrainer",
      html: `
        <div style="${baseStyle}">
          ${EMAIL_LOGO}
          
          <h2 style="color: #333;">Reset your password</h2>
          
          <p>Hi${data.userName ? ` ${data.userName}` : ''},</p>
          
          <p>We received a request to reset your password. Click the button below to choose a new password:</p>
          
          <p style="text-align: center; margin: 30px 0;">
            <a href="${data.actionLink}" style="${buttonStyle}">Reset Password</a>
          </p>
          
          <p style="color: #666; font-size: 14px;">
            This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.
          </p>
          
          <p style="color: #666; font-size: 14px;">
            Or copy and paste this link into your browser:<br>
            <a href="${data.actionLink}" style="color: ${BRAND_ORANGE}; word-break: break-all;">${data.actionLink}</a>
          </p>
          
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
          
          <p style="color: #999; font-size: 12px; text-align: center;">
            © ${new Date().getFullYear()} PadelTrainer.ai - Find your perfect padel trainer
          </p>
        </div>
      `,
    };
  }

  throw new Error(`Unknown email type: ${type}`);
};

/**
 * Best-effort per-key throttle on the shared rate_limits table. Returns true
 * when the call is allowed (under `max` within `windowMin`), false otherwise.
 * Fails OPEN on storage errors so a transient DB hiccup never blocks a real
 * password reset — the recipient cap is the load-bearing anti-abuse guard.
 */
async function throttle(
  admin: SupabaseClient,
  identifier: string,
  max: number,
  windowMin: number,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMin * 60 * 1000);
  try {
    const { data: existing } = await admin
      .from("rate_limits")
      .select("id, request_count, window_start")
      .eq("identifier", identifier)
      .eq("endpoint", "send-auth-email")
      .maybeSingle();

    if (existing && new Date(existing.window_start) > windowStart) {
      if (existing.request_count >= max) return false;
      await admin
        .from("rate_limits")
        .update({ request_count: existing.request_count + 1 })
        .eq("id", existing.id);
      return true;
    }

    await admin
      .from("rate_limits")
      .upsert(
        { identifier, endpoint: "send-auth-email", request_count: 1, window_start: new Date().toISOString() },
        { onConflict: "identifier,endpoint" },
      );
    return true;
  } catch (_err) {
    return true; // fail open
  }
}

const handler = async (req: Request): Promise<Response> => {
  // E-25: origin allow-list (defense in depth on this email-driving endpoint).
  const corsHeaders = corsHeadersFor(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY not configured");
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Supabase credentials not configured");
    }

    const { type, email, redirectTo }: AuthEmailRequest = await req.json();

    if (!type || !email) {
      throw new Error("Missing required fields: type and email");
    }

    // Create Supabase admin client
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Anti-abuse: this endpoint is unauthenticated (legit caller is the
    // anonymous SPA at password-reset / verification time) and drives the admin
    // generateLink API, which bypasses GoTrue's own throttle. Cap by RECIPIENT
    // (stops bombing one inbox) and by IP (raises spray cost). 429 on either.
    const emailKey = String(email).trim().toLowerCase();
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") || "unknown";
    const recipientOk = await throttle(supabaseAdmin, `recipient:${emailKey}`, 5, 60);
    const ipOk = await throttle(supabaseAdmin, `ip:${clientIp}`, 30, 60);
    if (!recipientOk || !ipOk) {
      return new Response(
        JSON.stringify({ error: "Too many requests. Please try again later." }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "3600", ...corsHeaders } },
      );
    }

    // Get user name from profiles if available
    let userName: string | undefined;
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("full_name")
      .eq("email", email)
      .single();
    
    if (profile?.full_name) {
      userName = profile.full_name;
    }

    const origin = req.headers.get("origin") || "https://padeltrainer.ai";
    const defaultAuthPath = `${origin}/app/auth`;
    const defaultResetPath = `${origin}/app/reset-password`;

    // Generate the appropriate link using Supabase Admin API
    let actionLink: string;
    
    if (type === "email_verification") {
      // Use magiclink type for email verification (doesn't require password)
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: {
          redirectTo: redirectTo || defaultAuthPath,
        },
      });

      if (error) {
        console.error("Error generating verification link:", error);
        throw new Error(`Failed to generate verification link: ${error.message}`);
      }

      actionLink = data.properties.action_link;
    } else if (type === "password_reset") {
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: "recovery",
        email,
        options: {
          redirectTo: redirectTo || defaultResetPath,
        },
      });

      if (error) {
        console.error("Error generating reset link:", error);
        throw new Error(`Failed to generate reset link: ${error.message}`);
      }

      actionLink = data.properties.action_link;
    } else {
      throw new Error(`Invalid email type: ${type}`);
    }

    // Get email template
    const emailContent = getEmailTemplate(type, { userName, actionLink });

    const sendResult = await sendResendEmail(RESEND_API_KEY, {
      from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
      to: [email],
      subject: emailContent.subject,
      html: emailContent.html,
    });

    if (!sendResult.ok) {
      console.error("Resend send failed:", sendResult.error, { attempts: sendResult.attempts });
      throw new Error(`Failed to send email: ${sendResult.error}`);
    }

    console.log(`Auth email sent successfully: ${type}`, { attempts: sendResult.attempts });

    return new Response(JSON.stringify({ success: true, messageId: sendResult.id }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in send-auth-email function:", error);
    // Auth-critical: a send failure means users can't sign up / reset passwords. Alert ops.
    await notifySlackEdgeError("send-auth-email", error?.message ?? String(error));
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
