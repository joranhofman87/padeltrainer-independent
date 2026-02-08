import { useTheme } from 'next-themes';
import logoDark from '@/assets/logo-dark.png';
import logoLight from '@/assets/logo-light.png';

interface LogoProps {
  className?: string;
}

export function Logo({ className = 'h-7' }: LogoProps) {
  const { resolvedTheme } = useTheme();
  const src = resolvedTheme === 'dark' ? logoLight : logoDark;

  return (
    <img
      src={src}
      alt="PadelTrainer.ai"
      className={className}
      style={{ objectFit: 'contain' }}
    />
  );
}
