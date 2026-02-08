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

interface SignupRequest {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  redirectTo?: string;
}

const getEmailTemplate = (userName: string, actionLink: string) => {
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

  return {
    subject: "Welcome to PadelTrainer! 🎾",
    html: `
      <div style="${baseStyle}">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #16a34a; margin: 0;">PadelTrainer<span style="color: #333;">.ai</span></h1>
        </div>
        
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

    const { email, password, fullName, phone, redirectTo }: SignupRequest = await req.json();

    if (!email || !password || !fullName) {
      throw new Error("Missing required fields: email, password, fullName");
    }

    // Create Supabase admin client
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Check if user already exists
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());
    
    if (existingUser) {
      return new Response(
        JSON.stringify({ error: "User already registered" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Create user using Admin API (does NOT send automatic email)
    const { data: userData, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm so trainer can proceed to onboarding immediately
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

    // Update profile with phone if provided
    if (phone && user) {
      await supabaseAdmin
        .from('profiles')
        .update({ phone })
        .eq('user_id', user.id);
    }

    // Generate a welcome link (magiclink type since user is already confirmed)
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: {
        redirectTo: redirectTo || "https://padeltrainer.ai/app/auth",
      },
    });

    if (linkError) {
      console.error("Error generating welcome link:", linkError);
      // Don't fail signup if welcome link generation fails
      console.error("Failed to generate welcome link, but user was created");
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
        from: "PadelTrainer.ai <noreply@padeltrainer.ai>",
        to: [email],
        subject: emailContent.subject,
        html: emailContent.html,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("Resend API error:", errorText);
      console.error("Failed to send welcome email, but user was created");
    } else {
      console.log(`Welcome email sent to ${email}`);
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
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (error: any) {
    console.error("Error in signup-user function:", error);
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
