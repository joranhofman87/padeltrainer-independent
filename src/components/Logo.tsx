import { useTheme } from 'next-themes';
import logoDark from '@/assets/logo-dark.svg';
import logoLight from '@/assets/logo-light.svg';

interface LogoProps {
  className?: string;
  variant?: 'auto' | 'dark';
}

export function Logo({ className = 'h-7', variant = 'auto' }: LogoProps) {
  const { resolvedTheme } = useTheme();
  const src = variant === 'dark'
    ? logoLight
    : resolvedTheme === 'dark' ? logoLight : logoDark;

  return (
    <img
      src={src}
      alt="PadelTrainer.ai"
      className={className}
      style={{ objectFit: 'contain' }}
    />
  );
}
