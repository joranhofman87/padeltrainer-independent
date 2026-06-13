import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { ArrowLeft, ChevronDown, Eye, Send } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { getAcademyLocationsWithDetails } from '@/lib/academy';
import type { RebookPaymentMode } from '@/lib/priorityClaims';

interface Props {
  academyProfileId: string;
  backHref: string;
}

interface LocationOption {
  id: string;
  name: string;
  city: string;
}

interface PreviewResult {
  groups: number;
  players: number;
  weeksOffset: number;
  slotsToCopy: number;
}

export default function RebookCohortWizard({ academyProfileId, backHref }: Props) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();

  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<string>>(new Set());
  const [termEndDate, setTermEndDate] = useState('');
  const [newStartDate, setNewStartDate] = useState('');

  const [priorityWindowDays, setPriorityWindowDays] = useState(7);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [requireAdminReview, setRequireAdminReview] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [targetCycleName, setTargetCycleName] = useState(
    t('rebookCohort.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
  );

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getAcademyLocationsWithDetails(academyProfileId)
      .then((rows) => {
        setLocations(
          rows
            .filter((r) => r.location)
            .map((r) => ({ id: r.location.id, name: r.location.name, city: r.location.city || '' })),
        );
      })
      .catch((e) =>
        toast.error(
          getFriendlyErrorMessage(e, t('rebookCohort.errLoadLocations', 'Kon de locaties niet laden. Probeer het opnieuw.')),
        ),
      )
      .finally(() => setLoadingLocations(false));
  }, [academyProfileId, t]);

  const toggleLocation = (id: string) => {
    setSelectedLocationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Any change to the inputs invalidates a previous preview.
    setPreview(null);
  };

  const baseBody = useMemo(
    () => ({
      academyProfileId,
      locationIds: Array.from(selectedLocationIds),
      termEndDate,
      newStartDate,
      priorityWindowDays,
      memberWindowDays: enableMemberWindow ? memberWindowDays : 0,
      paymentMode,
      requireAdminReview,
      targetCycleName: targetCycleName.trim(),
    }),
    [
      academyProfileId,
      selectedLocationIds,
      termEndDate,
      newStartDate,
      priorityWindowDays,
      enableMemberWindow,
      memberWindowDays,
      paymentMode,
      requireAdminReview,
      targetCycleName,
    ],
  );

  const inputsValid = selectedLocationIds.size > 0 && Boolean(termEndDate) && Boolean(newStartDate);

  const handlePreview = async () => {
    if (!inputsValid) {
      toast.error(t('rebookCohort.errFillRequired', 'Kies minstens één locatie en beide datums.'));
      return;
    }
    setPreviewing(true);
    setPreview(null);
    try {
      const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', {
        body: { ...baseBody, dryRun: true },
      });
      if (error) throw error;
      const result: PreviewResult = {
        groups: Number(data?.groups ?? 0),
        players: Number(data?.players ?? 0),
        weeksOffset: Number(data?.weeksOffset ?? 0),
        slotsToCopy: Number(data?.slotsToCopy ?? 0),
      };
      setPreview(result);
      if (result.players === 0) {
        toast.info(t('rebookCohort.previewEmpty', 'Geen spelers gevonden voor deze selectie.'));
      }
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookCohort.errPreview', 'Kon de preview niet ophalen. Probeer het opnieuw.')));
    } finally {
      setPreviewing(false);
    }
  };

  const handleSubmit = async () => {
    if (!inputsValid || !preview || preview.players <= 0 || submitting) return;
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('bulk-rebook-cycle', {
        body: baseBody,
      });
      if (error) throw error;
      toast.success(
        t('rebookCohort.success', '{{groups}} groepen · {{players}} spelers uitgenodigd · {{invites}} e-mails', {
          groups: Number(data?.groups ?? 0),
          players: Number(data?.players ?? 0),
          invites: Number(data?.invitesSent ?? 0),
        }),
      );
      navigate(backHref);
    } catch (e) {
      toast.error(getFriendlyErrorMessage(e, t('rebookCohort.errSubmit', 'Kon de ronde niet aanmaken. Probeer het opnieuw.')));
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingLocations) {
    return (
      <div className="container max-w-3xl mx-auto py-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(backHref)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> {t('common:back', 'Terug')}
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{t('rebookCohort.title', 'Hele groep opnieuw boeken')}</h1>
        <p className="text-muted-foreground">
          {t(
            'rebookCohort.subtitle',
            'Kies de locatie(s) en de week waarin de huidige termijn eindigt. We zoeken de wekelijkse groepen, kopiëren ze naar de nieuwe ronde en nodigen elke speler uit.',
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.locations', 'Welke locatie(s)?')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {locations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('rebookCohort.noLocations', 'Je hebt nog geen locaties. Voeg eerst een locatie toe.')}
            </p>
          ) : (
            locations.map((loc) => (
              <label key={loc.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted cursor-pointer">
                <Checkbox checked={selectedLocationIds.has(loc.id)} onCheckedChange={() => toggleLocation(loc.id)} />
                <div className="text-sm">
                  <div className="font-medium">{loc.name}</div>
                  {loc.city && <div className="text-muted-foreground text-xs">{loc.city}</div>}
                </div>
              </label>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.dates', 'Wanneer?')}</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div>
            <Label className="text-xs">{t('rebookCohort.termEnd', 'Einde huidige termijn')}</Label>
            <Input
              type="date"
              value={termEndDate}
              onChange={(e) => {
                setTermEndDate(e.target.value);
                setPreview(null);
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.termEndHint', 'De week waarin de huidige termijn eindigt.')}
            </p>
          </div>
          <div>
            <Label className="text-xs">{t('rebookCohort.newStart', 'Start nieuwe ronde')}</Label>
            <Input
              type="date"
              value={newStartDate}
              onChange={(e) => {
                setNewStartDate(e.target.value);
                setPreview(null);
              }}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.newStartHint', 'Wanneer de volgende termijn begint.')}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.targetName', 'Naam nieuwe ronde')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            value={targetCycleName}
            onChange={(e) => setTargetCycleName(e.target.value)}
            placeholder={t('rebookCohort.targetNamePlaceholder', 'bv. Najaar 2026')}
          />
        </CardContent>
      </Card>

      <div>
        <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
          <ChevronDown className={`h-4 w-4 mr-1 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
          {t('rebookCohort.advanced', 'Geavanceerde opties')}
        </Button>
      </div>

      {showAdvanced && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('rebookCohort.windows', 'Voorrang en ledenvenster')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="max-w-xs">
                <Label>{t('rebookCohort.priorityDays', 'Hoeveel dagen krijgen spelers voorrang?')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={priorityWindowDays}
                  onChange={(e) => setPriorityWindowDays(Number(e.target.value))}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t('rebookCohort.priorityHint', 'De plek blijft gereserveerd totdat de speler nee zegt of deze periode voorbij is.')}
                </p>
              </div>
              <label className="flex items-center gap-3 cursor-pointer">
                <Checkbox checked={enableMemberWindow} onCheckedChange={(v) => setEnableMemberWindow(Boolean(v))} />
                <span className="text-sm">
                  {t('rebookCohort.enableMemberWindow', 'Geef spelers uit de vorige ronde eerder toegang dan het publiek')}
                </span>
              </label>
              {enableMemberWindow && (
                <div className="max-w-xs">
                  <Label>{t('rebookCohort.memberDays', 'Lengte ledenvenster (dagen)')}</Label>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    value={memberWindowDays}
                    onChange={(e) => setMemberWindowDays(Number(e.target.value))}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('rebookCohort.memberHint', 'Na het voorrangsvenster kunnen alleen spelers uit de vorige ronde nog boeken of wisselen.')}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('rebookCohort.payment', 'Betaling')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label>{t('bulkCopy.paymentModeLabel', 'How do players pay when they keep their spot?')}</Label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  className="mt-1"
                  checked={paymentMode === 'deferred_split'}
                  onChange={() => setPaymentMode('deferred_split')}
                />
                <span>{t('bulkCopy.paymentModeDeferred', 'Invoice at cycle start — the price is split between everyone who joins')}</span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  className="mt-1"
                  checked={paymentMode === 'upfront'}
                  onChange={() => setPaymentMode('upfront')}
                />
                <span>{t('bulkCopy.paymentModeUpfront', 'Pay immediately — the player checks out online when they say yes')}</span>
              </label>
              {paymentMode === 'upfront' && (
                <p className="text-xs text-muted-foreground pl-6">
                  {t('bulkCopy.paymentModeUpfrontHint', 'Requires online payments (Mollie) for the trainer or academy.')}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('rebookCohort.publicRelease', 'Publiek vrijgeven')}</CardTitle>
            </CardHeader>
            <CardContent>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={requireAdminReview} onCheckedChange={(v) => setRequireAdminReview(Boolean(v))} />
                <div>
                  <div className="text-sm font-medium">{t('rebookCohort.requireReview', 'Mijn goedkeuring vereist voordat het publiek wordt')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('rebookCohort.requireReviewHint', 'De plekken blijven verborgen totdat je ze zelf vrijgeeft.')}
                  </div>
                </div>
              </label>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.previewTitle', 'Controleren')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={handlePreview} disabled={previewing || submitting || !inputsValid}>
            <Eye className="h-4 w-4 mr-2" />
            {previewing ? t('common:loading', 'Bezig...') : t('rebookCohort.preview', 'Preview')}
          </Button>
          {preview && (
            <div className="text-sm">
              <p className="font-medium">
                {t('rebookCohort.previewResult', '{{players}} spelers in {{groups}} groepen', {
                  players: preview.players,
                  groups: preview.groups,
                })}
              </p>
              <p className="text-muted-foreground text-xs">
                {t('rebookCohort.previewSlots', '{{count}} trainingen worden gekopieerd', { count: preview.slotsToCopy })}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSubmit} disabled={submitting || previewing || !preview || preview.players <= 0}>
          <Send className="h-4 w-4 mr-2" />
          {submitting ? t('common:saving', 'Bezig...') : t('rebookCohort.confirm', 'Aanmaken & spelers uitnodigen')}
        </Button>
      </div>
    </div>
  );
}
