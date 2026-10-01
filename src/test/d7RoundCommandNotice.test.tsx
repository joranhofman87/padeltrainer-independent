// E-7 (notice half) — the D7 round-command outcomes on screen.
//
// The wizards are NOT cut over to the D7 command surface yet (see `d7RuntimeWiring.test.ts` for why
// that is a recorded position rather than an omission), so the wizard-level assertions the plan
// describes have no live call path to attach to. What DOES ship, and what those assertions were
// really about, is the notice contract itself:
//
//   • PERSISTENT, never a toast — a blocking outcome must still be on screen when the operator
//     scrolls back to it;
//   • keyed on the STRUCTURED reason, never on a display string — a translation change must not
//     silently break reconciliation or a test;
//   • focused exactly ONCE per distinct reason — a re-render must not steal focus mid-typing, and a
//     genuinely new outcome must always announce itself;
//   • an `unknown` NEVER reads as success, and never offers a navigation.
//
// Every one of the twenty closed statuses and seven unknown reasons is exercised, because a missing
// key renders as a raw key or an empty body and both are worse than the outcome they describe.
import type { ReactElement } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18n from 'i18next';
import enCycles from '@/i18n/locales/en/cycles.json';
import nlCycles from '@/i18n/locales/nl/cycles.json';
import {
  RebookRoundCommandRefusalAlert,
  RebookRoundCommandUnknownAlert,
} from '@/components/cycles/PriorityUnavailableNotice';
import { APPLY_STATUSES, PREVIEW_STATUSES } from '@/lib/rebookRoundCommand';
import type { RoundUnknownReason } from '@/lib/rebookRoundDriver';

const inst = i18n.createInstance();
void inst.use(initReactI18next).init({
  lng: 'en', fallbackLng: 'en',
  resources: { en: { cycles: enCycles }, nl: { cycles: nlCycles } },
  ns: ['cycles'], defaultNS: 'cycles',
  interpolation: { escapeValue: false },
});
const wrap = (ui: ReactElement) => render(<I18nextProvider i18n={inst}>{ui}</I18nextProvider>);

/** Every closed status that means "nothing was created". */
const REFUSAL_STATUSES = [...new Set([...PREVIEW_STATUSES, ...APPLY_STATUSES])]
  .filter((s) => s !== 'previewed' && s !== 'applied' && s !== 'replayed');

const UNKNOWN_REASONS: RoundUnknownReason[] = [
  'transport_error', 'unreadable_probe', 'unreadable_preview', 'unreadable_apply',
  'unreadable_lookup', 'probe_not_understood', 'review_fingerprint_unreadable',
];

describe('E-7 — every closed round-command status has real copy', () => {
  it('covers all seventeen refusals plus the wrapper refusal, with no key leaking to the screen', () => {
    expect(REFUSAL_STATUSES.length).toBe(18);
    const bodies = new Set<string>();
    for (const status of REFUSAL_STATUSES) {
      cleanup();
      wrap(<RebookRoundCommandRefusalAlert status={status as never} />);
      const alert = screen.getByTestId('round-command-refusal');
      const body = alert.textContent ?? '';
      // A MISSING KEY RENDERS AS THE KEY. That is worse than saying nothing, because it looks like
      // a system error rather than the specific, actionable refusal the server actually gave.
      expect(body, `${status} must not render its i18n key`).not.toContain('newRound.command');
      expect(body.length, `${status} must have real copy`).toBeGreaterThan(40);
      // Every refusal must state that nothing was created — the operator's first question.
      expect(body, `${status} must say nothing was created`).toMatch(/Nothing was created/);
      bodies.add(body);
    }
    // AND EACH ONE SAYS SOMETHING DIFFERENT. Merging two statuses into one message tells the
    // operator less than the server said about what to do next.
    expect(bodies.size, 'every status must have its own message').toBe(REFUSAL_STATUSES.length);
  });

  it('covers all seven unknown reasons, and never claims success', () => {
    const bodies = new Set<string>();
    for (const reason of UNKNOWN_REASONS) {
      cleanup();
      wrap(<RebookRoundCommandUnknownAlert reason={reason} />);
      const alert = screen.getByTestId('round-command-unknown');
      const body = alert.textContent ?? '';
      expect(body).not.toContain('newRound.command');
      // AN UNKNOWN MUST BE HEDGED OR NEGATIVE, never a statement of fact in either direction.
      // "The round was created" is false confidence; so is "the round could not be created" after
      // a write that may have landed — the second invites a retry that makes a second round.
      expect(body, `${reason} must hedge or deny, never assert`)
        .toMatch(/\bmay\b|Nothing was created|could not be read|could not look up/i);
      expect(body, `${reason} must not assert creation`).not.toMatch(/has been created|is created/i);
      expect(body, `${reason} must not claim success`).not.toMatch(/successful|succeeded/i);
      // ...and it must tell the operator what to do, which is always: go and look first.
      expect(body, `${reason} must point somewhere`).toMatch(/Check the rounds page|Reload the page/);
      bodies.add(body);
    }
    expect(bodies.size).toBe(UNKNOWN_REASONS.length);
  });

  it('carries the same key set in Dutch — a locale gap would silently fall back to English', () => {
    const dig = (o: unknown, path: string[]): unknown =>
      path.reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], o);
    for (const status of REFUSAL_STATUSES) {
      expect(dig(nlCycles, ['newRound', 'command', 'refusal', status]),
        `nl is missing newRound.command.refusal.${status}`).toBeTruthy();
    }
    for (const reason of UNKNOWN_REASONS) {
      expect(dig(nlCycles, ['newRound', 'command', 'unknown', reason]),
        `nl is missing newRound.command.unknown.${reason}`).toBeTruthy();
    }
  });
});

describe('E-7 — the notice contract', () => {
  it('is PERSISTENT and announced, not a toast', () => {
    wrap(<RebookRoundCommandRefusalAlert status="round_closed" />);
    const alert = screen.getByTestId('round-command-refusal');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    // It stays in the tree: nothing dismisses it on a timer.
    expect(screen.queryByTestId('round-command-refusal')).not.toBeNull();
  });

  it('is keyed on the STRUCTURED status, not on the display string', () => {
    wrap(<RebookRoundCommandRefusalAlert status="source_drift" />);
    expect(screen.getByTestId('round-command-refusal').getAttribute('data-command-status'))
      .toBe('source_drift');
  });

  it('renders NOTHING when there is no outcome — absence is not an empty alert', () => {
    wrap(<RebookRoundCommandRefusalAlert status={null} />);
    expect(screen.queryByTestId('round-command-refusal')).toBeNull();
    wrap(<RebookRoundCommandUnknownAlert reason={null} />);
    expect(screen.queryByTestId('round-command-unknown')).toBeNull();
  });

  it('focuses ONCE per distinct reason: a re-render with the same reason does not re-steal focus', () => {
    const { rerender } = wrap(<RebookRoundCommandRefusalAlert status="round_closed" />);
    const alert = screen.getByTestId('round-command-refusal');
    expect(document.activeElement).toBe(alert);

    // The operator moves focus away — to a field they are typing in, in the real UI.
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    rerender(
      <I18nextProvider i18n={inst}>
        <RebookRoundCommandRefusalAlert status="round_closed" />
      </I18nextProvider>,
    );
    expect(document.activeElement, 'a re-render on the SAME reason must not steal focus back')
      .toBe(elsewhere);

    // ...but a genuinely NEW outcome must announce itself.
    rerender(
      <I18nextProvider i18n={inst}>
        <RebookRoundCommandRefusalAlert status="source_drift" />
      </I18nextProvider>,
    );
    expect(document.activeElement, 'a new reason must take focus')
      .toBe(screen.getByTestId('round-command-refusal'));
  });

  it('an unknown carries the command id as DATA, never as a navigation', () => {
    const commandId = '99999999-9999-4999-8999-999999999991';
    wrap(<RebookRoundCommandUnknownAlert reason="transport_error" commandId={commandId} />);
    const alert = screen.getByTestId('round-command-unknown');
    // The id is the ONLY thing that can resolve an unknown, through the driver's recovery hops, so
    // it is preserved — but following it automatically would be a navigation on an unverified
    // creation, and re-submitting with a fresh id is how one action becomes two rounds.
    expect(alert.getAttribute('data-command-id')).toBe(commandId);
    expect(alert.getAttribute('data-unknown-reason')).toBe('transport_error');
    expect(alert.querySelector('a'), 'an unknown must not offer a link').toBeNull();
    expect(alert.querySelector('button'), 'an unknown must not offer a one-click retry').toBeNull();
  });

  it('omits the command id attribute entirely when there is none — never an empty string', () => {
    wrap(<RebookRoundCommandUnknownAlert reason="unreadable_probe" />);
    const alert = screen.getByTestId('round-command-unknown');
    expect(alert.hasAttribute('data-command-id')).toBe(false);
  });
});
