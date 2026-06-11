import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StarRatingProps {
  value: number;
  onChange?: (value: number) => void;
  readOnly?: boolean;
  size?: 'sm' | 'md';
}

export function StarRating({ value, onChange, readOnly = false, size = 'md' }: StarRatingProps) {
  const starSize = size === 'sm' ? 'h-4 w-4' : 'h-6 w-6';

  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={readOnly}
          aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`}
          onClick={() => onChange?.(star)}
          className={cn(
            'transition-colors',
            readOnly ? 'cursor-default' : 'cursor-pointer hover:scale-110'
          )}
        >
          <Star
            className={cn(
              starSize,
              star <= value
                ? 'fill-primary text-primary'
                : 'fill-none text-muted-foreground/30'
            )}
          />
        </button>
      ))}
    </div>
  );
}
