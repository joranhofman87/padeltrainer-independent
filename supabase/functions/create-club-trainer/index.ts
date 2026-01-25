import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
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

    // Verify the user is authenticated and is a club manager
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if user is a club manager
    const { data: isManager } = await supabaseUser.rpc("is_any_club_manager", {
      _user_id: user.id,
    });

    if (!isManager) {
      return new Response(JSON.stringify({ error: "Only club managers can create trainers" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse the request body
    const { email, fullName, phone, clubProfileId, locationId } = await req.json();

    if (!email || !fullName || !clubProfileId || !locationId) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create admin client for privileged operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Check if user with this email already exists
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email === email);

    let trainerId: string;
    let temporaryPassword: string | null = null;

    if (existingUser) {
      // Check if they already have a trainer profile
      const { data: existingProfile } = await supabaseAdmin
        .from("trainer_profiles")
        .select("id")
        .eq("user_id", existingUser.id)
        .single();

      if (existingProfile) {
        // Just link them to the club location
        trainerId = existingProfile.id;
      } else {
        // Create trainer profile for existing user
        // First add trainer role
        await supabaseAdmin.from("user_roles").insert({
          user_id: existingUser.id,
          role: "trainer",
        });

        const { data: newProfile, error: profileError } = await supabaseAdmin
          .from("trainer_profiles")
          .insert({ user_id: existingUser.id })
          .select("id")
          .single();

        if (profileError) {
          throw new Error(`Failed to create trainer profile: ${profileError.message}`);
        }
        trainerId = newProfile.id;
      }
    } else {
      // Create new user account with temporary password
      temporaryPassword = generatePassword();

      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });

      if (createError) {
        throw new Error(`Failed to create user: ${createError.message}`);
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

      // Create trainer profile
      const { data: newProfile, error: profileError } = await supabaseAdmin
        .from("trainer_profiles")
        .insert({ user_id: newUser.user.id })
        .select("id")
        .single();

      if (profileError) {
        throw new Error(`Failed to create trainer profile: ${profileError.message}`);
      }
      trainerId = newProfile.id;
    }

    // Link trainer to the club's location
    const { error: locationError } = await supabaseAdmin
      .from("trainer_locations")
      .upsert({
        trainer_id: trainerId,
        location_id: locationId,
        relationship_type: "club_trainer",
        is_primary: false,
      }, {
        onConflict: "trainer_id,location_id",
      });

    if (locationError) {
      console.error("Location link error:", locationError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        trainerId,
        temporaryPassword,
        isNewUser: !existingUser,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error creating club trainer:", error);
    const errorMessage = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  let password = "";
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}
