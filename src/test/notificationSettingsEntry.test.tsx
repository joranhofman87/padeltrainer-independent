import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * N2 / S4 — the ROLE-AGNOSTIC notification settings entry, and the redirects that reach it.
 *
 * The route exists because an email footer cannot know which surface its recipient belongs to.
 * What it must not get wrong:
 *  1. it RENDERS the settings page — forwarding to a role route hands the recipient to layout
 *     guards (expired subscription, incomplete onboarding) that redirect them away,
 *  2. a logged-out arrival keeps its destination instead of being dumped on a dashboard,
 *  3. a still-resolving auth state decides nothing,
 *  4. ANY aggregate profile-fetch failure offers a retry — partial results are a wrong answer
 *     that looks like a complete one,
 *  5. `?redirect=` is attacker-controlled and must be sanitised on every path that stores or
 *     navigates it, including the signup → onboarding chain.
 */

type AuthState = {
  user: { id: string } | null;
  roles: string[];
  isAcademyManager: boolean;
  loading: boolean;
  profileReady: boolean;
  profileFetchFailed: boolean;
};

const refreshAuth = vi.fn();
let authState: AuthState;

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ ...authState, refreshAuth }) }));
// The settings page itself is covered by notificationSettingsV2.test.tsx; here it stands in for
// "the real content rendered in place", so the entry's own decisions are what is under test.
vi.mock('@/pages/NotificationSettings', () => ({
  default: () => <div data-testid="settings-content">settings</div>,
}));

import NotificationSettingsEntry from '@/pages/NotificationSettingsEntry';
import { NOTIFICATION_SETTINGS_ENTRY_PATH } from '@/lib/notificationSettingsRoute';

const ROOT = resolve(__dirname, '..');
const readSrc = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Renders the path + query so assertions read the URL the app actually reached. */
function Marker({ name }: { name: string }) {
  const location = useLocation();
  return (
    <div>
      <span data-testid="where">{name}</span>
      <span data-testid="search">{location.search}</span>
    </div>
  );
}

function renderEntry() {
  return render(
    <MemoryRouter initialEntries={[NOTIFICATION_SETTINGS_ENTRY_PATH]}>
      <Routes>
        <Route path={NOTIFICATION_SETTINGS_ENTRY_PATH} element={<NotificationSettingsEntry />} />
        <Route path="/app/auth" element={<Marker name="auth" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const RESOLVED = { loading: false, profileReady: true, profileFetchFailed: false };

beforeEach(() => {
  vi.clearAllMocks();
  authState = { user: { id: 'U1' }, roles: ['player'], isAcademyManager: false, ...RESOLVED };
});

describe('NotificationSettingsEntry', () => {
  const accounts: Array<[string, Partial<AuthState>]> = [
    ['player', { roles: ['player'] }],
    ['trainer', { roles: ['trainer', 'player'] }],
    ['academy manager with no roles row', { roles: [], isAcademyManager: true }],
    ['academy manager who is also a trainer', { roles: ['trainer'], isAcademyManager: true }],
    ['admin', { roles: ['admin'] }],
    ['club only', { roles: ['club'] }],
  ];

  it.each(accounts)('renders the settings page in place for %s', async (_label, patch) => {
    authState = { ...authState, ...patch };
    renderEntry();
    expect(await screen.findByTestId('settings-content')).toBeInTheDocument();
    // Never a forward: a role route would re-apply that layout's guards, and an expired academy
    // or an incomplete trainer onboarding is redirected off the settings path by them.
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('carries the destination when logged out', async () => {
    authState = { ...authState, user: null, roles: [] };
    renderEntry();
    expect(await screen.findByTestId('where')).toHaveTextContent('auth');
    expect(screen.getByTestId('search')).toHaveTextContent(
      `redirect=${encodeURIComponent(NOTIFICATION_SETTINGS_ENTRY_PATH)}`,
    );
  });

  it('decides nothing while auth is still loading', async () => {
    authState = { ...authState, user: null, roles: [], loading: true, profileReady: false };
    renderEntry();
    await Promise.resolve();
    // Not yet known to be logged out — bouncing here throws away the deep link of a recipient
    // who IS signed in.
    expect(screen.queryByTestId('where')).toBeNull();
    expect(screen.queryByTestId('settings-content')).toBeNull();
  });

  it('waits for the profile before rendering', async () => {
    authState = { ...authState, roles: [], profileReady: false };
    renderEntry();
    await Promise.resolve();
    expect(screen.queryByTestId('settings-content')).toBeNull();
  });

  it.each([
    ['empty roles', [] as string[], false],
    ['roles present but the academy lookup failed', ['trainer'], false],
    ["another account's roles left over from a switch", ['player'], true],
  ])('offers a retry when the profile fetch FAILED — %s', async (_label, roles, isMgr) => {
    // `useAuth` publishes PARTIAL results on its last attempt and does not clear roles on an
    // account switch, so a failure with NON-EMPTY roles is real and is the dangerous case: the
    // page would render a confidently wrong event list.
    authState = { ...authState, roles, isAcademyManager: isMgr, profileFetchFailed: true };
    renderEntry();
    const retry = await screen.findByRole('button');
    expect(screen.queryByTestId('settings-content')).toBeNull();
    expect(screen.queryByTestId('where')).toBeNull();
    retry.click();
    await waitFor(() => expect(refreshAuth).toHaveBeenCalled());
  });
});

/**
 * Depth-aware scan of the router source. A substring check cannot tell "mounted at top level"
 * from "mounted inside PlayerLayout", and that difference is the entire point of the route, so a
 * refactor that nests it must fail here.
 */
function stripComments(src: string): string {
  // Block and line comments are removed before scanning: DomainRouter already carries a
  // commented-out `<Route .../>`, and a commented-out BLOCK route would otherwise unbalance the
  // depth count and silently break every assertion below.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Index of the `>` that ends a JSX opening tag. Scanning for the first `>` is wrong: every route
 * here carries `element={<Layout />}`, whose own `/>` would be read as the end of the tag — which
 * makes a layout route look self-closing and hides everything nested inside it.
 */
function jsxTagEnd(src: string, open: number): number {
  let braces = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') braces += 1;
    else if (c === '}') braces -= 1;
    else if (c === '>' && braces === 0) return i;
  }
  return -1;
}

function routeBlockRange(src: string, openerNeedle: string): [number, number] {
  const found = src.indexOf(openerNeedle);
  if (found < 0) throw new Error(`opener not found: ${openerNeedle}`);
  // The needle may match mid-tag (e.g. `element={<PlayerLayout />}>`); anchor on the enclosing
  // `<Route`, or the scan below never counts the opening tag and every block reads as unbalanced.
  const start = src.lastIndexOf('<Route', found);
  if (start < 0) throw new Error(`no enclosing <Route for: ${openerNeedle}`);
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const open = src.indexOf('<Route', i);
    const close = src.indexOf('</Route>', i);
    if (open >= 0 && (close < 0 || open < close)) {
      const tagEnd = jsxTagEnd(src, open);
      if (tagEnd < 0) throw new Error('unterminated <Route');
      // A self-closing <Route ... /> opens and closes in one tag.
      if (src[tagEnd - 1] !== '/') depth += 1;
      i = tagEnd + 1;
    } else if (close >= 0) {
      depth -= 1;
      i = close + '</Route>'.length;
      if (depth === 0) return [start, i];
    } else {
      break;
    }
  }
  throw new Error(`unbalanced route block for: ${openerNeedle}`);
}

describe('route-source extractor (self-test — it must not pass by being blind)', () => {
  const fixture = [
    '<Route path="/a" element={<L />}>',
    '  <Route index element={<X />} />',
    '  {/* <Route path="ghost" element={<G />}> */}',
    '  <Route path="deep" element={<M />}>',
    '    <Route path="deeper" element={<Y />} />',
    '  </Route>',
    '</Route>',
    '<Route path="/outside" element={<Z />} />',
  ].join('\n');

  it('spans nested blocks and stops at the matching close', () => {
    const [start, end] = routeBlockRange(stripComments(fixture), '<Route path="/a"');
    const block = stripComments(fixture).slice(start, end);
    expect(block).toContain('path="deeper"');
    expect(block).not.toContain('path="/outside"');
  });

  it('does not read the `/>` inside element={<L />} as the end of the opening tag', () => {
    // The failure this pins: treating a layout route as self-closing makes its whole subtree
    // invisible, so "the entry is not nested under a layout" would pass without checking.
    const opener = '<Route path="/a" element={<L />}>';
    expect(jsxTagEnd(fixture, fixture.indexOf(opener))).toBe(
      fixture.indexOf(opener) + opener.length - 1,
    );
  });

  it('ignores a commented-out block route that would otherwise unbalance the count', () => {
    // Without stripComments the ghost `<Route ...>` adds a depth that never closes, and the scan
    // runs off the end of the fixture.
    expect(() => routeBlockRange(fixture, '<Route path="/a"')).toThrow(/unbalanced/);
    expect(() => routeBlockRange(stripComments(fixture), '<Route path="/a"')).not.toThrow();
  });

  it('anchors a mid-tag needle on the enclosing <Route', () => {
    // How the layout blocks are addressed below: by their `element={<XLayout />}>` marker, which
    // sits partway through the opening tag.
    const [start, end] = routeBlockRange(stripComments(fixture), 'element={<L />}>');
    const block = stripComments(fixture).slice(start, end);
    expect(block.startsWith('<Route path="/a"')).toBe(true);
    expect(block).toContain('path="deeper"');
  });

  it('throws rather than silently returning nothing when the opener is absent', () => {
    expect(() => routeBlockRange(stripComments(fixture), '<Route path="/nope"')).toThrow(
      /opener not found/,
    );
  });
});

describe('router placement', () => {
  const router = stripComments(readSrc('components/DomainRouter.tsx'));

  it('registers the neutral path', () => {
    expect(router).toContain(`path="${NOTIFICATION_SETTINGS_ENTRY_PATH}"`);
    expect(router).toContain('NotificationSettingsEntry');
  });

  // EVERY layout, not just the two the resolver used to target: nesting the route under any of
  // them re-applies that layout's guards, which is the failure this route exists to remove.
  const layouts = ['Player', 'Trainer', 'Admin', 'Club', 'Academy'];

  it('covers every layout the router actually declares', () => {
    // A new layout must force this list to be updated rather than quietly going unchecked.
    const declared = [...router.matchAll(/element=\{<([A-Za-z]+)Layout \/>\}>/g)].map((m) => m[1]);
    expect(new Set(declared)).toEqual(new Set(layouts));
  });

  it.each(layouts)('mounts the entry OUTSIDE %sLayout', (layout) => {
    const [start, end] = routeBlockRange(router, `element={<${layout}Layout />}>`);
    expect(router.slice(start, end)).not.toContain(NOTIFICATION_SETTINGS_ENTRY_PATH);
  });
});

describe('redirect sanitisation across the whole chain', () => {
  // Source-level: these pages pull in the entire login/signup stack, and the invariant worth
  // pinning is structural — that NO path from `?redirect=` to navigate() skips the sanitiser.
  // sanitizeAppRedirect's own behaviour is covered in src/lib/signupClaimFlow.test.ts.
  const files = {
    auth: readSrc('pages/Auth.tsx'),
    trainerSignup: readSrc('pages/TrainerSignup.tsx'),
    trainerOnboarding: readSrc('pages/onboarding/TrainerOnboardingFlow.tsx'),
  };

  it('Auth sanitises the query param on the way in', () => {
    expect(files.auth).toContain(
      "const redirect = sanitizeAppRedirect(searchParams.get('redirect'));",
    );
    expect(files.auth).not.toMatch(/setItem\('redirectAfterLogin',\s*searchParams\.get/);
  });

  it('Auth sanitises on the way out, and purges a value that fails', () => {
    expect(files.auth).toContain('const redirectUrl = sanitizeAppRedirect(storedRedirect);');
    expect(files.auth).toMatch(
      /if \(storedRedirect && !redirectUrl\) sessionStorage\.removeItem\('redirectAfterLogin'\);/,
    );
    expect(files.auth).not.toMatch(/navigate\(storedRedirect\)/);
  });

  it('Auth hands the signup link a checked value', () => {
    // /app/signup forwards the query to trainer signup, which stores it for after onboarding.
    expect(files.auth).toContain(
      "const signupRedirect = sanitizeAppRedirect(searchParams.get('redirect'));",
    );
    expect(files.auth).not.toMatch(/\/app\/signup\$\{searchParams\.get\('redirect'\)/);
  });

  it.each(Object.entries(files))(
    '%s uses the shared key constant, never the raw string that skipped the sanitiser',
    (_name, src) => {
      // Every site that used the CONSTANT already sanitised; the only two that did not were the
      // two that hardcoded the literal. Keeping the literal out keeps them from drifting apart.
      expect(src).not.toContain("'redirectAfterOnboarding'");
    },
  );

  it('trainer signup stores only sanitised values', () => {
    const writes = [
      ...files.trainerSignup.matchAll(
        /localStorage\.setItem\(SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY,\s*(\w+)\)/g,
      ),
    ];
    expect(writes).toHaveLength(3);
    for (const w of writes) {
      expect(files.trainerSignup).toContain(
        `const ${w[1]} = sanitizeAppRedirect(searchParams.get('redirect'));`,
      );
    }
  });

  it('trainer onboarding sanitises what it navigates to, and clears the slot either way', () => {
    expect(files.trainerOnboarding).toContain('const redirectUrl = sanitizeAppRedirect(stored);');
    expect(files.trainerOnboarding).toContain(
      'if (stored) localStorage.removeItem(SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY);',
    );
    expect(files.trainerOnboarding).not.toMatch(/navigate\(stored\)/);
  });
});

describe('settings page staff detection', () => {
  it('reads the whole roles set, not the primary role', () => {
    // `useAuth` ranks admin above trainer, so an account holding both resolves to role==='admin'
    // and a primary-role test hides every staff event from a real trainer.
    const page = readSrc('pages/NotificationSettings.tsx');
    expect(page).toContain("const isStaff = Boolean(isAcademyManager) || roles.includes('trainer')");
    expect(page).not.toMatch(/isStaff\s*=\s*Boolean\(isAcademyManager\)\s*\|\|\s*role === 'trainer'/);
  });
});
