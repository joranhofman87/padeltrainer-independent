import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { PlayerMultiSelect, type PlayerMultiSelectOption } from '@/components/players/PlayerMultiSelect';
import { EmailMessageField } from '@/components/email/EmailMessageField';
import { fetchAllPlayersOverview } from '@/lib/playersOverview';
import { toPriorityPerson, type PriorityPerson } from './priorityPerson';

export type { PriorityPerson } from './priorityPerson';

interface Props {
  academyProfileId: string;
  value: PriorityPerson[];
  onChange: (people: PriorityPerson[]) => void;
  message: string;
  onMessageChange: (v: string) => void;
  disabled?: boolean;
}

/**
 * Multi-select of REGISTERED academy players who should be able to book freed
 * seats (and be emailed) when the member window opens — the "priority list".
 * Guests are excluded: they book on a rail we don't grant here. Search + tick
 * several players in one pass (the popover stays open); selected people also
 * render as removable chips.
 */
export function RebookPriorityListField({ academyProfileId, value, onChange, message, onMessageChange, disabled }: Props) {
  const { t } = useTranslation('cycles');

  // The WHOLE academy player list — registered players AND accountless guests.
  const { data: people = [] } = useQuery({
    queryKey: ['rebook-priority-academy-players', academyProfileId],
    queryFn: async (): Promise<PriorityPerson[]> => {
      const rows = await fetchAllPlayersOverview({ kind: 'academy', id: academyProfileId });
      return rows.map(toPriorityPerson).filter((p): p is PriorityPerson => p !== null);
    },
    enabled: !!academyProfileId,
  });

  const options: PlayerMultiSelectOption[] = useMemo(
    () => people.map((p) => ({ id: p.id, full_name: p.full_name, email: p.email })),
    [people],
  );
  const selectedIds = useMemo(() => value.map((p) => p.id), [value]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const togglePlayer = (id: string) => {
    if (selectedSet.has(id)) {
      onChange(value.filter((p) => p.id !== id));
      return;
    }
    const p = people.find((pl) => pl.id === id);
    if (!p) return;
    onChange([...value, p]);
  };

  const removePlayer = (id: string) => {
    onChange(value.filter((p) => p.id !== id));
  };

  const triggerLabel = value.length > 0
    ? t('newRound.priorityListSelected', '{{count}} geselecteerd — zoek en voeg meer toe', { count: value.length })
    : t('newRound.priorityListSelectTrigger', 'Zoek en selecteer spelers');

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>{t('newRound.priorityListTitle', 'Voorrangslijst')}</Label>
        <p className="text-sm text-muted-foreground">
          {t('newRound.priorityListHint', 'Kies spelers die als eerste mogen boeken zodra er plekken vrijkomen — naast de spelers die al een sessie hadden.')}
        </p>
      </div>

      <PlayerMultiSelect
        options={options}
        selectedIds={selectedIds}
        onToggle={togglePlayer}
        triggerLabel={triggerLabel}
        searchPlaceholder={t('newRound.priorityListSearch', 'Zoek een speler')}
        emptyLabel={t('newRound.priorityListEmpty', 'Geen spelers gevonden.')}
        showEmail
        disabled={disabled}
        data-testid="rebook-priority-combobox"
      />

      {value.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="rebook-priority-chips">
          {value.map((p) => (
            <Badge key={p.id} variant="secondary" className="gap-1 pr-1">
              {p.full_name}
              <button
                type="button"
                aria-label={t('newRound.priorityListRemove', 'Verwijderen')}
                className="ml-1 rounded-sm hover:bg-muted-foreground/20"
                onClick={() => removePlayer(p.id)}
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {value.length > 0 && (
        <EmailMessageField
          value={message}
          onChange={onMessageChange}
          disabled={disabled}
          label={t('newRound.priorityListMessageLabel', 'Bericht bij de melding (optioneel)')}
          variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
        />
      )}
    </div>
  );
}
