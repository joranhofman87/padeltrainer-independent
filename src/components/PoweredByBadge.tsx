import { LocalizedLink } from '@/components/LocalizedLink';

interface PoweredByBadgeProps {
  variant?: 'light' | 'dark';
  size?: 'sm' | 'md';
  className?: string;
  /** Optional UTM-style source identifier appended to the link. */
  source?: string;
}

/**
 * Reusable "Powered by PadelTrainer.ai" badge for partner clubs and embeds.
 * Provides a backlink to the platform with theme-aware styling.
 */
export function PoweredByBadge({
  variant = 'light',
  size = 'sm',
  className = '',
  source,
}: PoweredByBadgeProps) {
  const isDark = variant === 'dark';
  const sizeClasses = size === 'md' ? 'text-sm px-3 py-2' : 'text-xs px-2.5 py-1.5';
  const baseClasses = isDark
    ? 'bg-foreground text-background hover:opacity-90'
    : 'bg-background text-foreground border border-border hover:bg-muted';
  const href = source ? `/?utm_source=${encodeURIComponent(source)}&utm_medium=badge` : '/';

  return (
    <LocalizedLink
      to={href}
      className={`inline-flex items-center gap-1.5 rounded-full font-medium transition-opacity ${sizeClasses} ${baseClasses} ${className}`}
      aria-label="Powered by PadelTrainer.ai"
    >
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="12" r="10" opacity="0.2" />
        <path d="M8 12l3 3 5-7" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>Powered by <strong>PadelTrainer.ai</strong></span>
    </LocalizedLink>
  );
}
