import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Pencil, User } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { flushOnMobileCardClass } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
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
  type AcademyPlayerDetailsForm,
  type AcademyPlayerDetailsValues,
  type AcademyPlayerKind,
  canEditRegisteredPlayerEmail,
  formFromValues,
  isLinkedGuest,
  validatePlayerDetailsForm,
} from '@/lib/academyPlayerDetails';

/** The values shape is identical across roles (trainer's type is an alias of academy's). */
export type PlayerDetailsValues = AcademyPlayerDetailsValues;

export type LocationOption = { id: string; name: string };

/**
 * Shared, role-neutral player-details card. The trainer and academy variants were 95% byte-identical
 * copies in separate role folders — a divergence the role-isolation ESLint rule can't see (no
 * cross-role import), so an edit to one silently diverged the other. This is the single source; thin
 * role wrappers (TrainerPlayerDetailsCard / AcademyPlayerDetailsCard) inject the role-specific bits:
 *  - `save`: the role's metadata writer (saveTrainerPlayerDetails / saveAcademyPlayerDetails);
 *  - `showPhone`: the academy variant exposes a phone field, the trainer one does not;
 *  - `rolePrefix` / `fieldIdBase`: preserve each variant's existing data-testid + htmlFor ids verbatim.
 */
export type PlayerDetailsCardProps = {
  kind: AcademyPlayerKind;
  guestPlayerId: string | null;
  profileId: string | null;
  values: PlayerDetailsValues;
  locations: LocationOption[];
  tagIds?: string[];
  showPhone?: boolean;
  /** data-testid prefix, e.g. 'trainer' or 'academy'. */
  rolePrefix: string;
  /** htmlFor / id prefix, e.g. 'trainer-player-details' or 'player-details'. */
  fieldIdBase: string;
  save: (args: { form: AcademyPlayerDetailsForm; allowedLocationIds: Set<string> }) => Promise<void>;
  onSaved: (values: PlayerDetailsValues) => void;
};

const NONE_LOCATION = '__none__';

export function PlayerDetailsCard({
  kind,
  guestPlayerId,
  profileId,
  values,
  locations,
  tagIds: _tagIds,
  showPhone = false,
  rolePrefix,
  fieldIdBase,
  save,
  onSaved,
}: PlayerDetailsCardProps) {
  const { t } = useTranslation('trainer');
  const { t: tCommon } = useTranslation('common');
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(() => formFromValues(values));

  // Pass B §4: for a REGISTERED player the academy-scoped overlay fields — notes and preferred
  // club — are unavailable. saveAcademyPlayerDetails/saveTrainerPlayerDetails deliberately do
  // not write them for a registered player (the overlay is caller-authored evidence, withdrawn
  // in H0), so leaving the controls editable meant typing into a box, being told the player was
  // updated, and losing the text on the next refetch. Rendering them read-only is the other half
  // of that fix: nothing reaches the writer that the writer will drop.
  //
  // A LINKED GUEST is not registered here — the writer still writes that guest's own row, so
  // directly owned guest editing is untouched.
  const registeredOverlayReadOnly = kind === 'registered';

  // Linked guests behave like registered players: their profile owns the email.
  const emailReadOnly =
    (kind === 'registered' || isLinkedGuest(kind, guestPlayerId, profileId)) &&
    !canEditRegisteredPlayerEmail();
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
    // Pass B §4: strip the unavailable overlay fields BEFORE validation and before the request is
    // built, not after. Two reasons, both observed:
    //  - the writer validates the preferred club and THROWS on one that is not in this academy's
    //    list. A registered player can carry a stale stored location from before the narrowing,
    //    and that stale value would block an unrelated, permitted edit to their name or level —
    //    a field the operator cannot even see, failing a save they can.
    //  - anything left on the form reaches the payload builder. Excluding it here is the only
    //    place that keeps it out of the request, the cache and the success message at once.
    const outboundForm = registeredOverlayReadOnly
      ? { ...form, locationId: '', notes: '' }
      : form;

    const validationError = validatePlayerDetailsForm(outboundForm, allowedLocationIds);
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
      await save({ form: outboundForm, allowedLocationIds });

      const nextValues: PlayerDetailsValues = {
        name: form.name.trim(),
        email: emailReadOnly ? values.email : form.email.trim() || null,
        phone: form.phone.trim() || null,
        skillRating: form.skillRating.trim() ? parseFloat(form.skillRating) : null,
        ratingSystem: form.ratingSystem || 'knltb',
        // Overlay fields keep their PREVIOUS values for a registered player. Echoing the form
        // back would put an unsaved edit into the card's own state and the query cache — a
        // false success that survives until the next refetch contradicts it.
        locationId: registeredOverlayReadOnly ? values.locationId : (form.locationId || null),
        notes: registeredOverlayReadOnly ? values.notes : (form.notes.trim() || null),
      };

      onSaved(nextValues);
      setEditing(false);
      toast({
        title: t('players.playerUpdated', 'Player updated'),
        description: t('players.playerUpdatedDescription', 'Player details have been updated'),
      });
    } catch (err: unknown) {
      logger.error(
        'Error saving player details',
        err instanceof Error ? err : new Error(String(err)),
        { component: 'PlayerDetailsCard', rolePrefix },
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
    <Card className={flushOnMobileCardClass()} data-testid={`${rolePrefix}-player-details-card`}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <User className="h-4 w-4" />
          {t('players.detail.playerDetails', 'Player details')}
        </CardTitle>
        {!editing ? (
          <Button
            variant="outline"
            size="sm"
            data-testid={`${rolePrefix}-player-details-edit`}
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
            <Button size="sm" data-testid={`${rolePrefix}-player-details-save`} onClick={() => void handleSave()} disabled={saving}>
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
            {showPhone && (
              <DetailField label={t('players.phone', 'Phone')} value={values.phone || '—'} />
            )}
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
              <Label htmlFor={`${fieldIdBase}-name`}>{t('players.name', 'Name')} *</Label>
              <Input
                id={`${fieldIdBase}-name`}
                data-testid={`${rolePrefix}-player-details-name`}
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldIdBase}-email`}>{t('players.email', 'Email')}</Label>
              <Input
                id={`${fieldIdBase}-email`}
                data-testid={`${rolePrefix}-player-details-email`}
                type="email"
                value={emailReadOnly ? values.email ?? '' : form.email}
                readOnly={emailReadOnly}
                disabled={emailReadOnly}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
              />
              {emailReadOnly && (
                <p className="text-xs text-muted-foreground" data-testid={`${rolePrefix}-player-email-readonly-help`}>
                  {t(
                    'players.detail.claimedEmailReadOnlyHelp',
                    'This player has claimed their account. Their email can only be changed by the player.',
                  )}
                </p>
              )}
            </div>
            {showPhone && (
              <div className="space-y-2">
                <Label htmlFor={`${fieldIdBase}-phone`}>{t('players.phone', 'Phone')}</Label>
                <PhoneInput
                  id={`${fieldIdBase}-phone`}
                  data-testid={`${rolePrefix}-player-details-phone`}
                  value={form.phone}
                  onChange={(v) => setForm((prev) => ({ ...prev, phone: v }))}
                  placeholder={t('players.phonePlaceholder', 'e.g. +31 6 12345678')}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label>{t('players.detail.preferredClub', 'Preferred club')}</Label>
              {registeredOverlayReadOnly ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid={`${rolePrefix}-player-details-club-readonly`}
                  data-field-available="false"
                >
                  {displayPreferredClub}
                  <span className="block text-xs">
                    {t(
                      'players.detail.registeredOverlayUnavailable',
                      'Not editable here at the moment.',
                    )}
                  </span>
                </p>
              ) : (
                <Select value={selectedLocationValue} onValueChange={handleLocationChange}>
                  <SelectTrigger data-testid={`${rolePrefix}-player-details-club`}>
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
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${fieldIdBase}-rating`}>{t('players.detail.knltbLevel', 'KNLTB level')}</Label>
              <Input
                id={`${fieldIdBase}-rating`}
                data-testid={`${rolePrefix}-player-details-rating`}
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
              <Label htmlFor={`${fieldIdBase}-notes`}>{t('players.notes', 'Notes')}</Label>
              {registeredOverlayReadOnly ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid={`${rolePrefix}-player-details-notes-readonly`}
                  data-field-available="false"
                >
                  {values.notes?.trim() || '—'}
                  <span className="block text-xs">
                    {t(
                      'players.detail.registeredOverlayUnavailable',
                      'Not editable here at the moment.',
                    )}
                  </span>
                </p>
              ) : (
                <Textarea
                  id={`${fieldIdBase}-notes`}
                  data-testid={`${rolePrefix}-player-details-notes`}
                  rows={4}
                  value={form.notes}
                  onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                  placeholder={t('players.notesPlaceholder', 'Any notes about this player...')}
                />
              )}
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
