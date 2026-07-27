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
 * migrates service_role → sb_secret_ (trusted backend) and anon → sb_publishable_ (browser/public).
 *
 * TWO distinct contracts (do not conflate):
 *   • INVENTORY completeness (the normal run + `--self-test`, both CI-gated): every legacy-key consumer is
 *     REGISTERED. GREEN TODAY, everything still on the legacy keys — it does NOT prove migration. Migration makes
 *     a consumer DROP its legacy signal, so STALE is STATE-AWARE (a dropped signal is a problem only if the path's
 *     state is still 'legacy'), which keeps CI green through migration.
 *   • MIGRATION completion (`--require-migrated`, an on-demand CUTOVER gate, NOT run in normal CI): FAILS until
 *     every production consumer has moved off the legacy keys, read from the explicit per-path STATE registry
 *     (legacy default; new-secret/publishable; local-demo/tooling/retired exemptions) — NOT from signal
 *     disappearance, and NOT from env-name/helper NAMES (dependency signals, not credential state). It first
 *     re-runs the inventory (an unregistered consumer would be invisible otherwise). See STATE + requireMigrated()
 *     + inventoryProblems().
 *
 * A shared, decoded inline-JWT classifier routes an inline `eyJ….eyJ….` token by its ROLE claim into the right
 * inventory (service_role → source; anon → anon), and the SQL sender detects an inline JWT under Bearer OR an
 * apikey / x-api-key header — so an inline credential cannot bypass any inventory.
 *
 * Inventory checks (run `node …`; `--self-test` exercises them):
 *   (1) SOURCE (service_role) consumers — content-scans the runtime source roots (supabase/functions, api,
 *       scripts); a consumer = the env-name family, a shared helper, OR an inline service_role JWT. Fails on a
 *       NEW/STALE mismatch vs MANAGED. Content scan, NOT an extension allow-list.
 *   (2) SQL/Vault consumers — scans supabase/migrations for cron commands that SEND the key (an http_post whose
 *       auth header carries a decrypted Vault secret / current_setting / inline JWT) or STORE it in Vault, against
 *       MANAGED_SQL. Detection is STRUCTURAL (not coupled to the secret's name). Migrations are immutable, so
 *       MANAGED_SQL tracks LIFECYCLE (active / active-legacy / superseded) + forward replacement; check (5)
 *       static-checks that status (best-effort — see (5)).
 *   (3) ANON consumers — the anon → sb_publishable_ side. Every `*_ANON_KEY`/`*_PUBLISHABLE_KEY` consumer must be
 *       in MANAGED_ANON (browser-public / edge-anon / config / scripts-ci / tests).
 *   (4) BROWSER-SURFACE elevation — an RLS-bypassing key (`sb_secret_`, a `*_SERVICE_ROLE_KEY` name, or an INLINE
 *       service_role JWT decoded by its role claim) in a public surface FAILS: the shipped browser bundle
 *       (`src/`, excluding tests) AND the non-`src` `browser-public` members (e.g. the Cloudflare worker).
 *   (5) SQL lifecycle (static, BEST-EFFORT) — checks each MANAGED_SQL active/superseded status against later
 *       migrations touching the same QUOTED cron job name. It does NOT follow alter_job(jobid) (numeric id),
 *       dynamic/variable job names, or definition-vs-execution — so a live `cron.job` query is a mandatory cutover
 *       gate; do not treat this as proof of the running scheduler.
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
// Strip SQL comments (line `--` + block `/* */`) so lifecycle/sender decisions trust only EXECUTABLE statements,
// never a commented-out or illustrative `cron.unschedule(...)` / `http_post(...)`.
const stripSqlComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
// STRUCTURAL sender detection (NOT coupled to the secret's name): a POST (`net.http_post`/`http_post`, or the
// generic `http(('POST', …)::http_request)`) whose auth header (Authorization/Bearer/api[-_]key) carries a
// CREDENTIAL — a decrypted Vault secret, a `current_setting`, or an INLINE `Bearer eyJ…` JWT hardcoded in the
// command. Any of those is a legacy-key send regardless of the secret's NAME. Plus any Vault create/update.
// LIMITATION (documented, not silently trusted): detection is SINGLE-FILE + in-file sourcing — a sender that
// pulls the key from a SECURITY DEFINER helper defined in ANOTHER migration (`Bearer '||get_key()`) is not
// traced; scope the "cannot slip past" claim to in-file/inline sourcing.
// Inline JWT is matched as a full `eyJ….eyJ….` token (NOT only after `Bearer`), so a JWT under an apikey /
// x-api-key header is caught too. SCOPE: this (and every regex signal here) assumes a CONTIGUOUS, canonically
// base64url-encoded token in one file — a legacy JWT is issued that way and can't be reformatted without breaking
// its signature; string-concatenation/split obfuscation is out of scope (shared with KEY_FAMILY/ANON_FAMILY).
const CRED_SOURCE = /vault\.decrypted_secrets|decrypted_secret|current_setting|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./;
const AUTH_HEADER = /authorization|api[-_]?key|bearer/i; // matches apikey, api-key, x-api-key, Authorization, Bearer
// A POST via pg_net (`net.http_post(`), the http extension's `http_post(`, OR the generic `http((…)` / `http(ROW(…)`
// with a 'POST' method — so the double-paren cast and ROW-constructor request forms are both caught.
const HTTP_POST = /\bhttp_post\s*\(|\bhttp\s*\(\s*(?:\(|ROW\s*\()\s*'POST'/i;
const SQL_SENDER = (raw) => { const s = stripSqlComments(raw); return (HTTP_POST.test(s) && AUTH_HEADER.test(s) && CRED_SOURCE.test(s)) || /vault\.(create|update)_secret/.test(s); };

// ONE decoded inline-JWT classifier, used by ALL inventories: an inline `eyJ….eyJ….` token is a legacy-key
// consumer of whatever ROLE its payload declares (anon/service_role are prefix-identical `eyJ…`, so we decode the
// role claim rather than prefix-match). service_role → service-role inventory; anon → anon inventory.
const inlineJwtRoles = (s) => {
  const roles = new Set();
  for (const m of s.matchAll(/eyJ[A-Za-z0-9_-]+\.(eyJ[A-Za-z0-9_-]+)\./g)) {
    try { const r = (JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) || {}).role; if (r) roles.add(r); } catch { /* not a JWT */ }
  }
  return roles;
};
const hasInlineServiceRoleJwt = (s) => inlineJwtRoles(s).has('service_role');
const hasInlineAnonJwt = (s) => inlineJwtRoles(s).has('anon');

// The legacy `anon`/`service_role` keys are DISABLED AS A PAIR, so Path B is TWO migrations: service_role →
// sb_secret_ (trusted backend) and anon → sb_publishable_ (browser/public). This family inventories the anon side.
const ANON_FAMILY = /[A-Z0-9_]*ANON_KEY|[A-Z0-9_]*PUBLISHABLE_KEY/;
// Elevated, RLS-bypassing credentials that must NEVER reach the browser/public bundle: the sb_secret_ key, a
// `*_SERVICE_ROLE_KEY` env name, OR an INLINE service_role JWT (decoded role claim).
const ELEVATED = /sb_secret_|[A-Z0-9_]*SERVICE_ROLE_KEY/;
const isElevated = (s) => ELEVATED.test(s) || hasInlineServiceRoleJwt(s);
// Public surfaces that must never hold an elevated key: the shipped browser bundle (src/, excluding tests) AND
// the non-src browser-public members of MANAGED_ANON (e.g. the Cloudflare worker, which Bearers its key on every
// forwarded public request). MANAGED_ANON is defined below; reference it lazily inside the check.
const isBrowserSurface = (p) =>
  (p.startsWith('src/') && !p.startsWith('src/test/') && !p.includes('/__tests__/') && !/\.(test|spec)\.[a-z]+$/.test(p))
  || MANAGED_ANON['browser-public'].includes(p);

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
const isAllowedOutside = (p) => p.endsWith('.md') || p.startsWith('src/test/') || p.startsWith('tests/') || p.startsWith('e2e/') || p === 'supabase/config.toml';

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
// EVERY migration that sends a legacy key via cron/http_post (service_role OR anon; via Vault, app.settings, or
// an INLINE JWT) or stores one in Vault — Path B must see them all (both keys are disabled as a pair).
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
  // INLINE-JWT senders — hardcode a legacy ANON `eyJ…` JWT directly in the http_post (no Vault/current_setting).
  // Caught structurally by the inline-`Bearer eyJ…` signal. Both are superseded (their enrich/logo jobs are later
  // unscheduled), so no live send today — but they are the concrete inline-token class Path B must still see.
  'supabase/migrations/20260222155701_05809654-6a87-4ce8-a309-fe0a86f678b9.sql':
    { status: 'superseded', note: 'enrich-clubs / enrich-locations-background via an INLINE anon JWT', replacement: '20260606120000_phase5_email_idempotency_and_cron_ficwb.sql (job later unscheduled)' },
  'supabase/migrations/20260205091805_be8721ba-3deb-44bf-b609-56168438ad20.sql':
    { status: 'superseded', note: 'fetch-location-logos-background via an INLINE anon JWT', replacement: '20260606120000_phase5_email_idempotency_and_cron_ficwb.sql (job later unscheduled)' },
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
    'scripts/db/e2e-local-paid.sh', // inline anon (local supabase-demo demo key) for the e2e harness
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
    // e2e/local specs embed the well-known local supabase-demo anon + service_role JWTs (public demo keys):
    'e2e/local/public-booking-webhook.spec.ts',
    'e2e/local/rebook-send-side.spec.ts',
    'e2e/local/rebook-upfront-pay.spec.ts',
    'e2e/local/rebook-upfront-webhook.spec.ts',
    'supabase/functions/backup-database/index.test.ts',
    'supabase/functions/create-invoice-payment/index.test.ts',
    'supabase/functions/get-booking-invoice/index.test.ts',
    'supabase/functions/render-page/index.test.ts',
    'supabase/functions/send-priority-claim-invitation/index.test.ts',
    'supabase/functions/sitemap/index.test.ts',
    'tests/rebooking-enforcement.spec.ts',
  ],
};

// ── Cutover contract: a DURABLE per-path STATE registry (inventory-complete ≠ migration-complete) ────────────
// Inventory completeness (the normal run) proves every consumer is REGISTERED — green today, everything on the
// legacy keys. Migration completion is tracked EXPLICITLY per path, because migration makes a consumer DROP its
// legacy signal (a signal-disappearance model would then wrongly flag it "stale" and the gate could never pass),
// and because a DEPENDENCY signal (an env-NAME slot, or a shared-helper name like requireServiceRole) does NOT
// prove the credential is still legacy — the value is deployed and the helper can move to sb_secret_ under an
// unchanged name. Each path carries an explicit STATE (unlisted = 'legacy'):
//   legacy       — a PRODUCTION consumer still on the legacy key. Must migrate before the pair is disabled.
//   new-secret   — migrated to sb_secret_ (trusted backend). Set only AFTER the deployed value is verified.
//   publishable  — migrated to sb_publishable_ (browser/public). Set only AFTER the deployed value is verified.
//   local-demo   — uses public supabase-demo / local-dev keys; never a production credential (reviewed exemption).
//   tooling      — CI/guard/config machinery that names the key but isn't a runtime credential consumer.
//   retired      — a one-off historical script that will not run against the disabled key.
// The cutover (`--require-migrated`) fails while any NON-exempt path is 'legacy', or a migrated path still carries
// a HARD legacy-credential residue in source (an inline legacy JWT; for SQL also service_role_key / app.settings).
const STATE = {
  // tooling
  'scripts/check-legacy-service-role-consumers.mjs': 'tooling', 'scripts/check-edge-fn-config.mjs': 'tooling',
  'vitest.config.ts': 'tooling', '.github/workflows/e2e.yml': 'tooling',
  // wrangler.toml only NAMES SUPABASE_ANON_KEY in a comment (keep_vars=true) — the worker's real anon-key VALUE is a
  // Cloudflare dashboard var, not in this file. So the file holds no credential to migrate; the worker's actual key
  // is covered by the runbook's deployed-VALUE verification (CF dashboard), not a source edit. Same class as its
  // MANAGED_ANON['config'] siblings above (both already tooling).
  'wrangler.toml': 'tooling',
  // local-demo (public supabase-demo / local-dev keys)
  'scripts/db/seed-local.ts': 'local-demo', 'scripts/db/e2e-local-paid.sh': 'local-demo',
  'e2e/invoice-health.spec.ts': 'local-demo', 'e2e/rls-health.spec.ts': 'local-demo',
  'e2e/local/public-booking-webhook.spec.ts': 'local-demo', 'e2e/local/rebook-send-side.spec.ts': 'local-demo',
  'e2e/local/rebook-upfront-pay.spec.ts': 'local-demo', 'e2e/local/rebook-upfront-webhook.spec.ts': 'local-demo',
  'tests/rebooking-enforcement.spec.ts': 'local-demo',
  'supabase/functions/_shared/auth.test.ts': 'local-demo', 'supabase/functions/_shared/digest-worker-entry.test.ts': 'local-demo',
  'supabase/functions/_shared/digest-worker-handler.test.ts': 'local-demo', 'supabase/functions/_shared/service-role-auth.test.ts': 'local-demo',
  'supabase/functions/backup-database/index.test.ts': 'local-demo', 'supabase/functions/create-invoice-payment/index.test.ts': 'local-demo',
  'supabase/functions/get-booking-invoice/index.test.ts': 'local-demo', 'supabase/functions/render-page/index.test.ts': 'local-demo',
  'supabase/functions/send-priority-claim-invitation/index.test.ts': 'local-demo', 'supabase/functions/sitemap/index.test.ts': 'local-demo',
  // retired (one-off historical migration scripts)
  'scripts/migration/auth_import_dry_run.py': 'retired', 'scripts/migration/auth_import_users.py': 'retired',
  'scripts/migration/auth_verify_pre_public_import.py': 'retired', 'scripts/migration/ficwb_secrets_audit.py': 'retired',
  'scripts/migration/storage_common.py': 'retired', 'scripts/migration/storage_copy_buckets.py': 'retired',
  'scripts/migration/storage_copy_invoices.py': 'retired', 'scripts/migration/storage_fix_missing_from_db.py': 'retired',
  'scripts/migration/storage_migration_dry_run.py': 'retired', 'scripts/migration/storage_regenerate_invoice_urls.py': 'retired',
  'scripts/migration/storage_regenerate_invoices_via_edge.py': 'retired',
};
const stateOf = (p, state = STATE) => state[p] || 'legacy';
const EXEMPT = new Set(['local-demo', 'tooling', 'retired']); // not a production credential to migrate
// HARD legacy-credential residue in SOURCE (the only migration proof source can give — env names are slots, helper
// names are dependencies): an inline legacy JWT; for SQL also the service_role_key / app.settings legacy sources.
const hardLegacyResidue = (p, s) => p.endsWith('.sql')
  ? (inlineJwtRoles(stripSqlComments(s)).size > 0 || /service_role_key|app\.settings/i.test(stripSqlComments(s)))
  : (hasInlineServiceRoleJwt(s) || hasInlineAnonJwt(s));
// Only these SQL statuses are meaningful; a typo (`'Active'`, `'live'`) would otherwise silently escape BOTH the
// cutover gate (`startsWith('active')` is exact) and the lifecycle check — inventoryProblems() flags any unknown.
const VALID_SQL_STATUS = new Set(['active', 'active-legacy', 'superseded']);

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
    // Source (service-role) consumer: the env-name family, a shared helper, OR an inline service_role JWT.
    const consumer = KEY_FAMILY.test(s) || HELPER_SIGNAL.test(s) || hasInlineServiceRoleJwt(s);
    // A .sql statement that SENDS/STORES the key belongs in supabase/migrations (tracked by MANAGED_SQL). One
    // anywhere else is a misplaced legacy-key touchpoint the SOURCE signals miss — cron SQL names the key
    // LOWERCASE (service_role_key / app.settings / vault), which the uppercase env family never matches.
    const misplacedSqlSender = p.endsWith('.sql') && !underRoot(p, SQL_ROOT) && SQL_SENDER(s);
    // CRITICAL: an elevated (RLS-bypassing) key in the shipped browser bundle is a public-surface leak.
    if (isBrowserSurface(p) && isElevated(s)) elevated.push(p);
    // Anon inventory — every anon/publishable consumer: the env-name family OR an inline anon JWT. (docs .md are
    // references; .sql inline anon JWTs are the SQL inventory's domain — MANAGED_SQL — so exclude them here.)
    if (!p.endsWith('.md') && !p.endsWith('.sql') && (ANON_FAMILY.test(s) || hasInlineAnonJwt(s))) foundAnon.add(p);
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
// superseded. Migrations sort lexicographically by their timestamped filename. INVARIANT (all real migrations
// hold it): job names are QUOTED STRING LITERALS. Known, reviewed exceptions (fail-open / fail-closed, none live
// today): a DYNAMIC scheduler — cron.(un)schedule(variable) or format('… cron.%schedule …') — is untracked;
// cron.alter_job is keyed by NUMERIC job_id in real pg_cron, so an alter_job(id, active:=false) disable is not
// seen; and a job's OWNED schedule is not distinguished from a CLEANUP unschedule of another migration's job.
const jobNames = (s) => [...s.matchAll(/cron\.(?:schedule|unschedule|alter_job)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
function checkSqlLifecycle(rootDir, registry = MANAGED_SQL) {
  const problems = [];
  const migDir = join(rootDir, SQL_ROOT);
  if (!existsSync(migDir)) return problems;
  const all = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort(); // lexical = chronological
  const jobsOf = {};
  for (const f of all) jobsOf[f] = new Set(jobNames(stripSqlComments(readFileSync(join(migDir, f), 'utf8'))));
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

// Cutover gate: every registered NON-exempt path must be migrated (state new-secret/publishable) and carry no
// HARD legacy residue in source. Migration is read from the explicit STATE registry — NOT from signal
// disappearance — so a migrated path (which drops its legacy env-name signal) is proven by its state, not flagged.
// Parameterized (registries + STATE) so the self-test can exercise every branch on fixtures.
function requireMigrated(rootDir = '.', reg = { managed: MANAGED, anon: MANAGED_ANON, sql: MANAGED_SQL, state: STATE }) {
  const { managed, anon, sql, state } = reg;
  const pending = []; // { path, kind, reason }
  const read = (p) => { try { return readFileSync(join(rootDir, p), 'utf8'); } catch { return ''; } };
  const check = (p, kind) => {
    const st = stateOf(p, state);
    if (EXEMPT.has(st)) return; // reviewed non-production exemption (local-demo / tooling / retired)
    if (st === 'legacy') { pending.push({ path: p, kind, reason: 'state=legacy — a production consumer still on the legacy key' }); return; }
    // migrated (new-secret / publishable): source must carry no hard legacy residue (inline JWT / service_role_key / app.settings)
    if (hardLegacyResidue(p, read(p))) pending.push({ path: p, kind, reason: `state=${st} but source still carries a legacy credential (inline JWT / service_role_key / app.settings)` });
  };
  for (const cat in managed) for (const p of managed[cat]) check(p, 'service-role');
  for (const cat in anon) for (const p of anon[cat]) check(p, 'anon');
  for (const [p, meta] of Object.entries(sql)) if (VALID_SQL_STATUS.has(meta.status) && meta.status.startsWith('active')) check(p, 'sql');
  return pending;
}

// INVENTORY problems used by the cutover precheck (an UNREGISTERED runtime consumer is invisible to requireMigrated,
// which only walks the registries). STALE is STATE-AWARE for source/anon: a registered path that dropped its signal
// is a problem ONLY if its state is still 'legacy' (it migrated but wasn't relabeled) — a migrated/exempt path is
// EXPECTED to have no legacy signal (this is what makes migration reachable). SQL migrations are immutable, so SQL
// stale stays literal.
function inventoryProblems(rootDir = '.', regs = { managed: MANAGED, anon: MANAGED_ANON, sql: MANAGED_SQL, state: STATE }) {
  const { managed, anon, sql, state } = regs;
  const c = classify(rootDir);
  const out = [];
  const staleAware = (found, registered, label) => {
    for (const f of found) if (!registered.has(f)) out.push(`UNREGISTERED ${label}: ${f}`);
    for (const p of registered) if (!found.has(p) && stateOf(p, state) === 'legacy') out.push(`STALE ${label} (state=legacy but no signal — relabel its STATE if migrated, or retire/remove): ${p}`);
  };
  staleAware(c.foundSource, new Set(Object.values(managed).flat()), 'source');
  staleAware(c.foundAnon, new Set(Object.values(anon).flat()), 'anon');
  const sqlReg = new Set(Object.keys(sql));
  for (const f of c.foundSql) if (!sqlReg.has(f)) out.push(`UNREGISTERED sql: ${f}`);
  for (const p of sqlReg) if (!c.foundSql.has(p)) out.push(`STALE sql (immutable migration no longer sends the key?): ${p}`);
  // An unknown status (typo like 'Active'/'live') would silently escape BOTH cutover (exact startsWith('active'))
  // AND lifecycle — surface it as an inventory problem so the normal guard + cutover precheck both fail on it.
  for (const [p, meta] of Object.entries(sql)) if (!VALID_SQL_STATUS.has(meta.status)) out.push(`INVALID sql status '${meta.status}' (must be active/active-legacy/superseded): ${p}`);
  c.escapes.forEach((f) => out.push(`ESCAPE: ${f}`));
  c.elevated.forEach((f) => out.push(`BROWSER-ELEVATION: ${f}`));
  checkSqlLifecycle(rootDir, sql).forEach((m) => out.push(`LIFECYCLE: ${m}`));
  return out;
}
const inventoryProblemCount = (rootDir = '.') => inventoryProblems(rootDir).length;

// ── Self-test: prove the detection + diff logic against fixtures (run with --self-test) ─────────────────────
function selfTest() {
  const fails = [];
  let n = 0;
  const ok = (cond, msg) => { n++; if (!cond) fails.push(msg); };
  // Build fixture JWTs at RUNTIME so no literal `eyJ….eyJ….` token appears in this guard's own source (which would
  // make the guard self-classify as a consumer). Header stays a bare `eyJ…` (one segment — never matches).
  const mkJwt = (role) => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.sig';

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
  ok(SQL_SENDER("select vault.update_secret(id, 'newval')"), 'vault.update_secret must match (regression: keep the update alternative)');
  ok(SQL_SENDER("net.http_post(url, jsonb_build_object('apikey', (select decrypted_secret from vault.decrypted_secrets where name='k')))"), 'sql sender via the apikey header must match (regression: Path B moves to apikey)');
  ok(SQL_SENDER("net.http_post(url, jsonb_build_object('Authorization','Bearer " + mkJwt('service_role') + "'))"), 'INLINE-JWT sql sender must match (no vault/current_setting)');
  ok(SQL_SENDER("net.http_post(url, jsonb_build_object('x-api-key','" + mkJwt('service_role') + "'))"), 'INLINE-JWT under an x-api-key header (not Bearer) must match');
  ok(SQL_SENDER("select http(ROW('POST', url, ARRAY[http_header('apikey','" + mkJwt('service_role') + "')], 'application/json', '{}')::http_request)"), 'http(ROW(POST,…)) request-constructor sender must match');
  ok(SQL_SENDER("net.http_post(url, jsonb_build_object('x-api-key', (select decrypted_secret from vault.decrypted_secrets where name='k')))"), 'hyphenated x-api-key header sender must match (regression: keep api[-_]?key)');
  ok(SQL_SENDER("select http(('POST', url, ARRAY[http_header('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='k'))], 'application/json', body)::http_request)"), 'generic http() POST sender must match');
  ok(AUTH_HEADER.test('bearer') && !/authorization|api[-_]?key/i.test('bearer'), 'bearer auth-header alternative is independently pinned');
  ok(!SQL_SENDER("-- net.http_post(url, 'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='k'))"), 'a commented-out sender is NOT a sender (comment stripping)');
  // browser-elevation: inline service_role JWT is elevated; inline anon JWT is not (decode the role claim):
  ok(hasInlineServiceRoleJwt('k="' + mkJwt('service_role') + '"'), 'inline service_role JWT is detected (decoded role claim)');
  ok(!hasInlineServiceRoleJwt('k="' + mkJwt('anon') + '"') && hasInlineAnonJwt('k="' + mkJwt('anon') + '"'), 'inline anon JWT classifies as anon, not service_role');
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
    w('src/pages/thing.spec.ts', 'const k = "sb_secret_specmock";'); // co-located .spec test → excluded, not elevated
    w('src/pages/EnvLeak.tsx', 'const k = process.env.SUPABASE_SERVICE_ROLE_KEY;'); // pins the *_SERVICE_ROLE_KEY ELEVATED branch
    w('src/pages/InlineSR.tsx', 'const k = "' + mkJwt('service_role') + '";'); // inline service_role JWT → elevated
    w('src/pages/InlineAnon.tsx', 'const k = "' + mkJwt('anon') + '";'); // inline anon JWT → NOT elevated (but IS an anon consumer)
    w('docs/cloudflare-worker.js', 'const k = "sb_secret_workerleak";'); // browser-public (non-src) → MUST be caught
    // differently-NAMED Vault credential sender (finding 3): structural detection, no `service_role_key` literal:
    w('supabase/migrations/altcred.sql', "select net.http_post(url:='x', headers:=jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='worker_credential')));");
    w('supabase/migrations/inline.sql', "select net.http_post(url:='x', headers:=jsonb_build_object('apikey','" + mkJwt('service_role') + "'));"); // inline JWT under apikey, no vault
    // unified inline-JWT classifier: service_role in an edge fn → SOURCE; anon in browser/runtime → ANON:
    w('supabase/functions/inlinesr/index.ts', 'const k = "' + mkJwt('service_role') + '";'); // inline service_role → source consumer
    const { foundSource, foundSql, foundAnon, escapes, elevated } = classify(tmp);
    ok(foundSource.has('supabase/functions/x/index.ts'), 'fixture: literal consumer detected');
    ok(foundSource.has('supabase/functions/inlinesr/index.ts'), 'fixture: inline service_role JWT in an edge fn is a SOURCE consumer');
    ok(foundAnon.has('src/pages/InlineAnon.tsx'), 'fixture: inline anon JWT in browser source is an ANON consumer');
    ok(foundSource.has('scripts/migration/alias.py'), 'fixture: TARGET_ alias consumer detected');
    ok(foundSource.has('scripts/helperonly.ts'), 'fixture: helper-only consumer detected');
    ok(foundSource.has('scripts/gesonly.ts'), 'fixture: getEnvServiceRoleKey-only consumer detected');
    ok(foundSource.has('scripts/rstonly.ts'), 'fixture: resolveServiceRoleToken-only consumer detected');
    ok(foundSource.has('scripts/deploy'), 'fixture: extensionless consumer detected');
    ok(!foundSource.has('scripts/logo.png'), 'fixture: png with literal is skipped');
    ok(!foundSource.has('scripts/nothing.ts'), 'fixture: benign file not detected');
    ok(foundSql.has('supabase/migrations/m.sql'), 'fixture: SQL sender detected');
    ok(foundSql.has('supabase/migrations/inline.sql'), 'fixture: INLINE-JWT SQL sender detected (no vault/current_setting)');
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
    ok(!elevated.includes('src/pages/thing.spec.ts'), 'fixture: a co-located .spec test is excluded from elevation');
    ok(elevated.includes('src/pages/EnvLeak.tsx'), 'fixture: a *_SERVICE_ROLE_KEY name in the browser is an elevation (pins the branch)');
    ok(elevated.includes('src/pages/InlineSR.tsx'), 'fixture: an inline service_role JWT in the browser is an elevation');
    ok(!elevated.includes('src/pages/InlineAnon.tsx'), 'fixture: an inline anon JWT in the browser is NOT an elevation');
    ok(elevated.includes('docs/cloudflare-worker.js'), 'fixture: sb_secret_ in a browser-public (non-src) member IS an elevation');
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

  // cutover contract (STATE model): fails today, and the reasons distinguish state.
  ok(stateOf('scripts/check-legacy-service-role-consumers.mjs') === 'tooling' && EXEMPT.has('tooling'), 'STATE: the guard file is an exempt tooling entry');
  ok(stateOf('supabase/functions/health-check/index.ts') === 'legacy', 'STATE: an unlisted production consumer defaults to legacy');
  ok(requireMigrated('.').length > 0, '--require-migrated FAILS today: production consumers are still on the legacy keys');
  // Full end-to-end cutover behaviour on a fixture tree — the four Codex blockers, proven:
  const cut = mkdtempSync(join(tmpdir(), 'legacy-key-cut-'));
  try {
    const w2 = (r, body) => { const p = join(cut, r); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
    w2('supabase/functions/still/index.ts', 'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');                    // legacy
    w2('supabase/functions/done/index.ts', 'Deno.env.get("SUPABASE_SECRET_KEYS") // migrated, no signal');   // new-secret (dropped signal)
    w2('supabase/functions/helperdone/index.ts', 'import { requireServiceRole } from "../_shared/auth.ts"; // now checks sb_secret'); // new-secret, helper name remains
    w2('supabase/functions/liar/index.ts', 'const k = "' + mkJwt('service_role') + '";');                    // new-secret but inline legacy JWT
    w2('scripts/prodtool.mjs', 'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');                                 // scripts-ci, legacy (prod tooling)
    w2('supabase/migrations/legacy_cron.sql', "net.http_post(u, jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='service_role_key')))");
    w2('supabase/migrations/new_cron.sql', "net.http_post(u, jsonb_build_object('apikey',(select decrypted_secret from vault.decrypted_secrets where name='edge_secret')))"); // migrated (differently-named secret)
    w2('supabase/migrations/liar_cron.sql', "net.http_post(u, jsonb_build_object('apikey','" + mkJwt('service_role') + "'))"); // marked migrated but inline legacy JWT
    // migrated cron via a differently-NAMED Vault secret (no inline JWT) BUT still references app.settings.service_role_key
    // in EXECUTABLE SQL — isolates the /service_role_key|app.settings/ half of hardLegacyResidue's .sql branch.
    w2('supabase/migrations/residue_cron.sql', "select set_config('x', current_setting('app.settings.service_role_key'), true); net.http_post(u, jsonb_build_object('apikey',(select decrypted_secret from vault.decrypted_secrets where name='edge_secret')))");
    // an EXEMPT (retired) path that carries a HARD inline-JWT residue — proves EXEMPT membership is load-bearing.
    w2('supabase/functions/exempt_residue/index.ts', 'const k = "' + mkJwt('service_role') + '"; // retired one-off, but a real inline legacy JWT');
    const reg = {
      managed: { 'admin-client': ['supabase/functions/still/index.ts', 'supabase/functions/done/index.ts', 'supabase/functions/helperdone/index.ts', 'supabase/functions/liar/index.ts'], 'scripts-ci': ['scripts/prodtool.mjs'], 'exempt-check': ['supabase/functions/exempt_residue/index.ts'] },
      anon: {},
      sql: { 'supabase/migrations/legacy_cron.sql': { status: 'active' }, 'supabase/migrations/new_cron.sql': { status: 'active' }, 'supabase/migrations/liar_cron.sql': { status: 'active' }, 'supabase/migrations/residue_cron.sql': { status: 'active' } },
      state: { 'supabase/functions/done/index.ts': 'new-secret', 'supabase/functions/helperdone/index.ts': 'new-secret', 'supabase/functions/liar/index.ts': 'new-secret', 'supabase/migrations/new_cron.sql': 'new-secret', 'supabase/migrations/liar_cron.sql': 'new-secret', 'supabase/migrations/residue_cron.sql': 'new-secret', 'supabase/functions/exempt_residue/index.ts': 'retired' },
    };
    const paths = new Set(requireMigrated(cut, reg).map((x) => x.path));
    ok(!paths.has('supabase/functions/done/index.ts'), 'F1: a migrated consumer that DROPPED its signal (state=new-secret) passes — the gate is reachable');
    ok(inventoryProblems(cut, reg).length === 0, 'F1: the inventory precheck stays clean for a migrated (signal-dropped) path — state-aware stale');
    ok(!paths.has('supabase/functions/helperdone/index.ts'), 'F2: a requireServiceRole importer migrated to sb_secret passes WITHOUT renaming (helper = dependency, not credential)');
    ok(!paths.has('supabase/migrations/new_cron.sql'), 'F2/F3: a migrated cron using a differently-NAMED Vault secret passes');
    ok(paths.has('scripts/prodtool.mjs'), 'F3: a scripts-ci PRODUCTION tool (state=legacy) is NOT blanket-excluded');
    ok(paths.has('supabase/functions/liar/index.ts') && paths.has('supabase/migrations/liar_cron.sql'), 'F3: state=new-secret but an inline legacy JWT residue in source/SQL is REJECTED');
    ok(paths.has('supabase/functions/still/index.ts') && paths.has('supabase/migrations/legacy_cron.sql'), 'cutover: legacy source + legacy SQL cron are flagged');
    ok(!requireMigrated(cut, { ...reg, state: { ...reg.state, 'scripts/prodtool.mjs': 'retired' } }).some((x) => x.path === 'scripts/prodtool.mjs'), 'F3: an explicitly-exempted tool (retired) passes');
    // MUTATION-PIN 1 — hardLegacyResidue's .sql /service_role_key|app.settings/ branch, independent of the inline-JWT branch:
    // an ACTIVE, state=new-secret cron that sends via a differently-named Vault secret but still references app.settings is REJECTED.
    ok(paths.has('supabase/migrations/residue_cron.sql'), 'MUTATION-PIN: state=new-secret SQL cron with an executable app.settings.service_role_key ref (NO inline JWT) is REJECTED');
    // MUTATION-PIN 2 — EXEMPT membership is load-bearing: a retired path with a HARD inline-JWT residue is suppressed
    // ONLY by EXEMPT; the SAME file de-exempted to new-secret IS flagged (so dropping 'retired' from EXEMPT would break this).
    ok(!paths.has('supabase/functions/exempt_residue/index.ts'), 'MUTATION-PIN: a retired path with a HARD inline-JWT residue is suppressed by EXEMPT membership');
    ok(requireMigrated(cut, { ...reg, state: { ...reg.state, 'supabase/functions/exempt_residue/index.ts': 'new-secret' } }).some((x) => x.path === 'supabase/functions/exempt_residue/index.ts'), 'MUTATION-PIN: the SAME residue-bearing file de-exempted (new-secret) IS flagged — proves EXEMPT is what suppressed it');
    // MUTATION-PIN 3 — an unknown MANAGED_SQL status (typo) is an inventory problem, not a silent skip.
    ok(inventoryProblems(cut, { managed: {}, anon: {}, sql: { 'supabase/migrations/new_cron.sql': { status: 'Active' } }, state: {} }).some((m) => /INVALID sql status/.test(m)), 'MUTATION-PIN: an off-whitelist SQL status (e.g. Active) is surfaced as an inventory problem');
  } finally { rmSync(cut, { recursive: true, force: true }); }
  // the PASS path (own tree, ONLY migrated files): cutover clean end-to-end — proves the gate is reachable.
  const cln = mkdtempSync(join(tmpdir(), 'legacy-key-cln-'));
  try {
    const w2 = (r, body) => { const p = join(cln, r); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
    w2('supabase/functions/done/index.ts', 'Deno.env.get("SUPABASE_SECRET_KEYS") // migrated');
    w2('supabase/functions/helperdone/index.ts', 'import { requireServiceRole } from "../_shared/auth.ts";');
    w2('supabase/migrations/new_cron.sql', "net.http_post(u, jsonb_build_object('apikey',(select decrypted_secret from vault.decrypted_secrets where name='edge_secret')))");
    const clean = { managed: { 'admin-client': ['supabase/functions/done/index.ts', 'supabase/functions/helperdone/index.ts'] }, anon: {}, sql: { 'supabase/migrations/new_cron.sql': { status: 'active' } }, state: { 'supabase/functions/done/index.ts': 'new-secret', 'supabase/functions/helperdone/index.ts': 'new-secret', 'supabase/migrations/new_cron.sql': 'new-secret' } };
    ok(inventoryProblems(cln, clean).length === 0 && requireMigrated(cln, clean).length === 0, 'F1: full cutover PASSES (inventory clean + 0 pending) when every consumer is migrated');
  } finally { rmSync(cln, { recursive: true, force: true }); }

  // the real, checked-in baseline must pass every INVENTORY check (require-migrated is intentionally NOT clean yet).
  // Use the SAME state-aware inventory the guard uses, so it stays green through migration.
  ok(inventoryProblems('.').length === 0, `real inventory clean (state-aware): ${inventoryProblems('.').slice(0, 3).join(' | ')}`);
  const real = classify('.');
  const rs = diff(real.foundSource, new Set(Object.values(MANAGED).flat())); rs.stale = rs.stale.filter((p) => stateOf(p) === 'legacy');
  const rq = diff(real.foundSql, new Set(Object.keys(MANAGED_SQL)));
  const ra = diff(real.foundAnon, new Set(Object.values(MANAGED_ANON).flat())); ra.stale = ra.stale.filter((p) => stateOf(p) === 'legacy');
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

// Cutover gate — the ONLY check that proves migration completion (the normal guard proves only inventory
// completeness). Run this before the final legacy-pair disable; it FAILS until every runtime consumer is migrated.
if (process.argv.includes('--require-migrated')) {
  // The cutover gate walks only the registries, so it is meaningful ONLY if the inventory is complete. Refuse to
  // report "safe to disable" while the normal 6-check guard would fail (unregistered consumer / escape / browser
  // elevation / lifecycle drift) — otherwise a NEW unregistered runtime consumer would be invisible here.
  const inv = inventoryProblemCount('.');
  if (inv > 0) {
    console.error(`NOT READY — ${inv} inventory problem(s): the registry is not complete/clean, so migration cannot be proven.`);
    console.error('Run `npm run check:legacy-key` (+ `:selftest`) and fix all drift/escape/elevation/lifecycle first, then re-run this gate.');
    process.exit(1);
  }
  const pending = requireMigrated('.');
  if (pending.length) {
    const by = (k) => pending.filter((x) => x.kind === k).length;
    console.error(`NOT READY to disable the legacy keys — ${pending.length} production-runtime consumers still on a legacy key ` +
      `(service-role=${by('service-role')}, anon=${by('anon')}, sql=${by('sql')}):\n`);
    for (const x of pending) console.error(`  • [${x.kind}] ${x.path} — ${x.reason}`);
    console.error('\nMigrate each (service_role → sb_secret_, anon → sb_publishable_), set its STATE to new-secret/publishable, then re-run.');
    console.error('Also verify DEPLOYED env VALUES by prefix (Vercel/Supabase/Cloudflare) — the env NAME does not prove the value.');
    process.exit(1);
  }
  console.log('OK — every production consumer is migrated off the legacy service-role/anon keys; safe to disable the legacy pair.');
  process.exit(0);
}

const { foundSource, foundSql, foundAnon, escapes, elevated } = classify('.');
const src = diff(foundSource, new Set(Object.values(MANAGED).flat()));
const sql = diff(foundSql, new Set(Object.keys(MANAGED_SQL)));
const anon = diff(foundAnon, new Set(Object.values(MANAGED_ANON).flat()));
// STATE-AWARE stale for source/anon: a registered path that dropped its signal is a problem ONLY if state=legacy
// (migrated but not relabeled). A migrated/exempt path is EXPECTED to have no signal — so migration keeps CI green.
src.stale = src.stale.filter((p) => stateOf(p) === 'legacy');
anon.stale = anon.stale.filter((p) => stateOf(p) === 'legacy');
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
  `${Object.keys(MANAGED_SQL).length} SQL/Vault migrations (${sqlActive} active, lifecycle static-checked [best-effort]); ` +
  `${anonCount} anon/publishable consumers; no elevated key in the browser bundle; no references outside guarded roots. ` +
  `(Inventory-complete, NOT migration-complete — run --require-migrated before disabling the legacy keys.)`);
