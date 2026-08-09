import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";
import { resolveRegistrationNameFields } from "../_shared/profileName.ts";
import { evaluateManualPlayerAccess } from "../_shared/manual-player-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/**
 * The command refuses with a stable `PLAYER_CREATE_*` code and a SQLSTATE. Both are translated
 * here: the SQLSTATE picks the HTTP status, the code travels to the client so a UI can say
 * something specific. The raw message never does — it is written for an operator reading logs.
 */
function commandFailure(error: { code?: string; message?: string }): Response {
  const code = (error.message ?? "").match(/PLAYER_CREATE_[A-Z_]+/)?.[0] ?? "PLAYER_CREATE_FAILED";
  const status = error.code === "42501"
    ? 403
    : error.code === "22023"
    ? 400
    : error.code === "23505"
    ? 409
    : 500;
  return json({ error: code, code }, status);
}

/**
 * Exported so the authorization and routing decisions can be driven by tests against the REAL
 * handler. A source-grep proved nothing: it passed while an academy manager was refused at the gate
 * and never reached the RPC at all.
 */
export async function handleRequest(
  req: Request,
  deps: { userClient?: SupabaseClient; adminClient?: SupabaseClient } = {},
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "http://localhost";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "anon";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "service";

    // Verify caller is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const supabaseUser = deps.userClient ?? createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseUser.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return json({ error: "Unauthorized" }, 401);
    }

    const userId = claimsData.claims.sub;

    const {
      email,
      firstName,
      lastName,
      fullName,
      phone,
      ratingSystem,
      rating,
      birthDate,
      cycleName,
      academyProfileId,
      trainerProfileId,
      creationRequestId,
      selectPersonId,
    } = await req.json();

    // Who may be here at all. An academy manager who manages no club and is not a trainer was
    // refused outright — which made the academy path this function now routes through unreachable
    // for exactly the role it exists for. Supplying an academy scope admits them to the gate; it
    // does NOT admit them to that academy, which the per-academy check below still decides.
    const { data: isClubManager } = await supabaseUser.rpc("is_any_club_manager", { _user_id: userId });
    const { data: isTrainer } = await supabaseUser.rpc("is_trainer", { _user_id: userId });

    let gateAcademyManager = false;
    if (academyProfileId) {
      const { data: mgr } = await supabaseUser.rpc("is_academy_manager", {
        _user_id: userId,
        _academy_profile_id: academyProfileId,
      });
      const { data: own } = await supabaseUser.rpc("is_academy_owner", {
        _user_id: userId,
        _academy_profile_id: academyProfileId,
      });
      gateAcademyManager = !!mgr || !!own;
    }

    if (!isClubManager && !isTrainer && !gateAcademyManager) {
      return json(
        { error: "Only club managers, trainers or academy managers can create manual player registrations" },
        403,
      );
    }

    // Non-string name/email fields would reach .trim()/.toLowerCase() and throw a raw 500.
    const stringFields: Record<string, unknown> = { email, firstName, lastName, fullName, birthDate };
    for (const [field, value] of Object.entries(stringFields)) {
      if (value != null && typeof value !== "string") {
        return json({ error: `Field '${field}' must be a string` }, 400);
      }
    }
    if (rating != null && typeof rating !== "number") {
      return json({ error: "Field 'rating' must be a number" }, 400);
    }

    // Every create is idempotent on the caller's own id for THIS attempt. Without one a retry —
    // a double click, a network replay, a lost response — makes a second Player, and no attribute
    // of a person may be used to notice that. So there is no path without it. Shape-checked here
    // rather than left to the uuid cast, so a malformed id is a refusal and not a 500.
    if (typeof creationRequestId !== "string" || !UUID_RE.test(creationRequestId)) {
      return json(
        { error: "creationRequestId must be a uuid, so a retry does not create a second player" },
        400,
      );
    }
    if (selectPersonId != null && (typeof selectPersonId !== "string" || !UUID_RE.test(selectPersonId))) {
      return json({ error: "selectPersonId must be a uuid" }, 400);
    }

    if (academyProfileId && trainerProfileId) {
      // A Player belongs to one scope. Picking one silently would attach it somewhere the caller
      // did not ask for.
      return json({ error: "Give either an academy or a trainer, not both" }, 400);
    }

    // ...and it belongs to ONE of them. `guest_players` has carried a CHECK requiring a trainer or
    // an academy since 2026-02, so a create with neither has never actually worked — it inserted,
    // violated the constraint, and came back as an opaque 500. It is refused here instead, with the
    // reason. (Nothing else changes: the shape that produces it is a club-owned registration form,
    // for which this schema has no Player to create — see the U2 notes.)
    if (!academyProfileId && !trainerProfileId) {
      return json(
        { error: "A player belongs to an academy or a trainer; this request named neither", code: "PLAYER_CREATE_BAD_SCOPE" },
        400,
      );
    }

    const nameFields = resolveRegistrationNameFields({ firstName, lastName, fullName });

    // A name, and NOT an email. Plenty of real players — children, walk-ins, people who simply do
    // not want to give one — have no address, and refusing them here is what pushed staff into
    // inventing placeholder addresses that then look like a shared household email to every
    // matcher downstream. (`selectPersonId` names an existing Player, which needs no name at all.)
    if (!nameFields.full_name && !selectPersonId) {
      return json({ error: "A name is required" }, 400);
    }

    const supabaseAdmin = deps.adminClient ?? createClient(supabaseUrl, supabaseServiceKey);

    // Authorization: if the caller attaches the player to a specific academy or trainer, verify
    // they control that context. Without this, any trainer or club manager could inject guest
    // players into academies/trainers they do not own. The command re-decides this in the database
    // — this gate exists to fail fast and to answer with a useful message — so both sides ask the
    // same question: manager OR owner, matching `player_owner_may_create`. Asking only about
    // managers here while the command accepts owners would refuse a caller the command would serve.
    const managesAcademy = academyProfileId ? gateAcademyManager : false;

    let controlsTrainer = false;
    if (trainerProfileId) {
      const { data: ownTrainer } = await supabaseAdmin
        .from("trainer_profiles")
        .select("id")
        .eq("id", trainerProfileId)
        .eq("user_id", userId)
        .maybeSingle();
      if (ownTrainer) {
        controlsTrainer = true;
      } else {
        // Or the caller manages/owns an academy this trainer belongs to.
        const { data: links } = await supabaseAdmin
          .from("academy_trainers")
          .select("academy_profile_id")
          .eq("trainer_profile_id", trainerProfileId);
        for (const link of links || []) {
          const { data: manages } = await supabaseUser.rpc("is_academy_manager", {
            _user_id: userId,
            _academy_profile_id: link.academy_profile_id,
          });
          const { data: owns } = await supabaseUser.rpc("is_academy_owner", {
            _user_id: userId,
            _academy_profile_id: link.academy_profile_id,
          });
          if (manages || owns) {
            controlsTrainer = true;
            break;
          }
        }
      }
    }

    const access = evaluateManualPlayerAccess({
      academyProfileId,
      trainerProfileId,
      managesAcademy,
      controlsTrainer,
    });
    if (!access.ok) {
      return json({ error: "You do not control the target academy or trainer" }, 403);
    }

    // ONE command, for every scope. This function used to resolve the Player itself: it looked an
    // address up in `profiles`, and if a row came back whose name agreed it attached the
    // registration to that account and never called the command at all. That is identity decided by
    // two mutable attributes — the decision U2 removed from the database, still being made one
    // layer above it. There is no lookup here now. A Player the operator already knows is named by
    // `selectPersonId`, which the command authorizes against the scope; anyone else is created, and
    // a create that looks like an existing Player files a proposal for a human rather than
    // resolving itself.
    const ownerType = academyProfileId ? "academy" : "trainer";
    const ownerId = academyProfileId ?? trainerProfileId;

    const { data: viaRpc, error: rpcError } = await supabaseAdmin.rpc("player_create_command", {
      // the caller's own id for THIS create attempt, forwarded unchanged: a retry carries the
      // same one and gets the same Player back rather than a second one
      _creation_request_id: creationRequestId,
      _owner_type: ownerType,
      _owner_id: ownerId,
      _full_name: nameFields.full_name || null,
      _email: email ? email.toLowerCase() : null,
      _phone: phone || null,
      _first_name: nameFields.first_name || null,
      _last_name: nameFields.last_name || null,
      _skill_rating: rating ?? null,
      _rating_system: ratingSystem || null,
      _birth_date: birthDate || null,
      _source: "manual_registration",
      _select_person_id: selectPersonId || null,
      _actor_user_id: userId,
      _origin: "operator",
    });
    if (rpcError) {
      console.error("create-manual-player: player_create_command failed", rpcError.code, rpcError.message);
      return commandFailure(rpcError);
    }

    const result = viaRpc as {
      person_id: string;
      guest_player_id: string | null;
      created: boolean;
      replayed: boolean;
    };

    // Send confirmation email to the player — when there is somewhere to send it. A Player with no
    // address is a supported Player, not a failed one.
    if (email) {
      try {
        await supabaseAdmin.functions.invoke("send-email", {
          body: {
            type: "intake_registration_confirmation",
            to: email,
            data: {
              playerName: nameFields.full_name,
              cycleName: cycleName || "",
              isNewUser: result.created,
            },
          },
        });
      } catch (emailError) {
        console.error("Failed to send confirmation email:", emailError);
      }
    }

    return json({
      // the canonical Player identity — the answer callers should key on. `guestPlayerId` stays
      // for the readers that still key on the source row.
      personId: result.person_id,
      guestPlayerId: result.guest_player_id,
      created: result.created,
      replayed: result.replayed,
      isNewUser: result.created,
    });
  } catch (error: unknown) {
    console.error("Error in create-manual-player:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return json({ error: message }, 500);
  }
}

// Only bind a port when run as the entrypoint — importing for tests must not serve.
if (import.meta.main) serve((req) => handleRequest(req));
