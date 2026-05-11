import logoDark from '@/assets/logo-dark.svg';
import logoLight from '@/assets/logo-light.svg';

interface LogoProps {
  className?: string;
  variant?: 'auto' | 'dark';
}

export function Logo({ className = 'h-7', variant = 'auto' }: LogoProps) {
  // App is light-mode only; 'dark' variant means show the light logo (for use on dark backgrounds).
  const src = variant === 'dark' ? logoLight : logoDark;

  return (
    <img
      src={src}
      alt="PadelTrainer.ai"
      className={className}
      style={{ objectFit: 'contain' }}
    />
  );
}
