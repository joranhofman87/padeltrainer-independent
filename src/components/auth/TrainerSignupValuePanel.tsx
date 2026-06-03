import { SignupValuePanel } from '@/components/auth/SignupValuePanel';

/** @deprecated Use SignupValuePanel with role="trainer" */
export function TrainerSignupValuePanel() {
  return <SignupValuePanel role="trainer" />;
}
