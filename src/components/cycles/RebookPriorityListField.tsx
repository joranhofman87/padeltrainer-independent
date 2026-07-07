import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { GuestPlayerSlotCombobox, type GuestPlayerSlotComboboxPlayer } from '@/components/players/GuestPlayerSlotCombobox';
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
 * Guests are excluded: they book on a rail we don't grant here. Selected people
 * render as removable chips; the combobox appends one at a time.
 */
export function RebookPriorityListField({ academyProfileId, value, onChange, message, onMessageChange, disabled }: Props) {
  const { t } = useTranslation('cycles');

  const { data: players = [] } = useQuery({
    queryKey: ['rebook-priority-registered-players', academyProfileId],
    queryFn: async (): Promise<GuestPlayerSlotComboboxPlayer[]> => {
      const rows = await fetchAllPlayersOverview({ kind: 'academy', id: academyProfileId });
      return rows
        .filter((r) => r.player_type === 'registered' && !!r.profile_id)
        .map((r) => ({
          id: r.profile_id as string,
          trainer_id: null,
          academy_profile_id: academyProfileId,
          first_name: null,
          last_name: null,
          full_name: r.full_name,
          email: r.email ?? '',
          phone: r.phone ?? '',
          skill_rating: r.skill_rating ?? null,
          rating_system: r.rating_system ?? 'standard',
          notes: null,
          created_at: '',
          updated_at: '',
          linked_profile_id: r.profile_id ?? null,
        }));
    },
    enabled: !!academyProfileId,
  });

  const selectedIds = useMemo(() => new Set(value.map((p) => p.player_id)), [value]);

  const addPlayer = (playerId: string) => {
    if (!playerId || selectedIds.has(playerId)) return;
    const p = players.find((pl) => pl.id === playerId);
    if (!p) return;
    onChange([...value, { player_id: p.id, full_name: p.full_name, email: p.email || null }]);
  };

  const removePlayer = (playerId: string) => {
    onChange(value.filter((p) => p.player_id !== playerId));
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>{t('newRound.priorityListTitle', 'Voorrangslijst')}</Label>
        <p className="text-sm text-muted-foreground">
          {t('newRound.priorityListHint', 'Kies spelers die als eerste mogen boeken zodra er plekken vrijkomen — naast de spelers die al een sessie hadden.')}
        </p>
      </div>

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

      <GuestPlayerSlotCombobox
        players={players}
        value=""
        onValueChange={addPlayer}
        placeholder={t('newRound.priorityListSearch', 'Zoek een speler')}
        emptyLabel={t('newRound.priorityListEmpty', 'Geen spelers gevonden.')}
        disabledPlayerIds={value.map((p) => p.player_id)}
        showEmail
        disabled={disabled}
        data-testid="rebook-priority-combobox"
      />

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
