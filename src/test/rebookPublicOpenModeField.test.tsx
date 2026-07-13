// RebookPublicOpenModeField: the wizard control for "how the public books a freed session".
// The split toggle only appears for modes where splitting a price is meaningful (per-seat /
// whole-cyclus) — never for whole-court (one payment) or 'inherit' (carries the source flag).
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { RebookPublicOpenModeField, type PublicOpenMode } from '@/components/cycles/RebookPublicOpenModeField';

const setup = (mode: PublicOpenMode, split = false) => {
  const setMode = vi.fn();
  const setSplit = vi.fn();
  const utils = render(
    <RebookPublicOpenModeField mode={mode} setMode={setMode} split={split} setSplit={setSplit} />,
  );
  const checkbox = () => utils.container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  return { ...utils, setMode, setSplit, checkbox };
};

describe('RebookPublicOpenModeField', () => {
  it('hides the split toggle for inherit (source flag carries it)', () => {
    expect(setup('inherit').checkbox()).toBeNull();
  });

  it('hides the split toggle for whole-court (one payment, can not split)', () => {
    expect(setup('single_only_whole_slot').checkbox()).toBeNull();
  });

  it('shows the split toggle for per-seat / both / whole-cyclus modes', () => {
    expect(setup('both').checkbox()).not.toBeNull();
    expect(setup('single_only').checkbox()).not.toBeNull();
    expect(setup('cyclus_only').checkbox()).not.toBeNull();
  });

  it('reflects the split value and reports changes', () => {
    const { checkbox, setSplit } = setup('cyclus_only', true);
    expect(checkbox()!.checked).toBe(true);
    fireEvent.click(checkbox()!);
    expect(setSplit).toHaveBeenCalledWith(false);
  });
});
