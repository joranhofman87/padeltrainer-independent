import { cn } from '@/lib/utils';
import { EyebrowChip } from './EyebrowChip';

interface MarketingHeroProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Primary + secondary CTAs, trust row, etc. */
  actions?: React.ReactNode;
  trust?: React.ReactNode;
  /** Right-side visual (mock window, image, etc.). When present, hero becomes 7/5 split. */
  visual?: React.ReactNode;
  align?: 'left' | 'center';
  className?: string;
  /** Disable the dot-grid backdrop */
  noDotGrid?: boolean;
  /** Reduce vertical padding (used on tool/utility pages) */
  compact?: boolean;
}

/**
 * Standard marketing hero - matches the homepage HeroSection vibe.
 * Use across all pillar / tool / about-style pages for visual consistency.
 */
export function MarketingHero({
  eyebrow,
  title,
  subtitle,
  actions,
  trust,
  visual,
  align,
  className,
  noDotGrid = false,
  compact = false,
}: MarketingHeroProps) {
  const effectiveAlign = align ?? (visual ? 'left' : 'center');
  const hasVisual = Boolean(visual);

  return (
    <section className={cn('relative overflow-hidden', className)}>
      {!noDotGrid && <div className="absolute inset-0 dot-grid opacity-60 -z-10" aria-hidden />}
      <div
        className={cn(
          'relative max-w-7xl mx-auto px-4 md:px-6 overflow-hidden',
          compact
            ? 'pt-10 pb-10 md:pt-14 md:pb-14'
            : 'pt-10 pb-12 md:pt-16 md:pb-20 lg:pt-24 lg:pb-28',
          hasVisual ? 'grid lg:grid-cols-12 gap-8 lg:gap-12 items-center' : '',
        )}
      >
        <div
          className={cn(
            hasVisual ? 'lg:col-span-7 min-w-0' : 'max-w-3xl mx-auto',
            effectiveAlign === 'center' && !hasVisual ? 'text-center' : '',
          )}
        >
          {eyebrow && <EyebrowChip variant="outline">{eyebrow}</EyebrowChip>}

          <h1
            className={cn(
              'font-display font-extrabold text-navy-900 tracking-[-0.02em]',
              eyebrow ? 'mt-4 md:mt-6' : '',
              hasVisual
                ? 'text-[34px] sm:text-5xl lg:text-7xl leading-[1.05] sm:leading-[1.02]'
                : 'text-4xl sm:text-5xl md:text-6xl leading-[1.05]',
            )}
          >
            {title}
          </h1>

          {subtitle && (
            <p
              className={cn(
                'mt-4 md:mt-6 text-base sm:text-lg md:text-xl text-navy-700 leading-relaxed',
                hasVisual ? 'max-w-xl' : 'max-w-2xl',
                effectiveAlign === 'center' && !hasVisual ? 'mx-auto' : '',
              )}
            >
              {subtitle}
            </p>
          )}

          {actions && (
            <div
              className={cn(
                'mt-6 md:mt-8 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3',
                effectiveAlign === 'center' && !hasVisual ? 'justify-center' : '',
              )}
            >
              {actions}
            </div>
          )}

          {trust && (
            <div
              className={cn(
                'mt-5 md:mt-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:gap-x-5 sm:gap-y-2 text-xs sm:text-sm text-navy-600',
                effectiveAlign === 'center' && !hasVisual ? 'justify-center' : '',
              )}
            >
              {trust}
            </div>
          )}
        </div>

        {hasVisual && <div className="lg:col-span-5 relative">{visual}</div>}
      </div>
    </section>
  );
}
