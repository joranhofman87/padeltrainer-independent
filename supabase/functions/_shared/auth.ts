// Shared auth helpers for edge functions.
// All functions in this project run with verify_jwt = false, so each one must
// validate identity in code. These helpers centralize that pattern.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { extractBearerToken, getEnvServiceRoleKey, isServiceRoleRequest } from "./service-role-auth.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** 401 for missing/invalid user session (not service-role). */
export function jsonUnauthorized(message = "Please log in again."): Response {
  return new Response(JSON.stringify({ error: "unauthorized", message }), {
    status: 401,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function jsonForbidden(message: string): Response {
  return new Response(JSON.stringify({ error: "forbidden", message }), {
    status: 403,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/**
 * Require the request to come from a service-role caller (cron jobs / server-to-server).
 * Returns null on success, or an error Response.
 */
export function requireServiceRole(req: Request): Response | null {
  if (isServiceRoleRequest(req)) {
    return null;
  }
  return jsonError(401, "Unauthorized");
}

export interface AuthedUser {
  user: { id: string; email?: string | null };
  supabase: SupabaseClient;
  isServiceRole: boolean;
}

/**
 * Require any authenticated user (or service-role key).
 * Returns the resolved user + a service-role supabase client, or an error Response.
 */
export async function requireUser(req: Request): Promise<AuthedUser | Response> {
  const serviceRoleKey = getEnvServiceRoleKey();
  const supabase = getServiceClient();

  if (isServiceRoleRequest(req)) {
    return { user: { id: "service-role" }, supabase, isServiceRole: true };
  }

  const bearerToken = extractBearerToken(req.headers.get("Authorization"));
  if (!bearerToken) {
    return jsonUnauthorized();
  }

  if (!serviceRoleKey) {
    return jsonUnauthorized("Service role key not configured");
  }

  const { data, error } = await supabase.auth.getUser(bearerToken);
  if (error || !data?.user) {
    return jsonUnauthorized();
  }
  return { user: { id: data.user.id, email: data.user.email }, supabase, isServiceRole: false };
}

/**
 * Require an admin caller (or service-role).
 */
export async function requireAdmin(req: Request): Promise<AuthedUser | Response> {
  const result = await requireUser(req);
  if (result instanceof Response) return result;
  if (result.isServiceRole) return result;

  const { data, error } = await result.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", result.user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (error || !data) {
    return jsonError(403, "Forbidden: admin access required");
  }
  return result;
}

/**
 * Require service-role bearer (cron / server-to-server) or an admin JWT.
 */
export async function requireServiceRoleOrAdmin(req: Request): Promise<AuthedUser | Response> {
  if (requireServiceRole(req) === null) {
    return {
      user: { id: "service-role" },
      supabase: getServiceClient(),
      isServiceRole: true,
    };
  }
  return await requireAdmin(req);
}
