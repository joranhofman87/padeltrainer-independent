/** Auth helpers for forward-invoice (service-role internal + user UI calls). */

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonUnauthorized, type AuthedUser } from "./auth.ts";
import {
  buildServiceRoleAuthDebug,
  extractBearerToken,
  getEnvServiceRoleKey,
  isServiceRoleRequest,
  resolveServiceRoleToken,
} from "./service-role-auth.ts";

export type ForwardInvoiceAuthMode = "service_role" | "user" | "denied";

export type ForwardInvoiceAuthResult =
  | { ok: true; auth: AuthedUser; authMode: "service_role" | "user" }
  | { ok: false; response: Response; authMode: "denied"; status: number };

function getServiceClientWithKey(serviceRoleKey: string): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceRoleKey,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export function logForwardInvoiceAuthDebug(req: Request): void {
  console.log("[FORWARD-INVOICE] auth_debug", JSON.stringify(buildServiceRoleAuthDebug(req)));
}

export async function authenticateForwardInvoice(req: Request): Promise<ForwardInvoiceAuthResult> {
  logForwardInvoiceAuthDebug(req);

  if (isServiceRoleRequest(req)) {
    const serviceRoleKey = resolveServiceRoleToken(req);
    if (!serviceRoleKey) {
      return {
        ok: false,
        response: jsonUnauthorized("Service role key not configured"),
        authMode: "denied",
        status: 401,
      };
    }
    return {
      ok: true,
      auth: {
        user: { id: "service-role" },
        supabase: getServiceClientWithKey(serviceRoleKey),
        isServiceRole: true,
      },
      authMode: "service_role",
    };
  }

  const authHeader = req.headers.get("Authorization");
  const bearerToken = extractBearerToken(authHeader);
  if (!bearerToken) {
    return {
      ok: false,
      response: jsonUnauthorized(),
      authMode: "denied",
      status: 401,
    };
  }

  const envKey = getEnvServiceRoleKey();
  if (!envKey) {
    return {
      ok: false,
      response: jsonUnauthorized("Service role key not configured"),
      authMode: "denied",
      status: 401,
    };
  }

  const supabase = getServiceClientWithKey(envKey);
  const { data, error } = await supabase.auth.getUser(bearerToken);
  if (error || !data?.user) {
    return {
      ok: false,
      response: jsonUnauthorized(),
      authMode: "denied",
      status: 401,
    };
  }

  return {
    ok: true,
    auth: {
      user: { id: data.user.id, email: data.user.email },
      supabase,
      isServiceRole: false,
    },
    authMode: "user",
  };
}
