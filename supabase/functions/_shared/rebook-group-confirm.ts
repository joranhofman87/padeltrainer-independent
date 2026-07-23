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
