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
