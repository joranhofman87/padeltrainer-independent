import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type AppPageWidth = 'default' | 'narrow' | 'form' | 'wide';

const widthClass: Record<AppPageWidth, string> = {
  default: 'max-w-7xl',
  narrow: 'max-w-3xl',
  form: 'max-w-4xl',
  wide: 'max-w-[90rem]',
};

/**
 * Standard app page shell: max width, vertical rhythm, no extra horizontal padding
 * (role layouts provide p-4 md:p-6).
 */
export function AppPage({
  children,
  className,
  width = 'default',
  as: Component = 'div',
}: {
  children: ReactNode;
  className?: string;
  width?: AppPageWidth;
  as?: 'div' | 'main';
}) {
  return (
    <Component className={cn('mx-auto w-full space-y-6', widthClass[width], className)}>
      {children}
    </Component>
  );
}

/** Sticky sub-header / toolbar row aligned with page content */
export function appBarClass(className?: string) {
  return cn('mx-auto w-full max-w-7xl', className);
}

/** Premium card surface (Linear / Stripe style) */
export function surfaceCardClass(className?: string) {
  return cn('overflow-hidden rounded-xl border-border/60 bg-card shadow-sm', className);
}

/** Flush table inside a card */
export const dataTableCardContentClass = 'p-0';
