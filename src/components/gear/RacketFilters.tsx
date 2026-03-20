import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

export interface RacketFilterState {
  brand: string[];
  level: string | null;
  playingStyle: string | null;
  shape: string | null;
  weight: string | null;
  maxPrice: number | null;
  armFriendly: boolean;
}

export const EMPTY_FILTERS: RacketFilterState = {
  brand: [], level: null, playingStyle: null, shape: null, weight: null, maxPrice: null, armFriendly: false,
};

const PRICE_BUCKETS = [
  { label: '€0–80', max: 80 },
  { label: '€80–130', max: 130 },
  { label: '€130–200', max: 200 },
  { label: '€200+', max: 999 },
];

const LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
const STYLES = ['control', 'allround', 'power'] as const;
const SHAPES = ['round', 'teardrop', 'diamond'] as const;
const WEIGHTS = ['light', 'medium', 'heavy'] as const;

interface RacketFiltersProps {
  filters: RacketFilterState;
  onChange: (f: RacketFilterState) => void;
  brands: string[];
  totalCount: number;
  filteredCount: number;
}

export function RacketFilters({ filters, onChange, brands, totalCount, filteredCount }: RacketFiltersProps) {
  const { t } = useTranslation('marketing');

  const activeCount = filters.brand.length
    + (filters.level ? 1 : 0)
    + (filters.playingStyle ? 1 : 0)
    + (filters.shape ? 1 : 0)
    + (filters.weight ? 1 : 0)
    + (filters.maxPrice ? 1 : 0)
    + (filters.armFriendly ? 1 : 0);

  const toggleBrand = (b: string) => {
    const next = filters.brand.includes(b)
      ? filters.brand.filter(x => x !== b)
      : [...filters.brand, b];
    onChange({ ...filters, brand: next });
  };

  const toggleSingle = (key: 'level' | 'playingStyle' | 'shape' | 'weight', val: string) => {
    onChange({ ...filters, [key]: filters[key] === val ? null : val });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('gear.showingCount', 'Showing {{filtered}} of {{total}} rackets', { filtered: filteredCount, total: totalCount })}
        </p>
        {activeCount > 0 && (
          <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
            <X className="mr-1 h-3 w-3" /> {t('gear.clearAll', 'Clear all')}
          </Button>
        )}
      </div>

      {/* Level */}
      <FilterSection label={t('gear.filter.level', 'Level')}>
        <div className="flex flex-wrap gap-2">
          {LEVELS.map(v => (
            <Badge
              key={v}
              variant={filters.level === v ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => toggleSingle('level', v)}
            >
              {v}
            </Badge>
          ))}
        </div>
      </FilterSection>

      {/* Playing style */}
      <FilterSection label={t('gear.filter.style', 'Playing Style')}>
        <div className="flex flex-wrap gap-2">
          {STYLES.map(v => (
            <Badge
              key={v}
              variant={filters.playingStyle === v ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => toggleSingle('playingStyle', v)}
            >
              {v}
            </Badge>
          ))}
        </div>
      </FilterSection>

      {/* Shape */}
      <FilterSection label={t('gear.filter.shape', 'Shape')}>
        <div className="flex flex-wrap gap-2">
          {SHAPES.map(v => (
            <Badge
              key={v}
              variant={filters.shape === v ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => toggleSingle('shape', v)}
            >
              {v}
            </Badge>
          ))}
        </div>
      </FilterSection>

      {/* Weight */}
      <FilterSection label={t('gear.filter.weight', 'Weight')}>
        <div className="flex flex-wrap gap-2">
          {WEIGHTS.map(v => (
            <Badge
              key={v}
              variant={filters.weight === v ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => toggleSingle('weight', v)}
            >
              {v}
            </Badge>
          ))}
        </div>
      </FilterSection>

      {/* Price */}
      <FilterSection label={t('gear.filter.price', 'Price')}>
        <div className="flex flex-wrap gap-2">
          {PRICE_BUCKETS.map(b => (
            <Badge
              key={b.max}
              variant={filters.maxPrice === b.max ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => onChange({ ...filters, maxPrice: filters.maxPrice === b.max ? null : b.max })}
            >
              {b.label}
            </Badge>
          ))}
        </div>
      </FilterSection>

      {/* Arm-friendly */}
      <FilterSection label={t('gear.filter.armFriendly', 'Arm-friendly')}>
        <div className="flex items-center gap-2">
          <Switch
            checked={filters.armFriendly}
            onCheckedChange={v => onChange({ ...filters, armFriendly: v })}
          />
          <span className="text-sm text-muted-foreground">{t('gear.filter.armFriendlyOnly', 'Only arm-friendly rackets')}</span>
        </div>
      </FilterSection>

      {/* Brands */}
      {brands.length > 0 && (
        <FilterSection label={t('gear.filter.brand', 'Brand')}>
          <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
            {brands.map(b => (
              <label key={b} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={filters.brand.includes(b)}
                  onCheckedChange={() => toggleBrand(b)}
                />
                {b}
              </label>
            ))}
          </div>
        </FilterSection>
      )}
    </div>
  );
}

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-semibold text-foreground">{label}</h4>
      {children}
    </div>
  );
}
