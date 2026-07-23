// @vitest-environment node
// Codex round-10 #3: the helper unit tests prove the helpers, but NOT that production still wires to
// them. These architectural pins read the real source so that reverting a caller to the old pattern
// (a wizard sending inline, a sender dropping pagination, the group scan escaping its gate) FAILS here
// even though the isolated helper tests stay green. Load-bearing given the repeated caller/helper
// divergence across this PR.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');
const component = (name: string) => read('src', 'components', 'cycles', name);
const edge = (name: string) => read('supabase', 'functions', name, 'index.ts');

describe('rebook orchestration wiring pins (Codex round-10 #3)', () => {
  it('BOTH round wizards create-then-drain via createAndDrainRebookRound (never a direct inline send)', () => {
    for (const wizard of ['RebookCohortWizard.tsx', 'AcademyNewRoundWizard.tsx']) {
      const s = component(wizard);
      expect(s, `${wizard} imports the shared orchestration`).toContain('createAndDrainRebookRound');
      // The submit handler creates the round ONLY through the helper. The P1 regression (a wizard
      // sending inline via a non-dryRun bulk-rebook-cycle invoke) reverts this call away → pin fails.
      // (The wizards still call bulk-rebook-cycle for `dryRun` PREVIEWS — those never send.)
      expect(s, `${wizard} calls the shared orchestration`).toMatch(/createAndDrainRebookRound\(/);
      // Every direct bulk-rebook-cycle invoke in a wizard must be a DRY-RUN preview — a real
      // (non-dryRun) invoke would be the inline-send bug. Assert no invoke body omits dryRun.
      const directInvokes = [...s.matchAll(/invoke\(\s*['"]bulk-rebook-cycle['"][\s\S]{0,400}?\}\)/g)].map((m) => m[0]);
      expect(directInvokes.length, `${wizard} should have at least the dryRun preview call(s)`).toBeGreaterThan(0);
      for (const call of directInvokes) {
        expect(call, `a direct bulk-rebook-cycle invoke in ${wizard} must be dryRun (else it sends inline)`).toContain('dryRun');
      }
    }
  });

  it('send-rebook-group-confirmation keeps the full member scan BEHIND gateGroupConfirmation', () => {
    const s = edge('send-rebook-group-confirmation');
    expect(s, 'imports/uses the gate').toContain('gateGroupConfirmation');
    expect(s, 'calls the gate with the probe/consume/scan steps').toMatch(/gateGroupConfirmation<[^>]*>\(\{/);
    expect(s, 'the full paginated read is the gate\'s `scan` step').toContain('scan:');
    expect(s, 'the keyset scan lives inside the gate').toContain('fetchAllKeyset<ClaimRow');
  });

  it('all three discovery senders read via the shared fetchAllInChunks helper', () => {
    for (const name of ['send-priority-claim-invitation', 'send-rebook-reminder', 'notify-rebook-member-open']) {
      const s = edge(name);
      expect(s, `${name} imports fetchAllInChunks`).toContain('fetchAllInChunks');
      expect(s, `${name} calls fetchAllInChunks`).toMatch(/fetchAllInChunks[<(]/);
    }
  });
});
