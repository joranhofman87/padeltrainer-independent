import { SignupSocialProof } from '@/components/auth/SignupSocialProof';

interface TrainerSignupSocialProofProps {
  className?: string;
}

/** @deprecated Use SignupSocialProof with role="trainer" */
export function TrainerSignupSocialProof({ className }: TrainerSignupSocialProofProps) {
  return <SignupSocialProof role="trainer" className={className} />;
}
