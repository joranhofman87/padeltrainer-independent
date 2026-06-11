import { SignupValuePanel } from '@/components/auth/SignupValuePanel';

/** @deprecated Use SignupValuePanel with role="trainer" */
export function TrainerSignupValuePanel() {
  // eslint-disable-next-line jsx-a11y/aria-role -- `role` is SignupValuePanel's custom prop (SignupRoleKey), not an ARIA role
  return <SignupValuePanel role="trainer" />;
}
