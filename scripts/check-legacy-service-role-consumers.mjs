#!/usr/bin/env node
/**
 * SOURCE GUARD — every consumer of the LEGACY service-role key must be REGISTERED here.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is the legacy `eyJ…` service-role JWT. Supabase is deprecating legacy
 * `service_role`/`anon` JWTs by end-2026, and remediation is migration to a new `sb_secret_` key (see
 * docs/CRON_SERVICE_KEY_SETUP.md → "Path B"). That migration is only safe if we can see EVERY place the legacy
 * key is consumed — not just the inbound cron→function auth, but the far larger class of functions that use the
 * key INTERNALLY to build a privileged (RLS-bypassing) supabase-js admin client. Deactivating the legacy key
 * breaks all of those at once.
 *
 * Supabase DISABLES the legacy `anon` + `service_role` keys AS A PAIR, so this guard inventories BOTH — Path B
 * migrates service_role → sb_secret_ (trusted backend) and anon → sb_publishable_ (browser/public), and the pair
 * can be disabled only when both inventories are clean. Checks (run `node …`; `--self-test` exercises them):
 *
 *   (1) SOURCE (service_role) consumers — content-scans the runtime source roots (supabase/functions, api,
 *       scripts) and fails if a file references the key but is not in MANAGED (NEW), or a registered file no
 *       longer does (STALE). Content scan, NOT an extension allow-list (that would drop an unknown-ext consumer).
 *   (2) SQL/Vault consumers — scans supabase/migrations for cron commands that SEND the key (an http_post that
 *       Bearers a decrypted Vault secret / current_setting) or STORE it in Vault, against MANAGED_SQL. Detection
 *       is STRUCTURAL (not coupled to the secret's name). Migrations are immutable + cumulative, so MANAGED_SQL
 *       tracks LIFECYCLE (active / active-legacy / superseded) + forward replacement — and check (5) ENFORCES
 *       that status against the files, so a stale status cannot stay green.
 *   (3) ANON consumers — the anon → sb_publishable_ side. Every `*_ANON_KEY`/`*_PUBLISHABLE_KEY` consumer must be
 *       in MANAGED_ANON (browser-public / edge-anon / config / scripts-ci / tests).
 *   (4) BROWSER-SURFACE elevation — an RLS-bypassing key (`sb_secret_` / `*_SERVICE_ROLE_KEY`) in the shipped
 *       browser bundle (`src/`, excluding tests) FAILS: that key must never reach a public client.
 *   (5) SQL lifecycle — proves each MANAGED_SQL active/superseded status against later migrations touching the
 *       same cron job name.
 *   (6) REPO-WIDE escape — fails if the key/helper (or a key-sending .sql outside supabase/migrations) is
 *       referenced OUTSIDE the guarded roots + the out-of-scope allow-list (docs `.md`, `src/test/**`, `tests/**`,
 *       `supabase/config.toml`). Catches a consumer added under a NEW runtime root.
 *
 * TWO source-detection signals — a file is a consumer if EITHER holds:
 *   - the `*_SERVICE_ROLE_KEY` env-name FAMILY (not one literal): the cross-project storage scripts read the key
 *     under `SOURCE_`/`TARGET_SERVICE_ROLE_KEY`; an alias is not a safe reason to escape the inventory.
 *   - a shared service-role HELPER (`requireServiceRole(OrAdmin)`, `getEnvServiceRoleKey`, `isServiceRoleRequest`,
 *     `resolveServiceRoleToken`, or an import of `_shared/service-role-auth`). The biggest live consumers
 *     (notification-digest-worker, backup-database, invoice-storage-gc, twilio-content-admin) carry NO literal
 *     and reach the key only through these helpers; a literal-only scan silently drops them. NOTE: helper
 *     detection is name/specifier matching, not a full import graph — when you add a NEW shared wrapper that
 *     reads the key, extend HELPER_SIGNAL in the same change (the wrapper itself is caught by the family, but its
 *     importers are only caught once its name is a signal).
 *
 * Categories (Path B must migrate or explicitly PROVE each before the legacy key is deactivated):
 *   inbound-auth / admin-client / downstream-caller / vercel-caller / scripts-ci / tests / via-shared-helper.
 * Third parties: NONE — the service-role key never leaves for an external provider (provider functions
 * authenticate to Resend/Twilio/Mollie/Stripe with those providers' OWN keys).
 *
 * When you add a file that references any `*_SERVICE_ROLE_KEY` name / a service-role helper (source), or a
 * migration that sends/stores the key (SQL), register it below.
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';

// ── Detection signals ───────────────────────────────────────────────────────────────────────────────────────
const KEY_FAMILY = /[A-Z0-9_]*SERVICE_ROLE_KEY/;          // SUPABASE_ / SOURCE_ / TARGET_ / bare
// Helper exports that read the key, PLUS an import of the key-holding shared module (in `from '…'` context only,
// so a mere path MENTION — e.g. a generated baseline key `".../service-role-auth.ts|TS2304|…"` — does not match).
const HELPER_SIGNAL = /requireServiceRole|getEnvServiceRoleKey|isServiceRoleRequest|resolveServiceRoleToken|from\s+['"][^'"]*service-role-auth/;
// STRUCTURAL sender detection (NOT coupled to the secret's name): an http_post (`net.http_post` or the bare
// `http_post` of the `http` extension) that injects a decrypted Vault secret or a `current_setting` into an
// auth header (Authorization/Bearer/apikey) sends a CREDENTIAL regardless of what the secret is named — so a
// differently-named worker credential (e.g. vault…name='worker_credential') cannot slip past. Plus any Vault
// create/update of a secret.
const CRED_SOURCE = /vault\.decrypted_secrets|decrypted_secret|current_setting/i;
const AUTH_HEADER = /authorization|\bapikey\b|bearer/i;
const SQL_SENDER = (s) => (/\bhttp_post\s*\(/.test(s) && AUTH_HEADER.test(s) && CRED_SOURCE.test(s)) || /vault\.(create|update)_secret/.test(s);

// The legacy `anon`/`service_role` keys are DISABLED AS A PAIR, so Path B is TWO migrations: service_role →
// sb_secret_ (trusted backend) and anon → sb_publishable_ (browser/public). This family inventories the anon side.
const ANON_FAMILY = /[A-Z0-9_]*ANON_KEY|[A-Z0-9_]*PUBLISHABLE_KEY/;
// Elevated, RLS-bypassing credentials that must NEVER reach the browser/public bundle:
const ELEVATED = /sb_secret_|[A-Z0-9_]*SERVICE_ROLE_KEY/;
// The shipped browser bundle (untrusted public client). A service-role / sb_secret_ key here is a critical leak.
const isBrowserSurface = (p) => p.startsWith('src/') && !p.startsWith('src/test/') && !/\.test\.[tj]sx?$/.test(p);

const SOURCE_ROOTS = ['supabase/functions', 'api', 'scripts'];
const SQL_ROOT = 'supabase/migrations';
// Prune only truly-non-source dirs: .git/node_modules + the GITIGNORED build outputs (dist/.vercel). Do NOT prune
// build/coverage/.next — they are NOT gitignored here, so a committed consumer under those names must stay visible
// to the repo-wide escape scan (which shares this walk).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vercel']);
// Content scan (deny-list), not an extension allow-list. Skip binary/asset/lockfile blobs + env files (secret
// material / templates, not code). Everything else — incl. extensionless + unknown extensions — IS scanned.
const SKIP_EXT = /\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|eot|otf|pdf|zip|gz|tgz|mp[34]|mov|lock|map)$/i;
// Generated tooling snapshots that echo source paths/identifiers (error/suppression baselines) — NOT consumers.
const SKIP_FILES = new Set(['tsc-app.baseline.json', 'eslint-suppressions.json']);
const scannable = (name) => !SKIP_EXT.test(name) && !name.startsWith('.env') && !SKIP_FILES.has(name);
// References allowed OUTSIDE the guarded roots (not runtime consumers): docs, test harnesses, project config.
const isAllowedOutside = (p) => p.endsWith('.md') || p.startsWith('src/test/') || p.startsWith('tests/') || p === 'supabase/config.toml';

// ── (1) The categorized, durable SOURCE inventory ───────────────────────────────────────────────────────────
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

// ── (2) The SQL/Vault registry (immutable, cumulative migrations — track lifecycle, not just membership) ─────
// status: active = the current live definition of its cron; active-legacy = still the last definition but on the
// old app.settings path (effectively inert on Supabase, kept for honesty); superseded = a later migration
// re-scheduled/removed the same job. `replacement` names the forward migration (or the Path-B cutover to come).
const MANAGED_SQL = {
  'supabase/migrations/20260722100000_rebook_crons_use_vault.sql':
    { status: 'active', note: 'Vault-based rebook crons (notify-rebook-member-open, auto-rebook-reminder); READS the Vault service_role_key secret at tick time (secret created out-of-band by the owner, not by this migration)', replacement: '(Path B) future sb_secret_ cutover migration' },
  'supabase/migrations/20260912110000_notification_email_worker_cron.sql':
    { status: 'active', note: 'Vault-based notification-email-worker cron', replacement: '(Path B) future sb_secret_ cutover migration' },
  'supabase/migrations/20260919110000_notification_whatsapp_worker_cron.sql':
    { status: 'active', note: 'Vault-based notification-whatsapp-worker cron', replacement: '(Path B) future sb_secret_ cutover migration' },
  'supabase/migrations/20260606120000_phase5_email_idempotency_and_cron_ficwb.sql':
    { status: 'active-legacy', note: 'invoice-health-check-daily via app.settings (redundant with the Vercel maintenance job; app.settings reads empty on Supabase → effectively inert)', replacement: 'unschedule the redundant cron, or (Path B) sb_secret_ cutover' },
  'supabase/migrations/20260714110000_notify_rebook_member_open_cron.sql':
    { status: 'superseded', note: 'notify-rebook-member-open via app.settings', replacement: '20260722100000_rebook_crons_use_vault.sql' },
  'supabase/migrations/20260721100000_auto_rebook_reminder.sql':
    { status: 'superseded', note: 'auto-rebook-reminder via app.settings', replacement: '20260722100000_rebook_crons_use_vault.sql' },
  'supabase/migrations/20260531110000_schedule_invoice_health_check_job.sql':
    { status: 'superseded', note: 'invoice-health-check-daily via app.settings', replacement: '20260606120000_phase5_email_idempotency_and_cron_ficwb.sql' },
  'supabase/migrations/20260511165940_c28866fe-8f82-4f41-8ab2-a74b38aed1b8.sql':
    { status: 'superseded', note: 'enrich-locations / fetch-location-logos crons via app.settings', replacement: '20260606120000_phase5_email_idempotency_and_cron_ficwb.sql (jobs later unscheduled)' },
};

// ── (3) The legacy-ANON inventory (anon → sb_publishable_ side of the pair) ─────────────────────────────────
// Every consumer of the legacy `anon`/publishable key. Path B migrates these to sb_publishable_ (a LOW-privilege,
// RLS-respecting key), NEVER sb_secret_. `browser-public` members ship to / run as the untrusted public client.
const MANAGED_ANON = {
  'browser-public': [
    'docs/cloudflare-worker.js',
    'src/integrations/supabase/client.ts',
    'src/pages/marketing/Partner.tsx',
  ],
  'edge-anon': [
    'supabase/functions/academy-update-player-email/index.ts',
    'supabase/functions/bulk-update-vat/index.ts',
    'supabase/functions/create-academy-trainer/index.ts',
    'supabase/functions/create-admin-trainer/index.ts',
    'supabase/functions/create-club-trainer/index.ts',
    'supabase/functions/create-manual-player/index.ts',
    'supabase/functions/get-admin-stats/index.ts',
    'supabase/functions/google-calendar-auth/index.ts',
    'supabase/functions/health-check/index.ts',
    'supabase/functions/impersonate-user/index.ts',
    'supabase/functions/import-pipeline-data/index.ts',
    'supabase/functions/reditus-referral-token/index.ts',
    'supabase/functions/render-page/index.ts',
    'supabase/functions/rls-smoke-test/index.ts',
    'supabase/functions/scrape-academies/index.ts',
    'supabase/functions/send-campaign-emails/index.ts',
    'supabase/functions/send-priority-claim-invitation/index.ts',
    'supabase/functions/send-push/index.ts',
    'supabase/functions/toggle-player-role/index.ts',
  ],
  'scripts-ci': [
    // this guard names the ANON_KEY/PUBLISHABLE_KEY family in its own regex + comments (not a consumer, but it
    // contains the token, so it must self-register — same as it does in MANAGED).
    'scripts/check-legacy-service-role-consumers.mjs',
    'scripts/migration/ficwb_secrets_audit.py',
    'scripts/migration/storage_common.py',
  ],
  'config': [
    '.github/workflows/e2e.yml',
    'vitest.config.ts',
    'wrangler.toml',
  ],
  'tests': [
    'e2e/invoice-health.spec.ts',
    'e2e/rls-health.spec.ts',
    'supabase/functions/backup-database/index.test.ts',
    'supabase/functions/create-invoice-payment/index.test.ts',
    'supabase/functions/get-booking-invoice/index.test.ts',
    'supabase/functions/render-page/index.test.ts',
    'supabase/functions/send-priority-claim-invitation/index.test.ts',
    'supabase/functions/sitemap/index.test.ts',
    'tests/rebooking-enforcement.spec.ts',
  ],
  'sql-reference': [
    // token appears only in a run-instruction COMMENT — not a live anon consumer, registered for honesty
    'supabase/migrations/20260610220000_enforce_booking_slot_tier.sql',
  ],
};

// ── Filesystem walk + classification ────────────────────────────────────────────────────────────────────────
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

const rel = (rootDir, abs) => relative(rootDir, abs).split(sep).join('/');
const underRoot = (p, root) => p === root || p.startsWith(root + '/');

// One walk, all buckets — paths are relative to rootDir (rootDir='.' for the real run; a temp dir for tests).
function classify(rootDir) {
  const foundSource = new Set(), foundSql = new Set(), foundAnon = new Set(), escapes = [], elevated = [];
  const files = [];
  walk(rootDir, files);
  for (const abs of files) {
    const p = rel(rootDir, abs);
    const s = readFileSync(abs, 'utf8'); // no size cap — an authoritative inventory never silently skips source
    const consumer = KEY_FAMILY.test(s) || HELPER_SIGNAL.test(s);
    // A .sql statement that SENDS/STORES the key belongs in supabase/migrations (tracked by MANAGED_SQL). One
    // anywhere else is a misplaced legacy-key touchpoint the SOURCE signals miss — cron SQL names the key
    // LOWERCASE (service_role_key / app.settings / vault), which the uppercase env family never matches.
    const misplacedSqlSender = p.endsWith('.sql') && !underRoot(p, SQL_ROOT) && SQL_SENDER(s);
    // CRITICAL: an elevated (RLS-bypassing) key in the shipped browser bundle is a public-surface leak.
    if (isBrowserSurface(p) && ELEVATED.test(s)) elevated.push(p);
    // Anon inventory — every anon/publishable consumer (docs .md are references, not consumers).
    if (!p.endsWith('.md') && ANON_FAMILY.test(s)) foundAnon.add(p);
    if (underRoot(p, SQL_ROOT)) {
      if (p.endsWith('.sql') && SQL_SENDER(s)) foundSql.add(p);
    } else if (SOURCE_ROOTS.some((r) => underRoot(p, r))) {
      if (consumer) foundSource.add(p);
      if (misplacedSqlSender) escapes.push(p);
    } else if ((consumer || misplacedSqlSender) && !isAllowedOutside(p)) {
      escapes.push(p);
    }
  }
  return { foundSource, foundSql, foundAnon, escapes, elevated };
}

// ── SQL lifecycle: enforce active/superseded against the migration files (NOT just metadata) ────────────────
// Extract cron job names a migration schedules/unschedules/alters, so we can prove: a `superseded` entry really
// has a LATER migration touching one of its job names, and an `active`/`active-legacy` entry is NOT itself later
// superseded. Migrations sort lexicographically by their timestamped filename.
const jobNames = (s) => [...s.matchAll(/cron\.(?:schedule|unschedule|alter_job)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
function checkSqlLifecycle(rootDir, registry = MANAGED_SQL) {
  const problems = [];
  const migDir = join(rootDir, SQL_ROOT);
  if (!existsSync(migDir)) return problems;
  const all = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort(); // lexical = chronological
  const jobsOf = {};
  for (const f of all) jobsOf[f] = new Set(jobNames(readFileSync(join(migDir, f), 'utf8')));
  const base = (p) => p.split('/').pop();
  for (const [path, meta] of Object.entries(registry)) {
    const file = base(path);
    const jobs = jobsOf[file] || new Set();
    const laterTouchers = all.filter((f) => f > file && [...(jobsOf[f] || [])].some((j) => jobs.has(j)));
    const supersededByFiles = laterTouchers.length > 0;
    if (meta.status === 'superseded') {
      if (!supersededByFiles) problems.push(`${path}: registered 'superseded' but NO later migration touches its job names ${[...jobs].join(',') || '(none found)'} — status is stale.`);
      else if (meta.replacement && !laterTouchers.some((f) => meta.replacement.includes(f))) {
        problems.push(`${path}: 'superseded' replacement should be one of [${laterTouchers.join(', ')}] but is '${meta.replacement}'.`);
      }
    } else { // active / active-legacy
      if (supersededByFiles) problems.push(`${path}: registered '${meta.status}' but LATER migration(s) [${laterTouchers.join(', ')}] reschedule/unschedule its job names — it is actually superseded.`);
    }
  }
  return problems;
}

function diff(found, registered) {
  return {
    unregistered: [...found].filter((f) => !registered.has(f)).sort(),
    stale: [...registered].filter((f) => !found.has(f)).sort(),
  };
}

// ── Self-test: prove the detection + diff logic against fixtures (run with --self-test) ─────────────────────
function selfTest() {
  const fails = [];
  let n = 0;
  const ok = (cond, msg) => { n++; if (!cond) fails.push(msg); };

  // predicates
  ok(KEY_FAMILY.test('SUPABASE_SERVICE_ROLE_KEY'), 'literal must match');
  ok(KEY_FAMILY.test('TARGET_SERVICE_ROLE_KEY') && KEY_FAMILY.test('SOURCE_SERVICE_ROLE_KEY'), 'SOURCE_/TARGET_ aliases must match');
  ok(!KEY_FAMILY.test('const totallyUnrelated = 1'), 'benign string must not match the family');
  ok(HELPER_SIGNAL.test('import { requireServiceRole } from "../_shared/auth.ts"'), 'requireServiceRole import must match');
  ok(HELPER_SIGNAL.test('requireServiceRoleOrAdmin(req)') && HELPER_SIGNAL.test('isServiceRoleRequest(req)'), 'OrAdmin + isServiceRoleRequest must match');
  ok(HELPER_SIGNAL.test('const k = getEnvServiceRoleKey();'), 'getEnvServiceRoleKey must match (regression: keep it in HELPER_SIGNAL)');
  ok(HELPER_SIGNAL.test('resolveServiceRoleToken(req)'), 'resolveServiceRoleToken must match (regression: keep it in HELPER_SIGNAL)');
  ok(HELPER_SIGNAL.test('from "../_shared/service-role-auth.ts"'), 'service-role-auth module import must match');
  ok(!HELPER_SIGNAL.test('"supabase/functions/_shared/service-role-auth.ts|TS2304|x": 1'), 'a bare path mention (baseline key) must NOT match');
  ok(SQL_SENDER("net.http_post(url, jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='service_role_key')))"), 'sql sender (http_post + auth header + vault cred) must match');
  ok(SQL_SENDER("select vault.create_secret('x','service_role_key')"), 'vault store must match as sql sender');
  ok(!SQL_SENDER('-- SUPABASE_SERVICE_ROLE_KEY=... (comment, no http_post)'), 'sql comment-only must NOT be a sender');
  ok(scannable('deploy') && scannable('tool.rb'), 'extensionless + unknown-extension files must be scannable');
  ok(!scannable('logo.png') && !scannable('.env.e2e'), 'binary + env files must be skipped');
  ok(isAllowedOutside('docs/x.md') && isAllowedOutside('src/test/a.test.ts') && isAllowedOutside('supabase/config.toml'), 'docs/test/config allowed outside roots');
  ok(!isAllowedOutside('workers/rogue.ts'), 'a NEW runtime root must NOT be allowed outside');

  // diff logic (unregistered + stale)
  const du = diff(new Set(['a', 'c']), new Set(['a']));
  ok(du.unregistered.length === 1 && du.unregistered[0] === 'c', 'diff flags an unregistered consumer');
  const ds = diff(new Set(['a']), new Set(['a', 'b']));
  ok(ds.stale.length === 1 && ds.stale[0] === 'b', 'diff flags a stale registration');

  // end-to-end walk + classify against a temp fixture tree
  const tmp = mkdtempSync(join(tmpdir(), 'legacy-key-guard-'));
  try {
    const w = (r, body) => { const p = join(tmp, r); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
    w('supabase/functions/x/index.ts', 'const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");');
    w('scripts/migration/alias.py', 'k = os.environ["TARGET_SERVICE_ROLE_KEY"]');
    w('scripts/helperonly.ts', 'import { requireServiceRole } from "../_shared/auth.ts"; export default requireServiceRole;');
    w('scripts/deploy', '#!/bin/sh\ncurl -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" "$URL"');
    w('scripts/logo.png', 'SUPABASE_SERVICE_ROLE_KEY'); // must be SKIPPED by extension despite the literal
    w('scripts/nothing.ts', 'export const two = 1 + 1;'); // benign, must NOT be found
    w('supabase/migrations/m.sql', "perform net.http_post(url, jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='service_role_key')));");
    w('supabase/migrations/note.sql', '-- SUPABASE_SERVICE_ROLE_KEY=xxx (comment only, not a sender)');
    w('workers/rogue.ts', 'const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");'); // NEW root → escape
    w('docs/x.md', 'the runbook mentions SUPABASE_SERVICE_ROLE_KEY'); // allowed outside
    // key-sending SQL OUTSIDE supabase/migrations — LOWERCASE key (no uppercase family match), must still escape:
    w('scripts/db/rogue-cron.sql', "select net.http_post(url:='https://x', headers:=jsonb_build_object('Authorization','Bearer '||current_setting('app.settings.service_role_key')));"); // under a source root
    w('db/crons/store.sql', "select vault.create_secret('eyJ','service_role_key');"); // under a brand-new root
    w('scripts/db/report.sql', 'select count(*) from invoices;'); // benign SQL, must NOT escape
    // helper-only fixtures whose SOLE signal is one otherwise-uncovered helper token (end-to-end regression guard):
    w('scripts/gesonly.ts', 'export const k = getEnvServiceRoleKey();'); // only getEnvServiceRoleKey
    w('scripts/rstonly.ts', 'export const t = resolveServiceRoleToken(req);'); // only resolveServiceRoleToken
    // anon inventory: a new SUPABASE_ANON_KEY consumer must be FOUND (so an unregistered one fails the diff):
    w('supabase/functions/anonymous/index.ts', 'const k = Deno.env.get("SUPABASE_ANON_KEY");');
    // public-surface ELEVATION: an sb_secret_ / service-role key in the shipped browser bundle must be flagged:
    w('src/pages/Leak.tsx', 'const k = "sb_secret_deadbeef";'); // elevated leak → must be caught
    w('src/pages/Ok.tsx', 'const k = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;'); // publishable → anon, not elevated
    w('src/test/fixture.test.ts', 'const k = "sb_secret_testonly";'); // src/test is not the shipped bundle → not elevated
    // differently-NAMED Vault credential sender (finding 3): structural detection, no `service_role_key` literal:
    w('supabase/migrations/altcred.sql', "select net.http_post(url:='x', headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='worker_credential')));");
    const { foundSource, foundSql, foundAnon, escapes, elevated } = classify(tmp);
    ok(foundSource.has('supabase/functions/x/index.ts'), 'fixture: literal consumer detected');
    ok(foundSource.has('scripts/migration/alias.py'), 'fixture: TARGET_ alias consumer detected');
    ok(foundSource.has('scripts/helperonly.ts'), 'fixture: helper-only consumer detected');
    ok(foundSource.has('scripts/gesonly.ts'), 'fixture: getEnvServiceRoleKey-only consumer detected');
    ok(foundSource.has('scripts/rstonly.ts'), 'fixture: resolveServiceRoleToken-only consumer detected');
    ok(foundSource.has('scripts/deploy'), 'fixture: extensionless consumer detected');
    ok(!foundSource.has('scripts/logo.png'), 'fixture: png with literal is skipped');
    ok(!foundSource.has('scripts/nothing.ts'), 'fixture: benign file not detected');
    ok(foundSql.has('supabase/migrations/m.sql'), 'fixture: SQL sender detected');
    ok(!foundSql.has('supabase/migrations/note.sql'), 'fixture: SQL comment-only not a sender');
    ok(escapes.includes('workers/rogue.ts'), 'fixture: NEW-root escape detected');
    ok(!escapes.includes('docs/x.md'), 'fixture: docs .md not an escape');
    ok(escapes.includes('scripts/db/rogue-cron.sql'), 'fixture: lowercase key-sending .sql under a source root escapes');
    ok(escapes.includes('db/crons/store.sql'), 'fixture: vault.create_secret .sql under a new root escapes');
    ok(!escapes.includes('scripts/db/report.sql'), 'fixture: benign .sql does not escape');
    ok(foundAnon.has('supabase/functions/anonymous/index.ts'), 'fixture: SUPABASE_ANON_KEY consumer detected (unregistered → fails diff)');
    ok(foundAnon.has('src/pages/Ok.tsx'), 'fixture: VITE publishable consumer detected in the anon inventory');
    ok(elevated.includes('src/pages/Leak.tsx'), 'fixture: sb_secret_ in the browser bundle is flagged as an elevation leak');
    ok(!elevated.includes('src/pages/Ok.tsx'), 'fixture: a publishable key in the browser is NOT an elevation');
    ok(!elevated.includes('src/test/fixture.test.ts'), 'fixture: src/test is not the shipped bundle → sb_secret_ there is not an elevation');
    ok(foundSql.has('supabase/migrations/altcred.sql'), 'fixture: differently-NAMED Vault credential sender detected (structural, no service_role_key literal)');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // SQL lifecycle enforcement: a registered 'active' entry that a LATER migration supersedes must be flagged.
  const lc = mkdtempSync(join(tmpdir(), 'legacy-key-lc-'));
  try {
    const w = (r, body) => { const p = join(lc, r); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
    w('supabase/migrations/20260101000000_a.sql', "select cron.schedule('job-x', '* * * * *', $$ ... $$);");
    w('supabase/migrations/20260202000000_b.sql', "select cron.unschedule('job-x'); select cron.schedule('job-x', '* * * * *', $$ ... $$);");
    const staleReg = { 'supabase/migrations/20260101000000_a.sql': { status: 'active', replacement: '-' } };
    ok(checkSqlLifecycle(lc, staleReg).length > 0, 'lifecycle: an active entry superseded by a later migration is flagged');
    const okReg = { 'supabase/migrations/20260101000000_a.sql': { status: 'superseded', replacement: '20260202000000_b.sql' } };
    ok(checkSqlLifecycle(lc, okReg).length === 0, 'lifecycle: correctly-superseded entry passes');
  } finally {
    rmSync(lc, { recursive: true, force: true });
  }

  // the real, checked-in baseline must pass every check
  const real = classify('.');
  const rs = diff(real.foundSource, new Set(Object.values(MANAGED).flat()));
  const rq = diff(real.foundSql, new Set(Object.keys(MANAGED_SQL)));
  const ra = diff(real.foundAnon, new Set(Object.values(MANAGED_ANON).flat()));
  ok(rs.unregistered.length === 0 && rs.stale.length === 0, `real SOURCE baseline clean (unreg=${rs.unregistered.length}, stale=${rs.stale.length})`);
  ok(rq.unregistered.length === 0 && rq.stale.length === 0, `real SQL baseline clean (unreg=${rq.unregistered.length}, stale=${rq.stale.length})`);
  ok(ra.unregistered.length === 0 && ra.stale.length === 0, `real ANON baseline clean (unreg=${ra.unregistered.length}, stale=${ra.stale.length})`);
  ok(real.escapes.length === 0, `real escape scan clean (escapes=${real.escapes.length})`);
  ok(real.elevated.length === 0, `real browser bundle has NO elevated key (elevated=${real.elevated.length})`);
  ok(checkSqlLifecycle('.').length === 0, 'real SQL lifecycle statuses match the migration files');

  if (fails.length) {
    console.error(`SELF-TEST FAILED — ${fails.length}/${n} assertions:`);
    fails.forEach((f) => console.error('  ✗ ' + f));
    process.exit(1);
  }
  console.log(`OK — self-test passed (${n} assertions incl. the real baseline).`);
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) selfTest();

const { foundSource, foundSql, foundAnon, escapes, elevated } = classify('.');
const src = diff(foundSource, new Set(Object.values(MANAGED).flat()));
const sql = diff(foundSql, new Set(Object.keys(MANAGED_SQL)));
const anon = diff(foundAnon, new Set(Object.values(MANAGED_ANON).flat()));
const lifecycle = checkSqlLifecycle('.');
const problems = [];

if (src.unregistered.length) {
  problems.push(
    'UNREGISTERED SOURCE consumers — reference the key but are not in MANAGED. Each must be migrated (or proven)\n' +
    'in Path B before the legacy key can be deactivated. Add each to the correct category:\n' +
    src.unregistered.map((f) => '  + ' + f).join('\n'));
}
if (src.stale.length) {
  problems.push('STALE SOURCE registrations — no longer reference the key; remove to keep the inventory honest:\n' +
    src.stale.map((f) => '  - ' + f).join('\n'));
}
if (sql.unregistered.length) {
  problems.push(
    'UNREGISTERED SQL/Vault consumers — migrations that send/store the key but are not in MANAGED_SQL. Classify\n' +
    'each (active / active-legacy / superseded) + its forward replacement in check-legacy-service-role-consumers.mjs:\n' +
    sql.unregistered.map((f) => '  + ' + f).join('\n'));
}
if (sql.stale.length) {
  problems.push('STALE SQL/Vault registrations — no longer send/store the key (were they edited? migrations are immutable):\n' +
    sql.stale.map((f) => '  - ' + f).join('\n'));
}
if (escapes.length) {
  problems.push(
    'ESCAPED references — a legacy-key touchpoint sits where the source + SQL registries do not enforce it:\n' +
    '  • the key/helper OUTSIDE the guarded roots + out-of-scope allow-list (docs .md / src/test / tests /\n' +
    '    supabase/config.toml) — a runtime consumer under a new root must join SOURCE_ROOTS + be registered; or\n' +
    '  • a .sql statement that SENDS/STORES the key (http_post with a credential source in an auth header, or\n' +
    '    vault.create/update_secret) outside supabase/migrations — move it into a tracked migration (MANAGED_SQL).\n' +
    'Anything genuinely benign must be added to the allow-list deliberately:\n' +
    escapes.sort().map((f) => '  ! ' + f).join('\n'));
}
if (anon.unregistered.length) {
  problems.push(
    'UNREGISTERED ANON consumers — reference the legacy anon/publishable key but are not in MANAGED_ANON. The anon\n' +
    'key migrates to sb_publishable_ (low-privilege, RLS-respecting) — NEVER sb_secret_. Register each:\n' +
    anon.unregistered.map((f) => '  + ' + f).join('\n'));
}
if (anon.stale.length) {
  problems.push('STALE ANON registrations — no longer reference the anon/publishable key; remove them:\n' +
    anon.stale.map((f) => '  - ' + f).join('\n'));
}
if (elevated.length) {
  problems.push(
    'PUBLIC-SURFACE ELEVATION — an RLS-BYPASSING key (sb_secret_ / *_SERVICE_ROLE_KEY) appears in the shipped\n' +
    'browser bundle (src/, excluding tests). This must NEVER reach a browser; the public client uses the anon /\n' +
    'sb_publishable_ key only. Remove it:\n' +
    elevated.sort().map((f) => '  ‼ ' + f).join('\n'));
}
if (lifecycle.length) {
  problems.push(
    'SQL LIFECYCLE drift — a MANAGED_SQL active/superseded status contradicts the migration files (a later\n' +
    'migration reschedules/unschedules the job, or a superseded entry has no such later migration):\n' +
    lifecycle.map((m) => '  ~ ' + m).join('\n'));
}

if (problems.length) {
  console.error('Legacy API-key inventory drift (service_role + anon are disabled as a pair — both must stay clean):\n');
  console.error(problems.join('\n\n'));
  console.error('\nSee docs/CRON_SERVICE_KEY_SETUP.md → "The legacy service-role-key dependency class" / "Path B".');
  process.exit(1);
}

const counts = Object.entries(MANAGED).map(([k, v]) => `${k}=${v.length}`).join(', ');
const sqlActive = Object.values(MANAGED_SQL).filter((v) => v.status.startsWith('active')).length;
const anonCount = new Set(Object.values(MANAGED_ANON).flat()).size;
console.log(
  `OK — ${new Set(Object.values(MANAGED).flat()).size} service-role source consumers (${counts}); ` +
  `${Object.keys(MANAGED_SQL).length} SQL/Vault migrations (${sqlActive} active, lifecycle verified); ` +
  `${anonCount} anon/publishable consumers; no elevated key in the browser bundle; no references outside guarded roots.`);
