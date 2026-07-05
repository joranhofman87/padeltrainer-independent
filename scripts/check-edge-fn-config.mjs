#!/usr/bin/env node
/**
 * Guards that every PUBLIC / self-authenticating edge function stays
 * `verify_jwt = false` in supabase/config.toml.
 *
 * These functions are called WITHOUT a Supabase JWT — payment/external webhooks
 * authenticate by provider signature, public images/reads/health serve anonymous
 * callers. A function absent from config.toml inherits the platform default
 * (verify_jwt = true), so the gateway 401s it before it runs. The pre-scale audit
 * found exactly this drift: og-image / rating-og-image / stripe-subscription-webhook
 * were created but never added, so a full `supabase functions deploy` would have
 * silently disarmed the Stripe webhook and every social-share image.
 *
 * When you add a new no-JWT function, add it to MUST_BE_PUBLIC below.
 */
import { readFileSync, existsSync } from 'node:fs';

const MUST_BE_PUBLIC = [
  // payment / external webhooks — authenticate by provider signature, no JWT
  'stripe-subscription-webhook', 'mollie-webhook', 'mollie-callback', 'resend-webhook', 'reditus-referral-webhook',
  // public pages / images / reads / health — anonymous callers (own rate-limit where needed)
  'og-image', 'rating-og-image', 'get-public-rating', 'get-public-invoice', 'render-page', 'sitemap', 'llms-full-txt', 'public-api', 'health-check',
  // public submission + public-token actions
  'submit-guest-intake', 'get-booking-invoice', 'update-public-invoice-details',
  // self-authenticating: user JWT for owner sends, service-role key for the sweep cron + resume chain
  'send-campaign-emails',
  // Mollie connect / payment-init (reached from public pay pages / OAuth callbacks)
  'create-invoice-payment', 'create-registration-invoice', 'create-rebook-invoice',
  'mollie-connect-academy', 'mollie-connect-trainer', 'check-mollie-connect-status', 'verify-mollie-payment',
  // anonymous guest pay-first (public booking widget) — server-authoritative, own rate-limit
  'create-guest-slot-payment', 'create-guest-cyclus-payment', 'create-guest-cart-payment', 'get-guest-booking',
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
for (const fn of MUST_BE_PUBLIC) {
  if (!existsSync(`supabase/functions/${fn}/index.ts`)) continue; // renamed/removed — skip
  if (cfg[fn] !== false) {
    problems.push(`${fn} — ${cfg[fn] === undefined ? 'MISSING from config.toml (inherits verify_jwt=true)' : 'verify_jwt=true'}`);
  }
}

if (problems.length) {
  console.error('Edge-function config drift — these PUBLIC functions would 401 on deploy:\n');
  problems.forEach((p) => console.error('  - ' + p));
  console.error('\nEach is called without a Supabase JWT. Add to supabase/config.toml:\n  [functions.<name>]\n  verify_jwt = false\n');
  process.exit(1);
}
console.log(`OK — all ${MUST_BE_PUBLIC.length} public edge functions are verify_jwt=false.`);
