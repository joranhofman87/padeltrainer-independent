// Group-confirmation send/stamp semantics. The tally + "clean run" rule are the generic send-then-
// stamp primitive (_shared/send-then-stamp.ts); this module keeps the group-confirmation-specific
// names as thin re-exports so the sender + its tests read in domain terms. Codex round-5 #3: a
// provider send failure OR an un-stamped send is NOT clean success.

export {
  runSendThenStamp as runGroupConfirmations,
  sendTallyOk as groupConfirmOk,
  type SendStepOutcome as MemberConfirmStep,
  type SendTally as GroupConfirmTally,
} from "./send-then-stamp.ts";

export type GroupGateResult<T> =
  | { kind: "no_work" }
  | { kind: "throttled" }
  | { kind: "ready"; claims: T[] };

/**
 * Order the group-confirmation admission steps so the EXPENSIVE full scan runs LAST (Codex round-9 #3):
 * a CHEAP work probe first (a no-work call returns without consuming an allowance), then the atomic
 * rate-limit consume (a throttled call returns WITHOUT scanning), and only then the full paginated
 * scan. On a verify_jwt=false endpoint this stops a valid token from forcing repeated expensive scans
 * while throttled. Extracted so the ordering is unit-testable + mutation-checkable.
 */
export async function gateGroupConfirmation<T>(steps: {
  hasWork: () => Promise<boolean>;
  consumeAllowance: () => Promise<boolean>;
  scan: () => Promise<T[]>;
}): Promise<GroupGateResult<T>> {
  if (!(await steps.hasWork())) return { kind: "no_work" }; // no consume, no scan
  if (!(await steps.consumeAllowance())) return { kind: "throttled" }; // no scan
  return { kind: "ready", claims: await steps.scan() };
}
