import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Public-booking audit P1-4: the invoice's billing party (academy vs trainer) must track the
// SLOT's academy_profile_id — the SAME key the charge uses (resolveSlotRecipient /
// create-mollie-payment) — so charge-org == invoice-org. Previously an UNFILTERED
// academy_trainers lookup stamped the invoice to the trainer's academy even for an INDEPENDENT
// slot (charge→trainer, invoice→academy: wrong number sequence + business identity). This locks
// the slot-authoritative routing so the unfiltered lookup can't be reintroduced.
const FN = 'supabase/functions/auto-create-invoice/index.ts';
const src = readFileSync(join(process.cwd(), FN), 'utf8');

describe('auto-create-invoice academy routing (P1-4: invoice party tracks the slot, not the trainer)', () => {
  it('does NOT query academy_trainers to choose the invoice party', () => {
    // The unfiltered trainer→academy lookup is the bug. Match the query, not the comment.
    expect(src).not.toContain('.from("academy_trainers")');
    expect(src).not.toContain(".from('academy_trainers')");
  });

  it('derives the invoice academy purely from the slots (length 1 = one academy, else trainer)', () => {
    expect(src).toContain('slotAcademyIds.length === 1 ? slotAcademyIds[0] : null');
  });
});
