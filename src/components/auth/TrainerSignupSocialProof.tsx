import { SignupSocialProof } from '@/components/auth/SignupSocialProof';

interface TrainerSignupSocialProofProps {
  className?: string;
}

/** @deprecated Use SignupSocialProof with role="trainer" */
export function TrainerSignupSocialProof({ className }: TrainerSignupSocialProofProps) {
  return (
    // eslint-disable-next-line jsx-a11y/aria-role -- 'role' is SignupSocialProof's domain prop (SignupRoleKey), not a DOM ARIA role
    <SignupSocialProof role="trainer" className={className} />
  );
}
