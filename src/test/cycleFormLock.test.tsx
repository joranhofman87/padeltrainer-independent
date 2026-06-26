import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithCycles } from './renderWithCycles';
import { makeCycle } from './fixtures/factory';

// CycleForm fetches rating systems + uses rich-text editors on mount — stub the heavy bits so the
// (very large) form renders cheaply in jsdom. The lock behaviour under test is prop-driven only.
vi.mock('@/lib/ratingSystems', () => ({ getRatingSystems: () => Promise.resolve([]) }));
vi.mock('@/components/ui/rich-text-editor', () => ({ RichTextEditor: () => null }));
vi.mock('@/components/ui/mini-rich-text-editor', () => ({ MiniRichTextEditor: () => null }));

// localStorage isn't provided in this test env (the component's try/catch swallows it) — stub it so
// the draft-restore path can be exercised.
const _ls: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => (k in _ls ? _ls[k] : null),
  setItem: (k: string, v: string) => {
    _ls[k] = v;
  },
  removeItem: (k: string) => {
    delete _ls[k];
  },
  clear: () => {
    Object.keys(_ls).forEach((k) => delete _ls[k]);
  },
});

// Imported AFTER the mocks so they take effect.
const { default: CycleForm } = await import('@/components/cycles/CycleForm');

const baseProps = { ownerType: 'academy' as const, ownerId: 'acad-1', formType: 'registration' as const };

describe('Slice 0 — CycleForm registration-lock guard', () => {
  it('locked: shows the banner + disables the Save button', async () => {
    renderWithCycles(<CycleForm {...baseProps} cycle={makeCycle({ type: 'cyclus' })} locked />);
    expect(await screen.findByText(/Editing moved to the registration editor/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save Registration/i })).toBeDisabled();
  });

  it('unlocked: no banner, Save enabled', () => {
    renderWithCycles(<CycleForm {...baseProps} cycle={makeCycle({ type: 'cyclus' })} locked={false} />);
    expect(screen.queryByText(/Editing moved to the registration editor/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save Registration/i })).not.toBeDisabled();
  });

  it('locked: wraps the form body in a disabled <fieldset> (natively disables every input)', async () => {
    const { container } = renderWithCycles(
      <CycleForm {...baseProps} cycle={makeCycle({ type: 'cyclus', name: 'Zomer' })} locked />,
    );
    await screen.findByText(/Editing moved to the registration editor/i); // flush mount effects
    const fieldset = container.querySelector('fieldset');
    expect(fieldset).not.toBeNull();
    // A disabled fieldset disables all descendant controls via :disabled inheritance — asserting the
    // input's own .disabled would be false even in a real browser, so we assert the mechanism.
    expect(fieldset).toBeDisabled();
  });

  it('unlocked: the fieldset is not disabled', async () => {
    const { container } = renderWithCycles(
      <CycleForm {...baseProps} cycle={makeCycle({ type: 'cyclus', name: 'Zomer' })} locked={false} />,
    );
    await screen.findByRole('button', { name: /Save Registration/i });
    const fieldset = container.querySelector('fieldset');
    expect(fieldset).not.toBeDisabled();
  });

  // Audit remediation: a locked (split) form must NOT offer to restore a localStorage draft (it
  // can't be saved, and a stale draft must not survive to a later unlocked state).
  const seedDraft = (cycleId: string) =>
    localStorage.setItem(
      `cycle-form-draft:academy:acad-1:${cycleId}`,
      JSON.stringify({ v: 1, savedAt: Date.now(), values: { name: 'Stale draft' } }),
    );

  it('locked: does NOT show the draft-restore prompt even when a draft exists', () => {
    seedDraft('cyc-lock-draft');
    renderWithCycles(<CycleForm {...baseProps} cycle={makeCycle({ id: 'cyc-lock-draft', type: 'cyclus' })} locked />);
    expect(screen.queryByRole('button', { name: /herstellen|restore/i })).not.toBeInTheDocument();
    localStorage.clear();
  });

  it('unlocked: DOES show the draft-restore prompt when a draft exists (control)', () => {
    seedDraft('cyc-unlock-draft');
    renderWithCycles(
      <CycleForm {...baseProps} cycle={makeCycle({ id: 'cyc-unlock-draft', type: 'cyclus' })} locked={false} />,
    );
    expect(screen.getByRole('button', { name: /herstellen|restore/i })).toBeInTheDocument();
    localStorage.clear();
  });
});
