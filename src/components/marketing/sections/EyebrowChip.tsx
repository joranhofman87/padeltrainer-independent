import { cn } from '@/lib/utils';

interface EyebrowChipProps {
  children: React.ReactNode;
  className?: string;
  /** "soft" = brand-50 pill (.eyebrow), "outline" = white card pill with dot */
  variant?: 'soft' | 'outline';
}

/**
 * Small uppercase pill used above section headings on marketing pages.
 * Mirrors the homepage hero/section eyebrow treatment.
 */
export function EyebrowChip({ children, className, variant = 'soft' }: EyebrowChipProps) {
  if (variant === 'outline') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-2 rounded-full bg-card border border-navy-900/10 shadow-soft px-3 py-1.5 text-xs font-medium text-navy-700',
          className,
        )}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />
        {children}
      </span>
    );
  }

  return <span className={cn('eyebrow', className)}>{children}</span>;
}
