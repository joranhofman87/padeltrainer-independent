import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';

/**
 * N2 / S4 — the ROLE-AGNOSTIC notification settings entry, and the redirect that carries a
 * logged-out recipient back to it.
 *
 * This route exists because an email footer cannot know which surface its recipient belongs to.
 * The five things it must not get wrong:
 *  1. every account type reaches its OWN settings surface (the academy-manager case is the one
 *     that was broken: the trainer path bounces them to the player dashboard),
 *  2. a logged-out arrival keeps its destination instead of being dumped on a dashboard,
 *  3. a still-resolving auth state forwards NOWHERE — a premature decision strands people,
 *  4. a FAILED role fetch says "retry", never "your account has no notification settings",
 *  5. `?redirect=` is attacker-controlled and must be sanitised on the way in AND out.
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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, def?: string) => def ?? key }),
}));

import NotificationSettingsEntry from '@/pages/NotificationSettingsEntry';
import {
  notificationSettingsPathFor,
  NOTIFICATION_SETTINGS_ENTRY_PATH,
} from '@/lib/notificationSettingsRoute';

const ROOT = resolve(__dirname, '..');
const readSrc = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Renders the destination path + query so assertions read the URL the app actually reached. */
function Marker({ name }: { name: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="where">{name}</span>
      <span data-testid="search">{location.search}</span>
      <button data-testid="back" onClick={() => navigate(-1)}>
        back
      </button>
    </div>
  );
}

function renderEntry(initialEntries: string[] = [NOTIFICATION_SETTINGS_ENTRY_PATH]) {
  return render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
      <Routes>
        <Route path={NOTIFICATION_SETTINGS_ENTRY_PATH} element={<NotificationSettingsEntry />} />
        <Route path="/app/auth" element={<Marker name="auth" />} />
        <Route path="/app/player" element={<Marker name="player-home" />} />
        <Route path="/app/player/settings/notifications" element={<Marker name="player" />} />
        <Route path="/app/trainer/settings/notifications" element={<Marker name="trainer" />} />
        <Route path="/app/academy/settings/notifications" element={<Marker name="academy" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const RESOLVED = { loading: false, profileReady: true, profileFetchFailed: false };

beforeEach(() => {
  vi.clearAllMocks();
  authState = {
    user: { id: 'U1' },
    roles: ['player'],
    isAcademyManager: false,
    ...RESOLVED,
  };
});

describe('notificationSettingsPathFor', () => {
  const cases: Array<[string, Parameters<typeof notificationSettingsPathFor>[0], string | null]> = [
    ['player', { isAcademyManager: false, roles: ['player'] }, '/app/player/settings/notifications'],
    [
      'trainer',
      { isAcademyManager: false, roles: ['trainer'] },
      '/app/trainer/settings/notifications',
    ],
    [
      'academy manager with no roles row',
      { isAcademyManager: true, roles: [] },
      '/app/academy/settings/notifications',
    ],
    [
      'academy manager who is also a trainer prefers academy',
      { isAcademyManager: true, roles: ['trainer', 'player'] },
      '/app/academy/settings/notifications',
    ],
    [
      'trainer who is also a player prefers trainer',
      { isAcademyManager: false, roles: ['player', 'trainer'] },
      '/app/trainer/settings/notifications',
    ],
    ['admin', { isAcademyManager: false, roles: ['admin'] }, '/app/player/settings/notifications'],
    ['club only', { isAcademyManager: false, roles: ['club'] }, null],
    ['no roles at all', { isAcademyManager: false, roles: [] }, null],
  ];

  it.each(cases)('%s', (_label, input, expected) => {
    expect(notificationSettingsPathFor(input)).toBe(expected);
  });
});

describe('NotificationSettingsEntry', () => {
  it('sends a player to the player surface', async () => {
    renderEntry();
    expect(await screen.findByTestId('where')).toHaveTextContent('player');
  });

  it('sends a trainer to the trainer surface', async () => {
    authState = { ...authState, roles: ['trainer', 'player'] };
    renderEntry();
    expect(await screen.findByTestId('where')).toHaveTextContent('trainer');
  });

  it('sends an academy manager to the academy surface, not the trainer one', async () => {
    // The N1 bug in one test: the trainer path is guarded by TrainerLayout, which bounces an
    // academy manager to the player dashboard and loses the deep link.
    authState = { ...authState, roles: [], isAcademyManager: true };
    renderEntry();
    expect(await screen.findByTestId('where')).toHaveTextContent('academy');
  });

  it('forwards with replace, so Back leaves the app instead of bouncing forward again', async () => {
    // Landing on /app/player first, then the entry: after the forward, Back must return to
    // /app/player. Without `replace` the entry is still in history, so Back re-enters it and is
    // immediately forwarded again — the person can never leave the settings page.
    renderEntry(['/app/player', NOTIFICATION_SETTINGS_ENTRY_PATH]);
    expect(await screen.findByTestId('where')).toHaveTextContent('player');
    screen.getByTestId('back').click();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('player-home'));
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
    // Not yet known to be logged out — bouncing here would throw away the deep link of a
    // recipient who IS signed in.
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('waits for roles before choosing a surface', async () => {
    // Session known, roles not yet. Forwarding on this state sends a trainer to the player page.
    authState = { ...authState, roles: [], profileReady: false };
    renderEntry();
    await Promise.resolve();
    expect(screen.queryByTestId('where')).toBeNull();
  });

  it('offers a retry when the role fetch FAILED, and does not claim the account has none', async () => {
    authState = { ...authState, roles: [], profileFetchFailed: true };
    renderEntry();
    await waitFor(() =>
      expect(screen.queryByTestId('notification-settings-unavailable')).toBeNull(),
    );
    expect(screen.queryByTestId('where')).toBeNull();
    // QueryErrorState renders a retry affordance; clicking it re-fetches rather than dead-ending.
    const retry = await screen.findByRole('button');
    retry.click();
    await waitFor(() => expect(refreshAuth).toHaveBeenCalled());
  });

  it('tells a club-only account plainly, instead of forwarding it into a bouncing guard', async () => {
    authState = { ...authState, roles: ['club'] };
    renderEntry();
    expect(await screen.findByTestId('notification-settings-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('where')).toBeNull();
  });
});

/**
 * Depth-aware scan of the router source. A substring check cannot tell "mounted at top level"
 * from "mounted inside PlayerLayout" — and that difference is the entire point of the route, so
 * a future refactor that nests it must fail here.
 */
/**
 * Index of the `>` that ends a JSX opening tag. Scanning for the first `>` is wrong: every route
 * here carries `element={<Layout />}`, whose own `/>` would be read as the end of the tag — which
 * makes a layout route look self-closing and hides everything nested in it.
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
  const start = src.indexOf(openerNeedle);
  if (start < 0) throw new Error(`opener not found: ${openerNeedle}`);
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

describe('routeBlockRange (self-test — the extractor must not pass by being blind)', () => {
  const fixture = [
    '<Route path="/a" element={<L />}>',
    '  <Route index element={<X />} />',
    '  <Route path="deep" element={<M />}>',
    '    <Route path="deeper" element={<Y />} />',
    '  </Route>',
    '</Route>',
    '<Route path="/outside" element={<Z />} />',
  ].join('\n');

  it('spans nested blocks and stops at the matching close', () => {
    const [start, end] = routeBlockRange(fixture, '<Route path="/a"');
    const block = fixture.slice(start, end);
    expect(block).toContain('path="deeper"');
    expect(block).not.toContain('path="/outside"');
  });

  it('does not read the `/>` inside element={<L />} as the end of the opening tag', () => {
    // The failure this pins: treating the layout route as self-closing makes its whole subtree
    // invisible, so "the entry is not nested under PlayerLayout" would pass without checking.
    const opener = '<Route path="/a" element={<L />}>';
    expect(jsxTagEnd(fixture, fixture.indexOf(opener))).toBe(
      fixture.indexOf(opener) + opener.length - 1,
    );
  });

  it('throws rather than silently returning nothing when the opener is absent', () => {
    expect(() => routeBlockRange(fixture, '<Route path="/nope"')).toThrow(/opener not found/);
  });
});

describe('router placement', () => {
  const router = readSrc('components/DomainRouter.tsx');

  it('registers the neutral path', () => {
    expect(router).toContain(`path="${NOTIFICATION_SETTINGS_ENTRY_PATH}"`);
    expect(router).toContain('NotificationSettingsEntry');
  });

  it.each([
    ['player', '<Route path="/app/player" element={<PlayerLayout />}>'],
    ['trainer', '<Route path="/app/trainer" element={<TrainerLayout />}>'],
  ])('mounts it OUTSIDE the %s layout', (_role, opener) => {
    const [start, end] = routeBlockRange(router, opener);
    expect(router.slice(start, end)).not.toContain(NOTIFICATION_SETTINGS_ENTRY_PATH);
  });
});

describe('Auth redirect sanitisation', () => {
  // Source-level: Auth.tsx pulls in the whole login stack, and the invariant worth pinning is
  // structural — that NO path from `?redirect=` to navigate() skips the sanitiser.
  // sanitizeAppRedirect's own behaviour is covered in src/lib/signupClaimFlow.test.ts.
  const auth = readSrc('pages/Auth.tsx');

  it('sanitises on the way in', () => {
    expect(auth).toContain("const redirect = sanitizeAppRedirect(searchParams.get('redirect'));");
    expect(auth).not.toMatch(/setItem\('redirectAfterLogin',\s*searchParams\.get/);
  });

  it('sanitises on the way out, and purges a value that fails', () => {
    expect(auth).toContain('const redirectUrl = sanitizeAppRedirect(storedRedirect);');
    expect(auth).toMatch(
      /if \(storedRedirect && !redirectUrl\) sessionStorage\.removeItem\('redirectAfterLogin'\);/,
    );
    // The raw stored value must never be what gets navigated to.
    expect(auth).not.toMatch(/navigate\(storedRedirect\)/);
  });
});
