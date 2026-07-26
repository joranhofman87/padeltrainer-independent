#!/usr/bin/env node
/**
 * SOURCE GUARD — every runtime consumer of the LEGACY service-role key must be REGISTERED here.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is the legacy `eyJ…` service-role JWT. Supabase is deprecating legacy
 * `service_role`/`anon` JWTs by end-2026, and any emergency rotation is a forced migration to a new
 * `sb_secret_` key (see docs/CRON_SERVICE_KEY_SETUP.md → "Path B"). That migration is only safe if we can
 * see EVERY place the legacy key is consumed — not just the inbound cron→function auth, but the far larger
 * class of functions that use the key INTERNALLY to build a privileged (RLS-bypassing) supabase-js admin
 * client. Deactivating the legacy key breaks all of those at once.
 *
 * The pre-migration audit found the earlier doc only tracked ~3 consumers (worker auth, pg_net, the Vercel
 * caller) while ~110 files actually reference the key. This guard makes the inventory DURABLE and
 * self-enforcing: it CONTENT-scans the runtime source roots (not an extension allow-list — that would silently
 * drop an unknown-extension consumer) and fails CI if a file references the key (directly OR via a shared
 * service-role helper — see the TWO detection signals below) but is not in the categorized registry (a NEW
 * unmanaged consumer), or if a registered file no longer references it (a STALE entry). Either way the registry —
 * and Path B's migration checklist — cannot silently drift.
 *
 * Detection is the whole `*_SERVICE_ROLE_KEY` env-name FAMILY, not one literal: the cross-project storage
 * migration scripts read the key under `SOURCE_`/`TARGET_SERVICE_ROLE_KEY`, and an alias is not a safe reason to
 * escape the inventory (`TARGET_SERVICE_ROLE_KEY` points at the live project — it IS the legacy key).
 *
 * Categories (Path B must migrate or explicitly PROVE each one before the legacy key is deactivated):
 *   inbound-auth       — verifies the incoming request's Bearer/apikey against the key (the drainers).
 *   admin-client       — builds a privileged supabase-js client with the key; BREAKS if the legacy key is off.
 *   downstream-caller  — forwards the key to invoke another function / shared helper that does.
 *   vercel-caller      — Vercel cron helper; reads the key from the Vercel env, not Vault.
 *   scripts-ci         — one-off migration scripts, local seed, and CI guards (this file included).
 *   tests              — fixtures that exercise the auth (no production credential).
 *
 * TWO detection signals — a file is a consumer if EITHER holds, because the biggest live consumers carry no
 * literal at all: functions like notification-digest-worker, backup-database, invoice-storage-gc, and
 * twilio-content-admin gate on `requireServiceRole` / build their admin client from `getEnvServiceRoleKey`
 * and never name the env var. A literal-only scan would print "all registered" while silently dropping them
 * from the migration/smoke-test checklist. So we ALSO flag importers of the shared service-role helpers.
 *
 *   `via-shared-helper` — no literal; consumes the key transitively through a registered shared module
 *                         (`requireServiceRole`/`requireServiceRoleOrAdmin` in _shared/auth.ts, or
 *                         `getEnvServiceRoleKey` in _shared/service-role-auth.ts). Legacy-off breaks these too;
 *                         each must be individually re-verified after a rotation.
 *
 * NOT covered here (a SEPARATE, migration-gated class): the pg_net/Vault cron SQL that sends the key as a
 * Bearer from `vault.decrypted_secrets.service_role_key`. Those live in supabase/migrations and are
 * enumerated in docs/CRON_SERVICE_KEY_SETUP.md → "Which crons depend on this key". Third parties: NONE — the
 * service-role key never leaves for an external provider (provider functions authenticate to Resend/Twilio/
 * Mollie/Stripe with those providers' OWN keys).
 *
 * When you add a file that references any `*_SERVICE_ROLE_KEY` name (or a service-role helper), add it below.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Match the WHOLE `*_SERVICE_ROLE_KEY` env-name family, not one literal: the storage migration scripts read the
// key under SOURCE_/TARGET_SERVICE_ROLE_KEY (cross-project), and a bare SERVICE_ROLE_KEY is equally a consumer.
// A single-literal scan silently dropped all of them — an alias is NOT a safe reason to escape the inventory.
const KEY_FAMILY = /[A-Z0-9_]*SERVICE_ROLE_KEY/;
const HELPER_SIGNAL = /requireServiceRole|getEnvServiceRoleKey/; // catches requireServiceRole(OrAdmin) + the getter
const ROOTS = ['supabase/functions', 'api', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git']); // anchored to genuinely-non-source dirs only
// Scan by CONTENT, not an extension allow-list (an allow-list silently drops an unknown-extension consumer). Skip
// only binary/asset/lockfile blobs + env files (secret material / templates, not code consumers) + oversized files.
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|eot|otf|pdf|zip|gz|tgz|mp[34]|mov|lock|map|min\.js)$/i;
const MAX_BYTES = 512 * 1024;

// ── The categorized, durable inventory ────────────────────────────────────────────────────────────────────
const MANAGED = {
  'inbound-auth': [
    'supabase/functions/_shared/digest-worker-entry.ts',
    'supabase/functions/_shared/digest-worker-handler.ts',
    'supabase/functions/_shared/service-role-auth.ts',
    'supabase/functions/forward-invoice/index.ts',
    'supabase/functions/generate-cycle-commitment-invoices/index.ts',
    'supabase/functions/slack-notify/index.ts',
  ],
  'admin-client': [
    'supabase/functions/_shared/auth.ts',
    'supabase/functions/_shared/edge-slack.ts',
    'supabase/functions/academy-update-player-email/index.ts',
    'supabase/functions/admin-reset-password/index.ts',
    'supabase/functions/auto-rebook-reminder/index.ts',
    'supabase/functions/backfill-email-bounces/index.ts',
    'supabase/functions/bulk-cleanup-users/index.ts',
    'supabase/functions/bulk-update-vat/index.ts',
    'supabase/functions/cancel-stripe-subscription/index.ts',
    'supabase/functions/check-stripe-subscription/index.ts',
    'supabase/functions/create-academy-trainer/index.ts',
    'supabase/functions/create-admin-trainer/index.ts',
    'supabase/functions/create-club-trainer/index.ts',
    'supabase/functions/create-group-rebook-invoice/index.ts',
    'supabase/functions/create-guest-cart-payment/index.ts',
    'supabase/functions/create-guest-cyclus-payment/index.ts',
    'supabase/functions/create-guest-slot-payment/index.ts',
    'supabase/functions/create-invoice-payment/index.ts',
    'supabase/functions/create-manual-player/index.ts',
    'supabase/functions/create-mollie-payment/index.ts',
    'supabase/functions/create-rebook-invoice-public/index.ts',
    'supabase/functions/create-rebook-invoice/index.ts',
    'supabase/functions/create-registration-invoice/index.ts',
    'supabase/functions/create-stripe-checkout/index.ts',
    'supabase/functions/customer-portal/index.ts',
    'supabase/functions/delete-user/index.ts',
    'supabase/functions/finalize-proposals/index.ts',
    'supabase/functions/generate-blog-article/index.ts',
    'supabase/functions/generate-blog-cover/index.ts',
    'supabase/functions/generate-invoice/index.ts',
    'supabase/functions/generate-proposals/index.ts',
    'supabase/functions/get-admin-stats/index.ts',
    'supabase/functions/get-guest-booking/index.ts',
    'supabase/functions/get-public-invoice/index.ts',
    'supabase/functions/get-public-rating/index.ts',
    'supabase/functions/google-calendar-callback/index.ts',
    'supabase/functions/health-check/index.ts',
    'supabase/functions/impersonate-user/index.ts',
    'supabase/functions/import-pipeline-data/index.ts',
    'supabase/functions/invoice-health-check/index.ts',
    'supabase/functions/llms-full-txt/index.ts',
    'supabase/functions/mollie-callback/index.ts',
    'supabase/functions/mollie-connect-trainer/index.ts',
    'supabase/functions/mollie-webhook/index.ts',
    'supabase/functions/notification-email-worker/index.ts',
    'supabase/functions/notification-whatsapp-worker/index.ts',
    'supabase/functions/notify-followers/index.ts',
    'supabase/functions/notify-rebook-member-open/index.ts',
    'supabase/functions/process-blog-queue/index.ts',
    'supabase/functions/process-onboarding-emails/index.ts',
    'supabase/functions/public-api/index.ts',
    'supabase/functions/rating-og-image/index.ts',
    'supabase/functions/recalculate-invoices/index.ts',
    'supabase/functions/reditus-referral-webhook/index.ts',
    'supabase/functions/render-page/db-facts.ts',
    'supabase/functions/render-page/index.ts',
    'supabase/functions/request-account-deletion/index.ts',
    'supabase/functions/resend-webhook/index.ts',
    'supabase/functions/send-auth-email/index.ts',
    'supabase/functions/send-campaign-emails/index.ts',
    'supabase/functions/send-digest-emails/index.ts',
    'supabase/functions/send-email/index.ts',
    'supabase/functions/send-invoice-email/index.ts',
    'supabase/functions/send-priority-claim-invitation/index.ts',
    'supabase/functions/send-push-bulk/index.ts',
    'supabase/functions/send-push/index.ts',
    'supabase/functions/send-rebook-group-confirmation/index.ts',
    'supabase/functions/send-rebook-reminder/index.ts',
    'supabase/functions/send-schedule-notifications/index.ts',
    'supabase/functions/signup-user/index.ts',
    'supabase/functions/sitemap/index.ts',
    'supabase/functions/stripe-subscription-webhook/index.ts',
    'supabase/functions/submit-guest-intake/index.ts',
    'supabase/functions/sync-calendar-event/index.ts',
    'supabase/functions/toggle-player-role/index.ts',
    'supabase/functions/translate-blog-article/index.ts',
    'supabase/functions/trigger-welcome-emails/index.ts',
    'supabase/functions/twilio-whatsapp-webhook/index.ts',
    'supabase/functions/update-public-invoice-details/index.ts',
    'supabase/functions/update-user/index.ts',
    'supabase/functions/verify-mollie-payment/index.ts',
  ],
  'downstream-caller': [
    'supabase/functions/_shared/booking-confirmation-email.ts',
    'supabase/functions/_shared/registration-confirmation-email.ts',
    'supabase/functions/auto-create-invoice/index.ts',
    'supabase/functions/backfill-invoices/index.ts',
    'supabase/functions/get-booking-invoice/index.ts',
  ],
  'vercel-caller': [
    'api/_lib/cron.ts',
  ],
  'scripts-ci': [
    'scripts/check-edge-fn-config.mjs',
    'scripts/check-legacy-service-role-consumers.mjs',
    'scripts/db/seed-local.ts',
    'scripts/migration/auth_import_dry_run.py',
    'scripts/migration/auth_import_users.py',
    'scripts/migration/auth_verify_pre_public_import.py',
    'scripts/migration/ficwb_secrets_audit.py',
    'scripts/migration/storage_common.py',
    'scripts/migration/storage_migration_dry_run.py',
    // cross-project storage migration one-offs — read the key under SOURCE_/TARGET_SERVICE_ROLE_KEY (not the
    // SUPABASE_ literal); TARGET points at the live project, so TARGET_SERVICE_ROLE_KEY IS the legacy key.
    'scripts/migration/storage_copy_buckets.py',
    'scripts/migration/storage_copy_invoices.py',
    'scripts/migration/storage_fix_missing_from_db.py',
    'scripts/migration/storage_regenerate_invoice_urls.py',
    'scripts/migration/storage_regenerate_invoices_via_edge.py',
  ],
  'tests': [
    'supabase/functions/_shared/auth.test.ts',
    'supabase/functions/_shared/digest-worker-entry.test.ts',
    'supabase/functions/_shared/digest-worker-handler.test.ts',
    'supabase/functions/_shared/service-role-auth.test.ts',
  ],
  // No literal — caught by the HELPER_SIGNAL pass. Each consumes the legacy key transitively and must be
  // individually re-verified after any rotation (they are otherwise invisible to a literal-only inventory).
  'via-shared-helper': [
    'supabase/functions/_shared/forward-invoice-auth.ts', // getEnvServiceRoleKey + builds the admin client
    'supabase/functions/backup-database/index.ts',        // requireServiceRoleOrAdmin
    'supabase/functions/invoice-storage-gc/index.ts',     // requireServiceRoleOrAdmin
    'supabase/functions/notification-digest-worker/index.ts', // requireServiceRole + createClient(serviceKey)
    'supabase/functions/twilio-content-admin/index.ts',   // requireServiceRole
  ],
};

// ── Enforcement: filesystem walk vs registry ──────────────────────────────────────────────────────────────
const registered = new Set(Object.values(MANAGED).flat());

const scannable = (name) => !SKIP_EXT.test(name) && !name.startsWith('.env');

function walk(dir, out) {
  if (!existsSync(dir)) return;
  const st = statSync(dir);
  if (st.isFile()) { if (scannable(dir)) out.push(dir); return; }
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (scannable(name)) out.push(p);
  }
}

const found = new Set();
const files = [];
for (const root of ROOTS) walk(root, files);
for (const f of files) {
  if (statSync(f).size > MAX_BYTES) continue; // skip oversized blobs — real consumers are small source files
  const src = readFileSync(f, 'utf8');
  if (KEY_FAMILY.test(src) || HELPER_SIGNAL.test(src)) found.add(f);
}

const unregistered = [...found].filter((f) => !registered.has(f)).sort();
const stale = [...registered].filter((f) => !found.has(f)).sort();

if (unregistered.length || stale.length) {
  console.error(`Legacy service-role key registry drift — *_SERVICE_ROLE_KEY consumers are out of sync with the registry.\n`);
  if (unregistered.length) {
    console.error('UNREGISTERED — these files reference the key but are not in the categorized registry.');
    console.error('A new legacy-key consumer must be migrated (or explicitly proven) in Path B before the key can');
    console.error('be deactivated. Add each to the correct category in scripts/check-legacy-service-role-consumers.mjs:\n');
    unregistered.forEach((f) => console.error('  + ' + f));
    console.error('');
  }
  if (stale.length) {
    console.error('STALE — these registry entries no longer reference the key; remove them to keep the inventory honest:\n');
    stale.forEach((f) => console.error('  - ' + f));
    console.error('');
  }
  console.error('See docs/CRON_SERVICE_KEY_SETUP.md → "The legacy service-role-key dependency class".');
  process.exit(1);
}

const counts = Object.entries(MANAGED).map(([k, v]) => `${k}=${v.length}`).join(', ');
console.log(`OK — all ${registered.size} legacy service-role-key consumers are registered (${counts}).`);
