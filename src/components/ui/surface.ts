import { cn } from '@/lib/utils';

/**
 * Surface that is flush / edge-to-edge on mobile (no border, radius, shadow or
 * card background) and a premium card from md: up. On a phone the viewport is
 * already the container, so nesting a box inside it only wastes width and adds
 * visual noise — this reclaims the full screen while keeping the framed card on
 * wider screens. Apply to section/panel/list containers, NOT to genuine cards
 * like stat tiles or callouts that are meant to read as discrete units.
 */
export function flushOnMobileCardClass(className?: string) {
  return cn(
    'border-0 rounded-none bg-transparent shadow-none',
    'md:rounded-xl md:border md:border-border/60 md:bg-card md:shadow-sm',
    className,
  );
}
