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
// Typed `boolean` (not narrowed to the `true` literal) so gating conditions
// aren't flagged as constant/unreachable.
//
// ENABLED 2026-07-01: migrations 20260704150000/160000/170000/180000 applied +
// edge fns create-guest-slot-payment / create-guest-cyclus-payment / get-guest-booking
// deployed + anon-reachability smoke-tested. A single-slot / cyclus tap on the academy
// public page now opens the guest pay-first dialog.
export const GUEST_PAYFIRST_ENABLED: boolean = true;
