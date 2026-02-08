import { supabase } from '@/lib/supabaseClient';

/**
 * Resolves the applicable general terms for a trainer.
 * If the trainer belongs to an academy with terms, those take precedence.
 * Otherwise, the trainer's own terms are returned.
 * Returns null if no terms are set.
 */
export async function getApplicableTerms(trainerProfileId: string): Promise<{ terms: string | null; source: 'academy' | 'trainer' | null; academyName?: string }> {
  // Check if trainer belongs to an active academy
  const { data: academyTrainer } = await supabase
    .from('academy_trainers')
    .select('academy_profile_id, academy_profiles:academy_profile_id(general_terms, name)')
    .eq('trainer_profile_id', trainerProfileId)
    .eq('status', 'active')
    .maybeSingle();

  if (academyTrainer) {
    const academy = academyTrainer.academy_profiles as unknown as { general_terms: string | null; name: string } | null;
    if (academy?.general_terms) {
      return { terms: academy.general_terms, source: 'academy', academyName: academy.name };
    }
  }

  // Fall back to trainer's own terms
  const { data: trainer } = await supabase
    .from('trainer_profiles')
    .select('general_terms')
    .eq('id', trainerProfileId)
    .maybeSingle();

  if (trainer?.general_terms) {
    return { terms: trainer.general_terms, source: 'trainer' };
  }

  return { terms: null, source: null };
}

/**
 * Resolves terms for a cycle owner (trainer or academy).
 */
export async function getTermsForCycleOwner(ownerId: string, ownerType: string): Promise<{ terms: string | null; source: 'academy' | 'trainer' | null }> {
  if (ownerType === 'academy') {
    const { data } = await supabase
      .from('academy_profiles')
      .select('general_terms')
      .eq('id', ownerId)
      .maybeSingle();

    return { terms: data?.general_terms || null, source: data?.general_terms ? 'academy' : null };
  }

  // For trainer-owned cycles, use the same resolution logic
  return getApplicableTerms(ownerId);
}
