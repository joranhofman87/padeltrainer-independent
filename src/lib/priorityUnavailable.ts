/**
 * ABC-26 — browser view of the priority-unavailable contract.
 *
 * This is a RE-EXPORT, not a copy. The single authority lives in
 * `supabase/functions/_shared/priority-unavailable.ts` so that the version constant and the reason
 * vocabulary cannot drift between the Edge runtime and the bundle; the module is dependency-free
 * and therefore portable to both. If you need to change the contract, change it there.
 */
export {
  MAX_PRIORITY_SUBMISSIONS,
  PRIORITY_PROTOCOL_VERSION,
  PRIORITY_REFUSAL_REASONS,
  isPriorityRefusal,
  isSupportedPriorityProtocol,
  parsePriorityRefusal,
  parsePriorityRequest,
  type PriorityArmReport,
  type PriorityRefusal,
  type PriorityRefusalParse,
  type PriorityRefusalReason,
} from '../../supabase/functions/_shared/priority-unavailable';
