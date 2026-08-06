import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NOTIFICATION_SETTINGS_ENTRY_PATH } from '@/lib/notificationSettingsRoute';

/**
 * N2 S2b — cross-boundary parity: every email footer must cite the SAME neutral settings route
 * the app mounts.
 *
 * The route constant lives in the frontend (`src/lib/notificationSettingsRoute.ts`); the footers
 * live in Deno edge functions that cannot import it. Nothing but these assertions ties the two
 * worlds together — if either side drifts (a route rename, a footer typo), recipients land on a
 * 404 in the mail that exists precisely to let them opt out.
 *
 * ALSO the inverse: no footer may emit a ROLE-GUESSED settings path. The guess is the bug S4/S2b
 * exist to remove — a role layout bounces anyone it does not admit, discarding the deep link.
 */

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const FOOTER_SOURCES = [
  'supabase/functions/send-email/index.ts',
  'supabase/functions/send-digest-emails/index.ts',
  'supabase/functions/_shared/digest-render.ts',
] as const;

describe('email footer ↔ app route parity', () => {
  it('the app constant is the value the footers are pinned to', () => {
    expect(NOTIFICATION_SETTINGS_ENTRY_PATH).toBe('/app/settings/notifications');
  });

  it.each(FOOTER_SOURCES)('%s cites the neutral route', (file) => {
    expect(read(file)).toContain(NOTIFICATION_SETTINGS_ENTRY_PATH);
  });

  it.each(FOOTER_SOURCES)('%s emits NO role-guessed settings path', (file) => {
    const src = read(file);
    for (const role of ['player', 'trainer', 'academy', 'club', 'admin']) {
      expect(src, `${file} still links /app/${role}/settings/notifications`).not.toContain(
        `/app/${role}/settings/notifications`,
      );
    }
  });

  it('the route the footers cite is actually mounted', () => {
    // Parity with a route nobody mounts is a shared 404.
    expect(read('src/components/DomainRouter.tsx')).toContain(
      `path="${NOTIFICATION_SETTINGS_ENTRY_PATH}"`,
    );
  });
});

describe('send-email per-recipient footer (N2 constraint 1)', () => {
  const src = read('supabase/functions/send-email/index.ts');

  it('renders the manage link ONLY for an account — a guest gets the from-line alone', () => {
    // A guest cannot log in, so a settings link in their footer dead-ends on a login form.
    expect(src).toContain('const manageLine = recipientUserId');
    expect(src).toMatch(/\$\{footerCopy\.from\}\$\{manageLine\}/);
  });

  it('a FAILED lookup refuses retryably — it is not a guest, and not a licence to send blind', () => {
    // Treating a lookup error as "no account" both drops the manage link an account holder is
    // owed and skips the preference check — mail would send against a stored 'off'.
    expect(src).toContain('if (profileErr) {');
    const branch = src.slice(src.indexOf('if (profileErr) {'), src.indexOf('recipientUserId = profile?.user_id ?? null;'));
    expect(branch).toContain('status: 503');
    expect(branch).toContain('retryable: true');
  });

  it('a FAILED preference read also refuses — defaulting to instant sends against a stored off', () => {
    // Found by the whole-unit sweep: the pref read discarded its error, prefs became null, and
    // the frequency defaulted to "instant" — mail whenever the read failed, opt-out or not.
    expect(src).toContain('if (prefsErr) {');
    const branch = src.slice(src.indexOf('if (prefsErr) {'), src.indexOf('const frequency ='));
    expect(branch).toContain('preference_read_failed');
    expect(branch).toContain('status: 503');
  });

  it('resolves the account BEFORE the preference branch, so no-pref-column types still know it', () => {
    const lookupIdx = src.indexOf('if (!recipientUserId && !isSystemEmail) {');
    const prefBranchIdx = src.indexOf('if (prefColumn && !isSystemEmail) {');
    expect(lookupIdx).toBeGreaterThan(0);
    expect(prefBranchIdx).toBeGreaterThan(0);
    expect(lookupIdx).toBeLessThan(prefBranchIdx);
  });
});

describe('send-digest-emails send-time gate wiring', () => {
  // The DECISION table lives in _shared/digest-send-gate.ts under Deno tests; these pin that the
  // handler actually consults it — the gate being right is worthless if nothing calls it.
  const src = read('supabase/functions/send-digest-emails/index.ts');

  it('reads preferences and suppression BEFORE claiming, and aborts the run on a failed read', () => {
    const claimIdx = src.indexOf('.update({ processed_at: new Date().toISOString() })');
    const prefsIdx = src.indexOf('from("notification_preferences")');
    const suppIdx = src.indexOf('from("email_address_state")');
    expect(claimIdx).toBeGreaterThan(0);
    expect(prefsIdx).toBeGreaterThan(0);
    expect(suppIdx).toBeGreaterThan(0);
    // Order matters: a failed read after claiming would strand consumed items.
    expect(prefsIdx).toBeLessThan(claimIdx);
    expect(suppIdx).toBeLessThan(claimIdx);
    expect(src).toContain('throw prefsErr');
    expect(src).toContain('throw suppErr');
  });

  it('gates the claimed items and renders only the survivors', () => {
    expect(src).toContain('gateDigestItems(items, prefsMap[userId] ?? null)');
    expect(src).toContain('buildDigestHtml(gate.send, profile.name, role)');
    // The pre-gate shape — rendering everything claimed — must not come back.
    expect(src).not.toContain('buildDigestHtml(items,');
  });

  it('drops a suppressed address by CONSUMING the claim, and matches the canonical normalization', () => {
    expect(src).toContain('suppressedSet.has(normalizeEmailForSuppression(profile.email))');
    expect(src).toContain('.eq("is_suppressed", true)');
    // Chunked + deduplicated: 1000 raw addresses in one `.in()` URL can exceed URI limits, and
    // the resulting pre-claim abort would starve the same leading batch on every run.
    expect(src).toContain('const SUPPRESSION_CHUNK = 100;');
    expect(src).toMatch(/new Set\(\s*\n?\s*Object\.values\(profileMap\)/);
    expect(src).toContain('normalizedEmails.slice(i, i + SUPPRESSION_CHUNK)');
    // The suppressed branch must not release: a suppressed address retried forever is the bug.
    const branch = src.slice(
      src.indexOf('suppressedSet.has(normalizeEmailForSuppression(profile.email))'),
      src.indexOf('const gate = gateDigestItems'),
    );
    expect(branch).not.toContain('processed_at: null');
  });

  it('a send failure releases ONLY the items it tried to send — never the opted-out ones', () => {
    expect(src).toContain('.in("id", gate.send.map((i) => i.id))');
    expect(src).not.toContain('.in("id", items.map((i) => i.id))');
  });
});

describe('S3: campaign sender marketing layer wiring', () => {
  // The decision table lives in _shared/marketing-email.ts under Deno tests; these pin that the
  // sender consults it with the right inputs and honours every refusal.
  const src = read('supabase/functions/send-campaign-emails/index.ts');

  it('checks the CANONICAL suppression reader per recipient, before dispatch', () => {
    expect(src).toContain('await isSuppressed(recipient.recipient_email)');
    expect(src).toContain('"is_marketing_suppressed"');
    // The check must precede the provider call inside sendOne.
    const sendOneIdx = src.indexOf('const sendOne = async');
    const suppIdx = src.indexOf('await isSuppressed(recipient.recipient_email)', sendOneIdx);
    const fetchIdx = src.indexOf('await fetch("https://api.resend.com/emails"', sendOneIdx);
    expect(suppIdx).toBeGreaterThan(sendOneIdx);
    expect(suppIdx).toBeLessThan(fetchIdx);
  });

  it("suppressed → status 'suppressed', which retryFailed can never resurrect", () => {
    expect(src).toContain('.update({ status: "suppressed"');
    // retryFailed re-queues ONLY 'failed' — the terminality of 'suppressed' hangs on this.
    expect(src).toMatch(/\.eq\("status", "failed"\)\s*\n?\s*\.lt\("attempt_count"/);
  });

  it('a suppression-check ERROR marks the row failed — an error is never clearance', () => {
    const branch = src.slice(
      src.indexOf('} catch (suppErr) {'),
      src.indexOf('// ── MANAGE CAPABILITY'),
    );
    expect(branch).toContain('status: "failed"');
  });

  it('the cutover discriminator is attempt_count, and a refused attachment BLOCKS the send', () => {
    expect(src).toContain('attempted: (recipient.attempt_count ?? 0) > 0');
    expect(src).toContain('unsubscribe unavailable:');
    // The terminal branch must return before the provider call — measured inside sendOne,
    // because the file's FIRST Resend fetch is the earlier testMode block.
    const sendOneIdx = src.indexOf('const sendOne = async');
    const termIdx = src.indexOf('unsubscribe unavailable:', sendOneIdx);
    const fetchIdx = src.indexOf('await fetch("https://api.resend.com/emails"', sendOneIdx);
    expect(termIdx).toBeGreaterThan(sendOneIdx);
    expect(termIdx).toBeLessThan(fetchIdx);
  });

  it('footer and RFC 8058 headers ride ONLY on an attach decision', () => {
    expect(src).toContain('attachment.kind === "attach" ? marketingFooterHtml(attachment.token) : ""');
    expect(src).toMatch(/attachment\.kind === "attach"\s*\n?\s*\? \{ headers: rfc8058Headers\(SUPABASE_URL!, attachment\.token\) \}/);
  });

  it('scope is the campaign OWNER (academy → trainer → platform), never a constant', () => {
    expect(src).toContain('? { kind: "academy", id: campaign.academy_profile_id }');
    expect(src).toContain('? { kind: "trainer", id: campaign.trainer_profile_id }');
    expect(src).toContain(': { kind: "platform", id: null }');
  });
});

describe('S3: onboarding drip marketing layer wiring', () => {
  const src = read('supabase/functions/process-onboarding-emails/index.ts');

  it('an UNCLASSIFIED template is treated as marketing — the safe error direction', () => {
    // The wrong default here is the whole bug class: marketing without an unsubscribe.
    expect(src).toContain('queueItem.template.delivery_class !== "required_service"');
    expect(src).toContain('delivery_class'); // selected in the join
    expect(src).toMatch(/onboarding_email_templates\(id, subject, body_html, delivery_class\)/);
  });

  it("suppressed → 'suppressed', and a FAILED status write is loud, counted, and skips the send", () => {
    expect(src).toContain('.update({ status: "suppressed", error_message: null, sent_at: null })');
    expect(src).toContain("stays recorded 'sent'");
  });

  it('a refused attachment blocks the send and records why', () => {
    expect(src).toContain('unsubscribe unavailable:');
    const termIdx = src.indexOf('unsubscribe unavailable:');
    const sendIdx = src.indexOf('await sendResendEmail(resendApiKey', termIdx);
    expect(sendIdx).toBeGreaterThan(termIdx);
  });

  it('headers and footer ride into the actual send call', () => {
    expect(src).toContain('html: finalHtml');
    expect(src).toContain('...(extraHeaders ? { headers: extraHeaders } : {})');
  });
});

describe('S5: the frozen URL shapes are now MOUNTED', () => {
  // S3 froze both addresses into outbound mail; S5 must serve them. A drift on either side is a
  // 404 inside the one email whose purpose is letting people leave.
  it('/manage-email is a real route, outside every layout', () => {
    const router = read('src/components/DomainRouter.tsx');
    expect(router).toContain('path="/manage-email"');
    expect(router).toContain('ManageEmail');
  });

  it('the one-click function exists under exactly the frozen name', () => {
    const marketing = read('supabase/functions/_shared/marketing-email.ts');
    expect(marketing).toContain('export const ONE_CLICK_FUNCTION_NAME = "notif-unsubscribe-one-click"');
    expect(() => read('supabase/functions/notif-unsubscribe-one-click/index.ts')).not.toThrow();
  });

  it('both endpoints are declared verify_jwt=false — a provider or a guest cannot carry a JWT', () => {
    const config = read('supabase/config.toml');
    expect(config).toMatch(/\[functions\.notif-unsubscribe-one-click\]\s*\nverify_jwt = false/);
    expect(config).toMatch(/\[functions\.notif-manage\]\s*\nverify_jwt = false/);
  });

  it('the page constant and the mounted route agree', () => {
    const marketing = read('supabase/functions/_shared/marketing-email.ts');
    expect(marketing).toContain('export const MANAGE_EMAIL_PAGE_URL = "https://padeltrainer.ai/manage-email"');
  });

  it('the one-click wrapper never applies on GET — scanners prefetch List-Unsubscribe URLs', () => {
    const fn = read('supabase/functions/notif-unsubscribe-one-click/index.ts');
    const getIdx = fn.indexOf('req.method === "GET"');
    // the CALL site, not the import at the top of the file
    const applyIdx = fn.indexOf('await handleOneClickPost(');
    expect(getIdx).toBeGreaterThan(0);
    // The GET branch returns a redirect before the POST handler is ever reached.
    // The GET branch runs from the method test to its early return; the apply handler may only
    // appear after it. (The first oneClickGetRedirect occurrence in the FILE is the import, so
    // the branch is sliced from the method test forward.)
    const getBranch = fn.slice(getIdx, fn.indexOf('if (req.method !== "POST")'));
    expect(getBranch).toContain('oneClickGetRedirect');
    expect(getBranch).not.toContain('handleOneClickPost');
    expect(applyIdx).toBeGreaterThan(getIdx);
  });
});
