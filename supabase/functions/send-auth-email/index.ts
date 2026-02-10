import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AuthEmailRequest {
  type: "email_verification" | "password_reset";
  email: string;
  redirectTo?: string;
}

const getEmailTemplate = (type: string, data: { userName?: string; actionLink: string }) => {
  const baseStyle = `
    font-family: Arial, sans-serif;
    max-width: 600px;
    margin: 0 auto;
    padding: 20px;
  `;
  
  const buttonStyle = `
    background: #16a34a;
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
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #16a34a; margin: 0;">PadelTrainer<span style="color: #333;">.ai</span></h1>
          </div>
          
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
            <a href="${data.actionLink}" style="color: #16a34a; word-break: break-all;">${data.actionLink}</a>
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
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #16a34a; margin: 0;">PadelTrainer<span style="color: #333;">.ai</span></h1>
          </div>
          
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
            <a href="${data.actionLink}" style="color: #16a34a; word-break: break-all;">${data.actionLink}</a>
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

const handler = async (req: Request): Promise<Response> => {
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

    // Generate the appropriate link using Supabase Admin API
    let actionLink: string;
    
    if (type === "email_verification") {
      // Use magiclink type for email verification (doesn't require password)
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email,
        options: {
          redirectTo: redirectTo || `${req.headers.get("origin") || "https://padeltrainer.ai"}/auth`,
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
          redirectTo: redirectTo || `${req.headers.get("origin") || "https://padeltrainer.ai"}/reset-password`,
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

    // Send email via Resend
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "PadelTrainer.ai <noreply@app.padeltrainer.ai>",
        to: [email],
        subject: emailContent.subject,
        html: emailContent.html,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("Resend API error:", errorText);
      throw new Error(`Failed to send email: ${errorText}`);
    }

    const result = await res.json();
    console.log(`Auth email sent successfully: ${type} to ${email}`);

    return new Response(JSON.stringify({ success: true, messageId: result.id }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error in send-auth-email function:", error);
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
