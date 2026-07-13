import { useTranslation } from 'react-i18next';
import {
  Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { getTagColorClass } from '@/components/players/playerTagColors';
import type { CycleCategory } from '@/lib/cycleCategories';

const NONE = '__none__';
const MANAGE = '__manage__';

interface Props {
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  categories: CycleCategory[];
  onAssign: (categoryId: string | null) => void;
  onManage: () => void;
  disabled?: boolean;
}

/** Inline single-category assign for one overview row: a compact Select over the academy's
 *  category list (colored dots) + "none" + a "Manage…" action. Selecting a real value assigns it,
 *  'none' clears it, 'manage' opens the catalog dialog. */
export function CycleCategoryCell({ categoryId, categoryName, categoryColor, categories, onAssign, onManage, disabled }: Props) {
  const { t } = useTranslation('trainer');
  const value = categoryId ?? NONE;

  const onChange = (v: string) => {
    if (v === MANAGE) { onManage(); return; }
    onAssign(v === NONE ? null : v);
  };

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        className="h-7 w-auto min-w-[110px] max-w-[160px] border-dashed text-xs"
        onClick={(e) => e.stopPropagation()}
        aria-label={t('cyclesTab.category.assignLabel', { defaultValue: 'Categorie toewijzen' })}
      >
        <SelectValue>
          {categoryId ? (
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${getTagColorClass(categoryColor)}`}>
              {categoryName}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('cyclesTab.category.none', { defaultValue: '—' })}</span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        <SelectItem value={NONE}>{t('cyclesTab.category.noneLong', { defaultValue: 'Geen categorie' })}</SelectItem>
        {categories.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span className="inline-flex items-center gap-2">
              <span className={`inline-block h-2.5 w-2.5 rounded-full border ${getTagColorClass(c.color)}`} />
              {c.name}
            </span>
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={MANAGE}>{t('cyclesTab.category.manage', { defaultValue: 'Categorieën beheren…' })}</SelectItem>
      </SelectContent>
    </Select>
  );
}
