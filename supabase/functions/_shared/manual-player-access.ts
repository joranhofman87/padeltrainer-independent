/**
 * Pure authorization decision for create-manual-player.
 *
 * The function accepts optional academyProfileId / trainerProfileId that attach
 * the created guest player to an academy or trainer. A caller (already known to
 * be a trainer or club manager) must only attach to a context they control,
 * otherwise they could inject guest-player rows into academies/trainers they do
 * not own. When neither id is supplied the player is context-less and allowed.
 */

export type ManualPlayerAccessInput = {
  academyProfileId?: string | null;
  trainerProfileId?: string | null;
  /** Caller manages the supplied academy (only meaningful when academyProfileId set). */
  managesAcademy: boolean;
  /** Caller owns or manages the supplied trainer (only meaningful when trainerProfileId set). */
  controlsTrainer: boolean;
};

export type ManualPlayerAccessResult =
  | { ok: true }
  | { ok: false; reason: "academy_forbidden" | "trainer_forbidden" };

export function evaluateManualPlayerAccess(
  input: ManualPlayerAccessInput,
): ManualPlayerAccessResult {
  if (input.academyProfileId && !input.managesAcademy) {
    return { ok: false, reason: "academy_forbidden" };
  }
  if (input.trainerProfileId && !input.controlsTrainer) {
    return { ok: false, reason: "trainer_forbidden" };
  }
  return { ok: true };
}
