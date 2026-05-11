import { cn } from '@/lib/utils';

interface IconTileProps {
  icon: React.ReactNode;
  className?: string;
  tone?: 'brand' | 'navy';
  size?: 'md' | 'lg';
}

/**
 * Square rounded icon container used in feature grids, value cards, etc.
 * Matches the homepage design system token recipe.
 */
export function IconTile({ icon, className, tone = 'brand', size = 'md' }: IconTileProps) {
  return (
    <div
      className={cn(
        'rounded-xl flex items-center justify-center',
        size === 'lg' ? 'w-14 h-14' : 'w-12 h-12',
        tone === 'brand' ? 'bg-brand-50 text-brand-600' : 'bg-navy-50 text-navy-700',
        className,
      )}
    >
      {icon}
    </div>
  );
}
