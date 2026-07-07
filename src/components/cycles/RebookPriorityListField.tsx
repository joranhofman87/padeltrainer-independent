import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { PlayerMultiSelect, type PlayerMultiSelectOption } from '@/components/players/PlayerMultiSelect';
import { EmailMessageField } from '@/components/email/EmailMessageField';
import { fetchAllPlayersOverview } from '@/lib/playersOverview';

/** A registered player the academy grants priority to (no accountless guests). */
export interface PriorityPerson {
  player_id: string; // profiles.id
  full_name: string;
  email: string | null;
}

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

  const { data: players = [] } = useQuery({
    queryKey: ['rebook-priority-registered-players', academyProfileId],
    queryFn: async (): Promise<PlayerMultiSelectOption[]> => {
      const rows = await fetchAllPlayersOverview({ kind: 'academy', id: academyProfileId });
      return rows
        .filter((r) => r.player_type === 'registered' && !!r.profile_id)
        .map((r) => ({
          id: r.profile_id as string,
          full_name: r.full_name,
          email: r.email ?? null,
        }));
    },
    enabled: !!academyProfileId,
  });

  const selectedIds = useMemo(() => value.map((p) => p.player_id), [value]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const togglePlayer = (playerId: string) => {
    if (selectedSet.has(playerId)) {
      onChange(value.filter((p) => p.player_id !== playerId));
      return;
    }
    const p = players.find((pl) => pl.id === playerId);
    if (!p) return;
    onChange([...value, { player_id: p.id, full_name: p.full_name, email: p.email ?? null }]);
  };

  const removePlayer = (playerId: string) => {
    onChange(value.filter((p) => p.player_id !== playerId));
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
        options={players}
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
            <Badge key={p.player_id} variant="secondary" className="gap-1 pr-1">
              {p.full_name}
              <button
                type="button"
                aria-label={t('newRound.priorityListRemove', 'Verwijderen')}
                className="ml-1 rounded-sm hover:bg-muted-foreground/20"
                onClick={() => removePlayer(p.player_id)}
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
