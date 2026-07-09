import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

// Guards that BOTH academy rebooking flows expose the manual priority list, and
// that each passes the selected people into the bulk-rebook-cycle submit body.
// The per-location wizard (RebookCohortWizard) lacked this — the regression this
// test locks down.
describe('rebook priority list wiring', () => {
  it('RebookCohortWizard (per-location) mounts the priority field and submits priorityPeople', () => {
    const src = read('RebookCohortWizard.tsx');
    expect(src).toContain('RebookPriorityListField');
    expect(src).toContain('priorityPeople');
    // Registered profiles and accountless guests are submitted as two separate arrays.
    expect(src).toMatch(/priorityPeople:\s*priorityPeople\.filter\(\(p\)\s*=>\s*p\.player_type === 'registered'\)\.map\(\(p\)\s*=>\s*p\.id\)/);
    expect(src).toMatch(/priorityGuests:\s*priorityPeople\.filter\(\(p\)\s*=>\s*p\.player_type === 'guest'\)\.map\(\(p\)\s*=>\s*p\.id\)/);
    expect(src).toContain('memberOpenMessage');
    // priority requires the member window to be on
    expect(src).toContain('lockMemberWindow={priorityPeople.length > 0}');
  });

  it('AcademyNewRoundWizard (per-cyclus) still mounts the priority field and submits priorityPeople', () => {
    const src = read('AcademyNewRoundWizard.tsx');
    expect(src).toContain('RebookPriorityListField');
    expect(src).toMatch(/priorityPeople:\s*priorityPeople\.filter\(\(p\)\s*=>\s*p\.player_type === 'registered'\)\.map\(\(p\)\s*=>\s*p\.id\)/);
    expect(src).toMatch(/priorityGuests:\s*priorityPeople\.filter\(\(p\)\s*=>\s*p\.player_type === 'guest'\)\.map\(\(p\)\s*=>\s*p\.id\)/);
  });

  it('the priority field uses the stay-open multi-select (not the single-pick combobox)', () => {
    const src = read('RebookPriorityListField.tsx');
    expect(src).toContain('PlayerMultiSelect');
    expect(src).not.toContain('GuestPlayerSlotCombobox');
  });
});
