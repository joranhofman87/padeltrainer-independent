import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Pencil, User } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import {
  AcademyPlayerKind,
  canEditRegisteredPlayerEmail,
  formFromValues,
  validatePlayerDetailsForm,
} from '@/lib/academyPlayerDetails';
import {
  saveTrainerPlayerDetails,
  type TrainerPlayerDetailsValues,
} from '@/lib/trainerPlayerDetails';

type LocationOption = { id: string; name: string };

type TrainerPlayerDetailsCardProps = {
  kind: AcademyPlayerKind;
  trainerProfileId: string;
  guestPlayerId: string | null;
  profileId: string | null;
  values: TrainerPlayerDetailsValues;
  locations: LocationOption[];
  tagIds?: string[];
  onSaved: (values: TrainerPlayerDetailsValues) => void;
};

const NONE_LOCATION = '__none__';

export function TrainerPlayerDetailsCard({
  kind,
  trainerProfileId,
  guestPlayerId,
  profileId,
  values,
  locations,
  tagIds,
  onSaved,
}: TrainerPlayerDetailsCardProps) {
  const { t } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => formFromValues(values));

  const emailReadOnly = kind === 'registered' && !canEditRegisteredPlayerEmail();
  const allowedLocationIds = useMemo(() => new Set(locations.map((l) => l.id)), [locations]);

  useEffect(() => {
    if (!editing) {
      setForm(formFromValues(values));
    }
  }, [values, editing]);

  const displayPreferredClub = useMemo(() => {
    const loc = locations.find((l) => l.id === values.locationId);
    return loc?.name ?? '—';
  }, [locations, values.locationId]);

  const selectedLocationValue = form.locationId || NONE_LOCATION;

  function handleCancel() {
    setForm(formFromValues(values));
    setEditing(false);
  }

  function handleLocationChange(locationId: string) {
    setForm((prev) => ({
      ...prev,
      locationId: locationId === NONE_LOCATION ? '' : locationId,
    }));
  }

  async function handleSave() {
    const validationError = validatePlayerDetailsForm(form, allowedLocationIds);
    if (validationError === 'nameRequired') {
      toast({
        title: tCommon('error', 'Error'),
        description: t('players.name', 'Name') + ' *',
        variant: 'destructive',
      });
      return;
    }
    if (validationError === 'skillOutOfRange') {
      toast({
        title: tCommon('error', 'Error'),
        description: t('players.import.errors.skillOutOfRange', 'Skill rating must be 1-10'),
        variant: 'destructive',
      });
      return;
    }
    if (validationError === 'invalidLocationId') {
      toast({
        title: tCommon('error', 'Error'),
        description: t('players.detail.invalidPreferredClub', 'Select a valid club from the list.'),
        variant: 'destructive',
      });
      return;
    }

    setSaving(true);
    try {
      await saveTrainerPlayerDetails({
        kind,
        trainerProfileId,
        guestPlayerId,
        profileId,
        form,
        allowedLocationIds,
        tagIds,
      });

      const nextValues: TrainerPlayerDetailsValues = {
        name: form.name.trim(),
        email: emailReadOnly ? values.email : form.email.trim() || null,
        locationId: form.locationId || null,
        skillRating: form.skillRating.trim() ? parseFloat(form.skillRating) : null,
        ratingSystem: form.ratingSystem || 'knltb',
        notes: form.notes.trim() || null,
      };

      onSaved(nextValues);
      setEditing(false);
      toast({
        title: t('players.playerUpdated', 'Player updated'),
        description: t('players.playerUpdatedDescription', 'Player details have been updated'),
      });
    } catch (err: unknown) {
      logger.error(
        'Error saving trainer player details',
        err instanceof Error ? err : new Error(String(err)),
        { component: 'TrainerPlayerDetailsCard' },
      );
      toast({
        title: tCommon('error', 'Error'),
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="trainer-player-details-card">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <User className="h-4 w-4" />
          {t('players.detail.playerDetails', 'Player details')}
        </CardTitle>
        {!editing ? (
          <Button
            variant="outline"
            size="sm"
            data-testid="trainer-player-details-edit"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5 mr-1.5" />
            {t('players.detail.editDetails', 'Edit details')}
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
              {t('players.detail.cancel', 'Cancel')}
            </Button>
            <Button size="sm" data-testid="trainer-player-details-save" onClick={() => void handleSave()} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              {t('players.detail.saveDetails', 'Save details')}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!editing ? (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <DetailField label={t('players.name', 'Name')} value={values.name} />
            <DetailField label={t('players.email', 'Email')} value={values.email || '—'} />
            <DetailField
              label={t('players.detail.preferredClub', 'Preferred club')}
              value={displayPreferredClub}
            />
            <DetailField
              label={t('players.detail.knltbLevel', 'KNLTB level')}
              value={values.skillRating != null ? String(values.skillRating) : '—'}
            />
            <DetailField
              label={t('players.notes', 'Notes')}
              value={values.notes?.trim() || '—'}
              className="sm:col-span-2"
            />
          </dl>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="trainer-player-details-name">{t('players.name', 'Name')} *</Label>
              <Input
                id="trainer-player-details-name"
                data-testid="trainer-player-details-name"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="trainer-player-details-email">{t('players.email', 'Email')}</Label>
              <Input
                id="trainer-player-details-email"
                data-testid="trainer-player-details-email"
                type="email"
                value={emailReadOnly ? values.email ?? '' : form.email}
                readOnly={emailReadOnly}
                disabled={emailReadOnly}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
              />
              {emailReadOnly && (
                <p className="text-xs text-muted-foreground" data-testid="trainer-player-email-readonly-help">
                  {t(
                    'players.detail.claimedEmailReadOnlyHelp',
                    'This player has claimed their account. Their email can only be changed by the player.',
                  )}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('players.detail.preferredClub', 'Preferred club')}</Label>
              <Select value={selectedLocationValue} onValueChange={handleLocationChange}>
                <SelectTrigger data-testid="trainer-player-details-club">
                  <SelectValue placeholder={t('scheduleOverview.selectLocation', 'Select location')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_LOCATION}>—</SelectItem>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id}>
                      {loc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="trainer-player-details-rating">{t('players.detail.knltbLevel', 'KNLTB level')}</Label>
              <Input
                id="trainer-player-details-rating"
                data-testid="trainer-player-details-rating"
                type="number"
                min={1}
                max={10}
                step={0.1}
                value={form.skillRating}
                onChange={(e) => setForm((prev) => ({ ...prev, skillRating: e.target.value }))}
                placeholder={t('players.skillRatingPlaceholder', 'e.g. 4.5')}
              />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="trainer-player-details-notes">{t('players.notes', 'Notes')}</Label>
              <Textarea
                id="trainer-player-details-notes"
                data-testid="trainer-player-details-notes"
                rows={4}
                value={form.notes}
                onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder={t('players.notesPlaceholder', 'Any notes about this player...')}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DetailField({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium whitespace-pre-wrap break-words">{value}</dd>
    </div>
  );
}
