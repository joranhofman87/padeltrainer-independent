import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@18.5.0";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface SignupRequest {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  redirectTo?: string;
}

const EMAIL_LOGO = `<div style="text-align: center; margin-bottom: 24px;"><img src="https://padeltrainer.ai/logo-dark.png" alt="PadelTrainer.ai" width="220" height="40" style="max-width: 220px; height: auto;" /></div>`;
const BRAND_ORANGE = "#f45d25";

const getEmailTemplate = (userName: string, actionLink: string) => {
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

  return {
    subject: "Welcome to PadelTrainer! 🎾",
    html: `
      <div style="${baseStyle}">
        ${EMAIL_LOGO}
        
        <h2 style="color: #333;">Welcome to PadelTrainer!</h2>
        
        <p>Hi${userName ? ` ${userName}` : ''},</p>
        
        <p>Thanks for signing up! Your account is ready and you can start setting up your trainer profile right away.</p>
        
        <p style="text-align: center; margin: 30px 0;">
          <a href="${actionLink}" style="${buttonStyle}">Go to PadelTrainer</a>
        </p>
        
        <p style="color: #666; font-size: 14px;">
          If you didn't create an account with PadelTrainer, you can safely ignore this email.
        </p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        
        <p style="color: #999; font-size: 12px; text-align: center;">
          © ${new Date().getFullYear()} PadelTrainer.ai - Find your perfect padel trainer
        </p>
      </div>
    `,
  };
};

const checkRateLimit = async (supabaseAdmin: any, ip: string): Promise<boolean> => {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const identifier = `signup:${ip}`;
  const maxRequests = 5;

  const { count } = await supabaseAdmin
    .from('rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('identifier', identifier)
    .gte('created_at', windowStart);

  if ((count ?? 0) >= maxRequests) {
    return false;
  }

  await supabaseAdmin
    .from('rate_limits')
    .insert({ identifier, endpoint: 'signup-user' });

  return true;
};

const createStripeCustomer = async (email: string, fullName: string, userId: string): Promise<string | null> => {
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    console.error("[SIGNUP] STRIPE_SECRET_KEY not set, skipping Stripe customer creation");
    return null;
  }

  try {
    const stripe = new Stripe(stripeKey, { apiVersion: "2025-08-27.basil" });
    
    // Check if customer already exists
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      console.log(`[SIGNUP] Existing Stripe customer found: ${existing.data[0].id}`);
      return existing.data[0].id;
    }

    const customer = await stripe.customers.create({
      email,
      name: fullName,
      metadata: { user_id: userId },
    });
    console.log(`[SIGNUP] Stripe customer created: ${customer.id}`);
    return customer.id;
  } catch (err) {
    console.error("[SIGNUP] Failed to create Stripe customer (non-fatal):", err);
    return null;
  }
};

const handler = async (req: Request): Promise<Response> => {
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

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Rate limiting by IP
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || 
               req.headers.get("cf-connecting-ip") || 
               "unknown";
    
    const allowed = await checkRateLimit(supabaseAdmin, ip);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Too many signup attempts. Please try again later." }),
        { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const { email, password, fullName, phone, redirectTo, language, role: signupRole, timezone }: SignupRequest & { language?: string; role?: string; timezone?: string } = await req.json();

    if (!email || !password || !fullName) {
      throw new Error("Missing required fields: email, password, fullName");
    }

    // Allowlist signup roles — never accept 'admin' or arbitrary enum values from the client
    const ALLOWED_SIGNUP_ROLES = ['player', 'trainer', 'club', 'academy'] as const;
    if (signupRole !== undefined && signupRole !== null && !ALLOWED_SIGNUP_ROLES.includes(signupRole as typeof ALLOWED_SIGNUP_ROLES[number])) {
      return new Response(
        JSON.stringify({ error: "Invalid role" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Check if user already exists
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());
    
    if (existingUser) {
      return new Response(
        JSON.stringify({ error: "User already registered" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Create user using Admin API
    const { data: userData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName,
        phone: phone,
      },
    });

    if (createError) {
      console.error("Error creating user:", createError);
      throw new Error(createError.message);
    }

    const user = userData.user;
    console.log(`User created: ${user.id}`);

    // Create Stripe customer and store ID
    const stripeCustomerId = await createStripeCustomer(email, fullName, user.id);

    // Update profile with phone, language, timezone, and Stripe customer ID
    const updates: Record<string, string> = {};
    if (phone) updates.phone = phone;
    if (language) updates.preferred_language = language;
    if (timezone) updates.timezone = timezone;
    if (stripeCustomerId) updates.stripe_customer_id = stripeCustomerId;
    
    if (Object.keys(updates).length > 0) {
      await supabaseAdmin
        .from('profiles')
        .update(updates)
        .eq('user_id', user.id);
    }

    // Assign role server-side if provided (closes the gap when frontend onboarding is skipped)
    if (signupRole) {
      await supabaseAdmin
        .from('user_roles')
        .upsert({ user_id: user.id, role: signupRole }, { onConflict: 'user_id,role' });

      // Trial trainer profile for server-assigned trainer signups (idempotent)
      if (signupRole === 'trainer') {
        const { data: existingTrainerProfile } = await supabaseAdmin
          .from('trainer_profiles')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();

        if (!existingTrainerProfile) {
          const now = new Date();
          const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
          const tz = timezone || 'Europe/Amsterdam';
          const { error: trainerProfileError } = await supabaseAdmin.from('trainer_profiles').insert({
            user_id: user.id,
            trial_started_at: now.toISOString(),
            trial_ends_at: trialEnd.toISOString(),
            subscription_status: 'trial',
            is_public: false,
            timezone: tz,
          });
          if (trainerProfileError) {
            console.error('[SIGNUP] Failed to create trainer profile (non-fatal):', trainerProfileError);
          }
        }
      }
    }

    // Generate a welcome link
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: {
        redirectTo: redirectTo || "https://padeltrainer.ai/app/auth",
      },
    });

    if (linkError) {
      console.error("Error generating welcome link:", linkError);
    }

    const actionLink = linkData?.properties?.action_link || redirectTo || "https://padeltrainer.ai/app/auth";

    // Send custom branded welcome email via Resend
    const emailContent = getEmailTemplate(fullName, actionLink);
    
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
    } else {
      console.log(`Welcome email sent to ${email}`);
    }

    // Send Slack notification (non-blocking)
    try {
      await supabaseAdmin.functions.invoke('slack-notify', {
        body: {
          event: 'new_signup',
          data: { name: fullName, email, role: signupRole || 'Unknown' },
        },
      });
    } catch (slackErr) {
      console.error("Slack notification failed (non-fatal):", slackErr);
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        user: { 
          id: user.id, 
          email: user.email,
          email_confirmed_at: user.email_confirmed_at,
        } 
      }),
      { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  } catch (error: any) {
    console.error("Error in signup-user function:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
};

serve(handler);
