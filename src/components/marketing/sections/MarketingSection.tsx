import { cn } from '@/lib/utils';
import { EyebrowChip } from './EyebrowChip';

type Background = 'default' | 'cream' | 'off' | 'navy';

interface MarketingSectionProps {
  id?: string;
  eyebrow?: React.ReactNode;
  heading?: React.ReactNode;
  subheading?: React.ReactNode;
  background?: Background;
  align?: 'left' | 'center';
  className?: string;
  containerClassName?: string;
  headerClassName?: string;
  children?: React.ReactNode;
  /** Show subtle dot grid backdrop (good on hero/CTA bands) */
  dotGrid?: boolean;
}

const BG: Record<Background, string> = {
  default: 'bg-background',
  cream: 'section-cream',
  off: 'section-off',
  navy: 'bg-navy-950 text-white',
};

/**
 * Standard marketing section wrapper used across pillar pages.
 * Provides consistent vertical rhythm, container width, eyebrow + heading.
 */
export function MarketingSection({
  id,
  eyebrow,
  heading,
  subheading,
  background = 'default',
  align = 'center',
  className,
  containerClassName,
  headerClassName,
  children,
  dotGrid = false,
}: MarketingSectionProps) {
  const isDark = background === 'navy';

  return (
    <section
      id={id}
      className={cn('relative overflow-hidden py-16 md:py-24 lg:py-32', BG[background], className)}
    >
      {dotGrid && <div className="absolute inset-0 dot-grid opacity-60 -z-0 pointer-events-none" aria-hidden />}
      <div className={cn('relative max-w-7xl mx-auto px-4 md:px-6', containerClassName)}>
        {(eyebrow || heading || subheading) && (
          <div
            className={cn(
              'mb-12 md:mb-14',
              align === 'center' ? 'text-center max-w-3xl mx-auto' : 'max-w-3xl',
              headerClassName,
            )}
          >
            {eyebrow && (
              <EyebrowChip
                className={isDark ? 'bg-white/10 text-white/80 ring-1 ring-white/20' : ''}
              >
                {eyebrow}
              </EyebrowChip>
            )}
            {heading && (
              <h2
                className={cn(
                  'mt-4 font-display text-3xl sm:text-4xl md:text-5xl font-extrabold tracking-[-0.02em] leading-tight',
                  isDark ? 'text-white' : 'text-navy-900',
                )}
              >
                {heading}
              </h2>
            )}
            {subheading && (
              <p
                className={cn(
                  'mt-5 text-lg leading-relaxed',
                  isDark ? 'text-white/70' : 'text-navy-700',
                )}
              >
                {subheading}
              </p>
            )}
          </div>
        )}
        {children}
      </div>
    </section>
  );
}
