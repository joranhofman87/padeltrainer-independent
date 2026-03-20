import { urlFor } from '@/lib/sanity';

const BRAND_COLORS: Record<string, string> = {
  adidas: '0 0% 10%',
  babolat: '213 100% 31%',
  bullpadel: '354 79% 56%',
  dunlop: '152 100% 19%',
  head: '213 100% 40%',
  kuikma: '195 100% 45%',
  nox: '24 100% 50%',
  siux: '343 100% 39%',
  starvie: '48 100% 50%',
  varlion: '0 100% 27%',
  vibora: '120 39% 34%',
  wilson: '0 100% 40%',
};

const SHAPE_ICONS: Record<string, string> = {
  round: '●',
  teardrop: '◆',
  diamond: '◇',
};

interface RacketImageProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  image?: any;
  brand: string;
  shape?: string;
  name: string;
  className?: string;
  width?: number;
  height?: number;
}

export function RacketImage({ image, brand, shape, name, className = '', width = 400, height = 400 }: RacketImageProps) {
  if (image) {
    return (
      <img
        src={urlFor(image).width(width).height(height).fit('crop').auto('format').url()}
        alt={name}
        className={`object-cover ${className}`}
        loading="lazy"
      />
    );
  }

  const brandKey = brand?.toLowerCase().trim() || '';
  const bgColor = BRAND_COLORS[brandKey] || '220 15% 40%';

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${className}`}
      style={{ backgroundColor: `hsl(${bgColor})` }}
    >
      <span className="text-4xl opacity-60">{SHAPE_ICONS[shape || ''] || '🏓'}</span>
      <span className="text-sm font-semibold uppercase tracking-widest text-white/70">{brand}</span>
    </div>
  );
}
