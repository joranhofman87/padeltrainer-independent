import type { UserRole } from '@/lib/auth';

/**
 * Where an account's home surface is — the same table `Auth.tsx`'s `routeByRole` uses after login.
 *
 * It exists so a fallback destination cannot invent its own answer. The first version of the
 * notification back button guessed with `isAcademyManager ? academy : trainer ? trainer : player`,
 * which sends a CLUB-only account to `/app/player`, where `PlayerLayout` rejects any account whose
 * roles lack player/trainer/admin and redirects to the login form — logging out a signed-in person
 * who pressed Back.
 *
 * The one deliberate divergence from `routeByRole`: that function additionally awaits
 * `isTrainerOnboardingComplete` and sends an incomplete trainer to `/app/onboarding/trainer`. A
 * navigation target does not need to: `TrainerLayout` performs that redirect itself on arrival.
 */
export function roleHomePath(input: {
  isAcademyManager: boolean;
  isClubManager: boolean;
  role: UserRole | null;
}): string {
  if (input.isAcademyManager) return '/app/academy';
  if (input.role === 'admin') return '/app/admin';
  if (input.role === 'trainer') return '/app/trainer';
  if (input.role === 'club' || input.isClubManager) return '/app/club';
  if (input.role === 'academy') return '/app/academy/onboarding';
  return '/app/player';
}
