#!/usr/bin/env node
/**
 * Guards that every edge function that MUST stay `verify_jwt = false` in supabase/config.toml actually does.
 *
 * Two kinds of function belong here, and the shared invariant is the SAME (`verify_jwt = false`), not that they
 * are "public":
 *   (1) genuinely PUBLIC / no-JWT — payment & external webhooks (authenticate by provider signature), public
 *       images / reads / health (anonymous callers), guest pay-first. These carry no Supabase JWT at all.
 *   (2) SELF-AUTHENTICATING — the function verifies the caller ITSELF (e.g. requireServiceRole does a byte-exact
 *       compare against SUPABASE_SERVICE_ROLE_KEY, the LEGACY service-role JWT). The cron-driven drainers get
 *       exactly that legacy JWT, sent from Vault as `Authorization: Bearer` (20260722100000_rebook_crons_use_
 *       vault.sql) — so they DO receive a JWT; `verify_jwt=false` just routes it to the function's own guard
 *       instead of the gateway's. (New `sb_secret_` keys live in SUPABASE_SECRET_KEYS + go via `apikey`; they
 *       do NOT replace the service-role key.)
 * Either way, a function absent from config.toml inherits the platform default (verify_jwt = true), so the
 * gateway 401s the legitimate caller before the function runs. The pre-scale audit found exactly this drift:
 * og-image / rating-og-image / stripe-subscription-webhook were created but never added, so a full
 * `supabase functions deploy` would have silently disarmed the Stripe webhook and every social-share image.
 *
 * When you add a new no-JWT OR self-authenticating function, add it to MUST_VERIFY_JWT_FALSE below.
 */
import { readFileSync, existsSync } from 'node:fs';

const MUST_VERIFY_JWT_FALSE = [
  // --- (1) genuinely public / no Supabase JWT ---
  // payment / external webhooks — authenticate by provider signature, no JWT
  'stripe-subscription-webhook', 'mollie-webhook', 'mollie-callback', 'resend-webhook', 'reditus-referral-webhook',
  'twilio-whatsapp-webhook',
  // public pages / images / reads / health — anonymous callers (own rate-limit where needed)
  'og-image', 'rating-og-image', 'get-public-rating', 'get-public-invoice', 'render-page', 'sitemap', 'llms-full-txt', 'public-api', 'health-check',
  // public submission + public-token actions
  'submit-guest-intake', 'get-booking-invoice', 'update-public-invoice-details',
  // Mollie connect / payment-init (reached from public pay pages / OAuth callbacks)
  'create-invoice-payment', 'create-registration-invoice', 'create-rebook-invoice',
  'mollie-connect-academy', 'mollie-connect-trainer', 'check-mollie-connect-status', 'verify-mollie-payment',
  // anonymous guest pay-first (public booking widget) — server-authoritative, own rate-limit
  'create-guest-slot-payment', 'create-guest-cyclus-payment', 'create-guest-cart-payment', 'get-guest-booking',

  // --- (2) self-authenticating (receive a JWT / signature; verify it themselves) ---
  // user JWT (getUser) for owner sends + the service-role JWT for the sweep cron + resume chain
  'send-campaign-emails',
  // cron-driven outbox drainers — requireServiceRole byte-exact-compares the request's Bearer against
  // SUPABASE_SERVICE_ROLE_KEY (the LEGACY service-role JWT); the cron sends that JWT from Vault. verify_jwt=false
  // so the JWT reaches the function's own guard rather than the gateway's verifier.
  'notification-email-worker', 'notification-whatsapp-worker', 'notification-digest-worker',
  // ops tool, service-role guarded + restricted CORS; called with the service-role JWT, self-verified the same way
  'twilio-content-admin',
];

const toml = readFileSync('supabase/config.toml', 'utf8');
const cfg = {};
let cur = null;
for (const line of toml.split('\n')) {
  const m = line.match(/^\[functions\.([^\]]+)\]/);
  if (m) { cur = m[1]; continue; }
  if (cur && /verify_jwt\s*=/.test(line)) { cfg[cur] = /verify_jwt\s*=\s*true/.test(line); cur = null; } // store actual verify_jwt value
  else if (/^\[/.test(line)) cur = null;
}

const problems = [];
for (const fn of MUST_VERIFY_JWT_FALSE) {
  if (!existsSync(`supabase/functions/${fn}/index.ts`)) continue; // renamed/removed — skip
  if (cfg[fn] !== false) {
    problems.push(`${fn} — ${cfg[fn] === undefined ? 'MISSING from config.toml (inherits verify_jwt=true)' : 'verify_jwt=true'}`);
  }
}

if (problems.length) {
  console.error('Edge-function config drift — these functions must be verify_jwt=false or they 401 on deploy:\n');
  problems.forEach((p) => console.error('  - ' + p));
  console.error('\nEach is either public (no Supabase JWT) or self-authenticating (verifies the caller itself).\nAdd to supabase/config.toml:\n  [functions.<name>]\n  verify_jwt = false\n');
  process.exit(1);
}
console.log(`OK — all ${MUST_VERIFY_JWT_FALSE.length} verify_jwt=false edge functions are correctly configured.`);
