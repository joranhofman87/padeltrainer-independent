import { describe, it, expect } from 'vitest';
import {
  isInvoiceManager,
  canManageInvoice,
} from '../../supabase/functions/_shared/invoice-access.ts';

describe('isInvoiceManager', () => {
  const base = {
    isServiceRole: false,
    isAdmin: false,
    isOwningTrainer: false,
    isAcademyManager: false,
  };

  it('denies a caller with no qualifying relationship', () => {
    expect(isInvoiceManager(base)).toBe(false);
  });

  it.each([
    ['service role', { ...base, isServiceRole: true }],
    ['admin', { ...base, isAdmin: true }],
    ['owning trainer', { ...base, isOwningTrainer: true }],
    ['academy manager', { ...base, isAcademyManager: true }],
  ])('allows %s', (_label, flags) => {
    expect(isInvoiceManager(flags)).toBe(true);
  });
});

// A tiny stub of the supabase query builder for canManageInvoice.
function stubSupabase(opts: {
  trainerId?: string | null;
  isAdmin?: boolean;
  managesAcademy?: boolean;
}) {
  return {
    from(table: string) {
      const result =
        table === 'trainer_profiles'
          ? { data: opts.trainerId ? { id: opts.trainerId } : null }
          : table === 'user_roles'
            ? { data: opts.isAdmin ? { role: 'admin' } : null }
            : table === 'academy_managers'
              ? { data: opts.managesAcademy ? { id: 'm1' } : null }
              : { data: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve(result),
      };
      return builder;
    },
  };
}

describe('canManageInvoice', () => {
  const invoice = { trainer_id: 'trainer-1', academy_profile_id: 'academy-1' };

  it('short-circuits true for service-role callers', async () => {
    const allowed = await canManageInvoice(
      stubSupabase({}),
      { isServiceRole: true, user: { id: 'svc' } },
      invoice,
    );
    expect(allowed).toBe(true);
  });

  it('allows the owning trainer', async () => {
    const allowed = await canManageInvoice(
      stubSupabase({ trainerId: 'trainer-1' }),
      { isServiceRole: false, user: { id: 'u1' } },
      invoice,
    );
    expect(allowed).toBe(true);
  });

  it('allows an academy manager of the invoice academy', async () => {
    const allowed = await canManageInvoice(
      stubSupabase({ trainerId: 'other-trainer', managesAcademy: true }),
      { isServiceRole: false, user: { id: 'u2' } },
      invoice,
    );
    expect(allowed).toBe(true);
  });

  it('denies an unrelated authenticated user', async () => {
    const allowed = await canManageInvoice(
      stubSupabase({ trainerId: 'other-trainer' }),
      { isServiceRole: false, user: { id: 'u3' } },
      invoice,
    );
    expect(allowed).toBe(false);
  });
});
