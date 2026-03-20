import { LocalizedLink } from '@/components/LocalizedLink';
import { Badge } from '@/components/ui/badge';
import { RacketImage } from './RacketImage';

const LEVEL_COLORS: Record<string, string> = {
  beginner: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  intermediate: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  advanced: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
};

const STYLE_COLORS: Record<string, string> = {
  control: 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300',
  allround: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  power: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};

interface RacketCardProps {
  name: string;
  slug: string;
  brand: string;
  level?: string;
  playingStyle?: string;
  shape?: string;
  priceRange?: string;
  shortDescription?: string;
  armFriendly?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  image?: any;
}

export function RacketCard({
  name, slug, brand, level, playingStyle, shape, priceRange,
  shortDescription, armFriendly, image,
}: RacketCardProps) {
  return (
    <LocalizedLink
      to={`/gear/rackets/${slug}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="aspect-square overflow-hidden bg-muted">
        <RacketImage
          image={image}
          brand={brand}
          shape={shape}
          name={name}
          className="h-full w-full transition-transform duration-300 group-hover:scale-105"
        />
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="font-semibold leading-tight text-foreground line-clamp-2">{name}</h3>

        <div className="flex flex-wrap gap-1.5">
          {level && (
            <Badge variant="outline" className={`text-xs ${LEVEL_COLORS[level] || ''}`}>
              {level}
            </Badge>
          )}
          {playingStyle && (
            <Badge variant="outline" className={`text-xs ${STYLE_COLORS[playingStyle] || ''}`}>
              {playingStyle}
            </Badge>
          )}
          {armFriendly && (
            <Badge variant="outline" className="text-xs bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300">
              💪 Arm-friendly
            </Badge>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {brand} · {shape} · {priceRange}
        </p>

        {shortDescription && (
          <p className="mt-auto text-sm text-muted-foreground line-clamp-2">{shortDescription}</p>
        )}

        <span className="mt-2 text-sm font-medium text-primary group-hover:underline">
          View Details →
        </span>
      </div>
    </LocalizedLink>
  );
}
