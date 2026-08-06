import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

export function buildFullName(first?: string, last?: string): string {
  return [first?.trim(), last?.trim()].filter(Boolean).join(" ");
}

export function resolveProfileNames(input: {
  firstName?: string;
  lastName?: string;
  fullName?: string;
}): { firstName: string; lastName: string | null; fullName: string } {
  let firstName = input.firstName?.trim() ?? "";
  let lastName = input.lastName?.trim() ?? "";
  let fullName = input.fullName?.trim() ?? "";

  if (firstName && lastName) {
    fullName = fullName || buildFullName(firstName, lastName);
  } else if (fullName) {
    const parts = fullName.split(/\s+/).filter(Boolean);
    if (!firstName && parts[0]) firstName = parts[0];
    if (!lastName && parts.length > 1) lastName = parts.slice(1).join(" ");
  }

  if (!fullName || !firstName) {
    throw new Error(
      "Missing required fields: email, password, and name (firstName/lastName or fullName)",
    );
  }

  return {
    firstName,
    lastName: lastName || null,
    fullName,
  };
}

/** Profiles table patch — excludes timezone (trainer_profiles only). */
export function buildProfileNamePatch(args: {
  firstName: string;
  lastName: string | null;
  fullName: string;
  phone?: string;
  language?: string;
  stripeCustomerId?: string | null;
}): Record<string, string | null> {
  const patch: Record<string, string | null> = {
    first_name: args.firstName,
    last_name: args.lastName,
    full_name: args.fullName,
  };
  if (args.phone) patch.phone = args.phone;
  if (args.language) patch.preferred_language = args.language;
  if (args.stripeCustomerId) patch.stripe_customer_id = args.stripeCustomerId;
  return patch;
}

function logPostgrestError(
  message: string,
  context: Record<string, unknown>,
  error: { code?: string; message?: string; details?: string; hint?: string },
) {
  console.error(message, {
    ...context,
    code: error.code,
    supabaseMessage: error.message,
    details: error.details,
    hint: error.hint,
  });
}

const PROFILE_SYNC_ATTEMPTS = 8;
const PROFILE_SYNC_DELAY_MS = 75;

/**
 * Wait for handle_new_user row, then update names. Upsert if row still missing after retries.
 */
export async function syncProfileNamesAfterSignup(
  supabaseAdmin: SupabaseClient,
  userId: string,
  email: string,
  patch: Record<string, string | null>,
): Promise<void> {
  for (let attempt = 1; attempt <= PROFILE_SYNC_ATTEMPTS; attempt++) {
    const { data: existing, error: selectError } = await supabaseAdmin
      .from("profiles")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    if (selectError) {
      logPostgrestError("[SIGNUP] profiles select before name sync failed", { userId, attempt }, selectError);
      throw new Error(`Profile sync select failed: ${selectError.message}`);
    }

    if (existing) {
      const { data: updated, error: updateError } = await supabaseAdmin
        .from("profiles")
        .update(patch)
        .eq("user_id", userId)
        .select("id, first_name, last_name, full_name");

      if (updateError) {
        logPostgrestError(
          "[SIGNUP] profiles name sync update failed",
          { userId, attempt, patchKeys: Object.keys(patch) },
          updateError,
        );
        throw new Error(`Profile sync update failed: ${updateError.message}`);
      }

      if (updated && updated.length > 0) {
        console.log("[SIGNUP] profiles name sync ok", {
          userId,
          attempt,
          first_name: updated[0].first_name,
          last_name: updated[0].last_name,
          full_name: updated[0].full_name,
        });
        return;
      }

      console.warn("[SIGNUP] profiles update returned no rows", { userId, attempt });
    }

    if (attempt < PROFILE_SYNC_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, PROFILE_SYNC_DELAY_MS));
    }
  }

  const { data: upserted, error: upsertError } = await supabaseAdmin
    .from("profiles")
    .upsert(
      {
        user_id: userId,
        email,
        ...patch,
      },
      { onConflict: "user_id" },
    )
    .select("id, first_name, last_name, full_name");

  if (upsertError) {
    logPostgrestError("[SIGNUP] profiles name sync upsert failed", { userId, patchKeys: Object.keys(patch) }, upsertError);
    throw new Error(`Profile sync upsert failed: ${upsertError.message}`);
  }

  if (!upserted?.length) {
    throw new Error("Profile sync upsert succeeded but returned no row");
  }

  console.log("[SIGNUP] profiles name sync via upsert", {
    userId,
    first_name: upserted[0].first_name,
    last_name: upserted[0].last_name,
    full_name: upserted[0].full_name,
  });
}
