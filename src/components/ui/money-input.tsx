import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type MoneyInputSize = 'default' | 'sm';

const SIZE_CLASSES: Record<MoneyInputSize, { symbol: string; input: string }> = {
  // Canonical geometry from CyclePricingCard: default = standard-height input with
  // a text-sm € at left-3 / pl-7; sm = compact h-8 row with a text-xs € at left-2 / pl-5.
  default: {
    symbol: 'absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm',
    input: 'pl-7',
  },
  sm: {
    symbol: 'absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs',
    input: 'pl-5 h-8 text-sm',
  },
};

export interface MoneyInputProps extends Omit<React.ComponentProps<typeof Input>, 'size'> {
  /** Visual size: 'default' (standard input, pl-7) or 'sm' (h-8 text-sm compact, pl-5). */
  size?: MoneyInputSize;
  /** Extra classes for the relative wrapper div (e.g. widths like `w-24`). */
  wrapperClassName?: string;
}

/**
 * Euro-adorned number input leaf: relative wrapper + absolute € symbol + Input.
 * Owns ONLY the adornment geometry — value/onChange (and all other Input props)
 * pass straight through, so every caller keeps its own value contract and
 * parsing rules (share the leaf, not the business rule).
 */
export const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ size = 'default', wrapperClassName, className, type = 'number', ...props }, ref) => {
    const sizeClasses = SIZE_CLASSES[size];

    return (
      <div className={cn('relative', wrapperClassName)}>
        <span aria-hidden="true" className={sizeClasses.symbol}>
          €
        </span>
        <Input ref={ref} type={type} className={cn(sizeClasses.input, className)} {...props} />
      </div>
    );
  },
);
MoneyInput.displayName = 'MoneyInput';
