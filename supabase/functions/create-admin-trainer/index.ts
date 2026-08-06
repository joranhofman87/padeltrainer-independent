import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { restrictedCors } from "../_shared/cors.ts";
import { PublicError, publicErrorMessage } from "../_shared/public-error.ts";

Deno.serve(async (req) => {
  const corsHeaders = restrictedCors(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Get the user's JWT from the request
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create client with user's token to check permissions
    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Verify the user is authenticated
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if user is an admin via is_admin() function
    const { data: isAdmin } = await supabaseUser.rpc("is_admin", {
      _user_id: user.id,
    });

    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Only administrators can create trainers" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse the request body
    const { 
      email, 
      fullName, 
      phone, 
      subscriptionStatus = "trial", 
      isPublic = false 
    } = await req.json();

    // Trim and normalize email
    const normalizedEmail = email?.trim().toLowerCase();

    if (!normalizedEmail || !fullName) {
      return new Response(JSON.stringify({ error: "Email and full name are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate email format before sending to Supabase
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return new Response(JSON.stringify({ error: "Invalid email format. Please use a valid email address (e.g., name@example.com)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create admin client for privileged operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Check if user with this email already exists
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email?.toLowerCase() === normalizedEmail);

    let trainerId: string;
    let temporaryPassword: string | null = null;
    let isNewUser = false;

    if (existingUser) {
      // Check if they already have a trainer profile
      const { data: existingProfile } = await supabaseAdmin
        .from("trainer_profiles")
        .select("id")
        .eq("user_id", existingUser.id)
        .single();

      if (existingProfile) {
        // Trainer profile already exists
        return new Response(JSON.stringify({ 
          error: "A trainer profile already exists for this email address" 
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Create trainer profile for existing user
      // First add trainer role (ignore conflict if already exists)
      await supabaseAdmin.from("user_roles").upsert({
        user_id: existingUser.id,
        role: "trainer",
      }, { onConflict: "user_id,role" });

      // Calculate trial dates
      const now = new Date();
      const trialEndsAt = new Date(now);
      trialEndsAt.setDate(trialEndsAt.getDate() + 7);

      const { data: newProfile, error: profileError } = await supabaseAdmin
        .from("trainer_profiles")
        .insert({ 
          user_id: existingUser.id,
          subscription_status: subscriptionStatus,
          trial_ends_at: subscriptionStatus === "trial" ? trialEndsAt.toISOString() : null,
          is_public: isPublic,
        })
        .select("id")
        .single();

      if (profileError) {
        console.error("Failed to create trainer profile:", profileError);
        throw new PublicError("Failed to create trainer profile");
      }
      trainerId = newProfile.id;
      isNewUser = false;
    } else {
      // Create new user account with temporary password
      temporaryPassword = generatePassword();
      isNewUser = true;

      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email: normalizedEmail,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });

      if (createError) {
        console.error("Failed to create user:", createError);
        throw new PublicError("Failed to create user account");
      }

      // Update their profile with name and phone
      await supabaseAdmin
        .from("profiles")
        .update({ full_name: fullName, phone: phone || null })
        .eq("user_id", newUser.user.id);

      // Add trainer role
      await supabaseAdmin.from("user_roles").insert({
        user_id: newUser.user.id,
        role: "trainer",
      });

      // Calculate trial dates
      const now = new Date();
      const trialEndsAt = new Date(now);
      trialEndsAt.setDate(trialEndsAt.getDate() + 7);

      // Create trainer profile
      const { data: newProfile, error: profileError } = await supabaseAdmin
        .from("trainer_profiles")
        .insert({ 
          user_id: newUser.user.id,
          subscription_status: subscriptionStatus,
          trial_ends_at: subscriptionStatus === "trial" ? trialEndsAt.toISOString() : null,
          is_public: isPublic,
        })
        .select("id")
        .single();

      if (profileError) {
        console.error("Failed to create trainer profile:", profileError);
        throw new PublicError("Failed to create trainer profile");
      }
      trainerId = newProfile.id;
    }

    return new Response(
      JSON.stringify({
        success: true,
        trainerId,
        temporaryPassword,
        isNewUser,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    // Full DB/auth detail stays in logs; the response only carries a
    // PublicError message or the generic fallback.
    console.error("Error creating admin trainer:", error);
    return new Response(
      JSON.stringify({ error: publicErrorMessage(error, "Internal server error") }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => chars[b % chars.length]).join("");
}
