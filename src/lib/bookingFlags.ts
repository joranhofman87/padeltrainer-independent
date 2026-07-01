/**
 * Rollout flags for the public booking widget's guest pay-first flow.
 *
 * The guest flow depends on edge functions the owner must deploy MANUALLY
 * (create-guest-slot-payment, get-guest-booking) + two migrations. The frontend
 * auto-deploys via Vercel on merge, so we ship the wiring INERT behind this flag:
 * with it off, a single-slot tap keeps today's behaviour (route to the trainer's
 * book page). Once the owner has deployed the functions + migrations, flip this to
 * true in a one-line PR to make guest single-slot pay-first live.
 */
// Typed `boolean` (not narrowed to the `false` literal) so gating conditions
// aren't flagged as constant/unreachable while the flag is off.
export const GUEST_PAYFIRST_ENABLED: boolean = false;
