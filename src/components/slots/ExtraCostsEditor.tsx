import { useTranslation } from 'react-i18next';
import { Plus, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** One extra-cost line on a slot's pricing. `type` decides billing: `one_time` = charged once,
 *  `per_session` = charged per session (× session count). Matches the form shape both slot-detail
 *  pages used (`{ description, amount, type }`). */
export interface ExtraCost {
  description: string;
  amount: number;
  type: 'one_time' | 'per_session';
}

interface ExtraCostsEditorProps {
  value: ExtraCost[];
  onChange: (next: ExtraCost[]) => void;
  /** Disable + dim every control (e.g. a cycle slot whose price is managed at the cycle level). */
  disabled?: boolean;
  /**
   * i18n namespace the `calendar.*` labels resolve from — academy passes `'academy'`, trainer
   * `'trainer'`. Both already define extraCosts / description / oneTime / perSession, so each role
   * keeps its own wording (D1: namespace prop, zero-regression).
   */
  namespace?: string;
}

/**
 * Shared, role-neutral editor for a slot's extra costs (Phase 4 F3b).
 *
 * Extracted from the two slot-detail pages, which duplicated it — and DIVERGED: academy showed the
 * one_time/per_session type select, trainer did NOT (so a trainer could never create a per-session
 * cost). This unifies them with the type select for BOTH roles (owner decision D2 = align). New rows
 * still default to `one_time` (today's add-button default for both), so the change is purely additive
 * — trainers simply gain the per-session option they were missing.
 */
export function ExtraCostsEditor({ value, onChange, disabled = false, namespace = 'trainer' }: ExtraCostsEditorProps) {
  const { t } = useTranslation(namespace);
  const { t: tCommon } = useTranslation('common');

  const addRow = () => onChange([...value, { description: '', amount: 0, type: 'one_time' }]);
  const updateRow = (idx: number, patch: Partial<ExtraCost>) =>
    onChange(value.map((ec, i) => (i === idx ? { ...ec, ...patch } : ec)));
  const removeRow = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{t('calendar.extraCosts', 'Extra costs')}</Label>
        {!disabled && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 gap-1 text-xs"
            onClick={addRow}
          >
            <Plus className="h-3 w-3" /> {tCommon('add', 'Add')}
          </Button>
        )}
      </div>
      {value.map((ec, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input
            className={`flex-1 h-8 text-xs ${disabled ? 'opacity-60' : ''}`}
            placeholder={t('calendar.description', 'Description')}
            value={ec.description}
            disabled={disabled}
            onChange={(e) => updateRow(idx, { description: e.target.value })}
          />
          <Input
            className={`w-20 h-8 text-xs ${disabled ? 'opacity-60' : ''}`}
            type="number"
            step="0.01"
            min={0}
            placeholder="€"
            value={ec.amount || ''}
            disabled={disabled}
            onChange={(e) => updateRow(idx, { amount: Number(e.target.value) })}
          />
          <Select
            value={ec.type}
            disabled={disabled}
            onValueChange={(v) => updateRow(idx, { type: v as ExtraCost['type'] })}
          >
            <SelectTrigger className={`w-28 h-8 text-xs ${disabled ? 'opacity-60' : ''}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one_time">{t('calendar.oneTime', 'One-time')}</SelectItem>
              <SelectItem value="per_session">{t('calendar.perSession', 'Per session')}</SelectItem>
            </SelectContent>
          </Select>
          {!disabled && (
            <Button
              type="button"
              size="icon"
              aria-label={tCommon('remove', 'Remove')}
              variant="ghost"
              className="h-8 w-8 shrink-0"
              onClick={() => removeRow(idx)}
            >
              <Minus className="h-3 w-3" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
