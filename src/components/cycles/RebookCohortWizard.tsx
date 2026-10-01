import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PRIORITY_PROTOCOL_VERSION, type PriorityRefusalReason } from '@/lib/priorityUnavailable';
import {
  PriorityRefusalAlert,
  PriorityUnavailableExplanation,
  RoundNoWorkNotice,
  RoundNotPermittedNotice,
  RoundSelectionMovedNotice,
  RoundRecoveredNotice,
  RoundUnknownAlert,
} from './PriorityUnavailableNotice';
import { addWeeks, format, parse } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { toast } from 'sonner';
import { ArrowLeft, ChevronRight, Loader2, Send, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { createAndDrainRebookRound, previewRebookRound, type RoundUnknownReason } from '@/lib/rebookInviteSend';
import { newSelectionUuid, type ReviewedSelection } from '@/lib/rebookSelectionDriver';
import { getAcademyLocationsWithDetails } from '@/lib/academy';
import type { RebookPaymentMode } from '@/lib/priorityClaims';
import { HolidayRangeEditor } from './HolidayRangeEditor';
import { RebookAccessWindows } from './RebookAccessWindows';
import { RebookReviewTable, type RebookGroupDetail } from './RebookReviewTable';
import { EmailMessageField } from '@/components/email/EmailMessageField';
import { EmailSubjectField } from '@/components/email/EmailSubjectField';
import { RebookRulesField } from '@/components/cycles/RebookRulesField';
import { RebookClaimInfoField } from '@/components/cycles/RebookClaimInfoField';
import { RebookReminderLeadField } from '@/components/cycles/RebookReminderLeadField';
import { normalizeRichTextHtml } from '@/lib/richText';
import { RebookPaymentModeField } from './RebookPaymentModeField';
import { RebookPublicOpenModeField, type PublicOpenMode } from './RebookPublicOpenModeField';
import {
  getRebookRoundExtendPrefill,
  suggestTermEndFromSources,
  type RebookRoundExtendPrefill,
} from '@/lib/rebookRoundExtend';

interface Props {
  academyProfileId: string;
  backHref: string;
  /** Extend mode: add groups to this EXISTING round (settings.rebook_round_id). The wizard
   *  prefills the round's shape (label pinned, everything else editable) and the server skips
   *  groups already in the round instead of re-inviting them. */
  extendRoundId?: string | null;
}

interface LocationOption {
  id: string;
  name: string;
  city: string;
}

interface PreviewResult {
  groups: number;
  players: number;
  suggestedWeeks: number;
  suggestedPrice: number | null;
  pricesIncludeVat: boolean | null;
  /** Extend mode: groups skipped because they are already part of the round. */
  alreadySentGroups: number;
}

interface HolidayRange {
  name: string;
  from: string;
  to: string;
}

interface ConfirmData {
  /** Identity of the request this review was computed from. Creation re-sends `body` and is blocked
   *  whenever `revision` no longer matches the live inputs — so a round is only ever created from
   *  the exact shape the operator saw. */
  revision: string;
  body: Record<string, unknown>;
  groups: number;
  players: number;
  totalSessions: number;
  effWeeks: number;
  groupsDetail: RebookGroupDetail[];
  noEmailTotal: number;
  /** Invitations this send authorizes: summed per included series, not a deduped headcount. */
  emailInvitationTotal: number;
  /** When the server took the contact snapshot this review shows. Disclosure only, never authority. */
  rosterAsOf: string | null;
  grandInvoiceTotal: number;
  /** The cycles this run will create — one per series (per-series split). >1 ⇒ show the breakdown. */
  targetCycles: Array<{ name: string }>;
}

/** A safe, non-negative integer from an untrusted response field — never `Number(...)`. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
/** An optional numeric field: a real finite number, or null. */
const optionalNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A calendar date field over a yyyy-MM-dd string value (matches the app's other date pickers). */
function DateField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const selected = value ? parse(value, 'yyyy-MM-dd', new Date()) : undefined;
  return (
    <DatePickerPopover
      value={selected}
      onChange={(d) => onChange(d ? format(d, 'yyyy-MM-dd') : '')}
      className="w-full"
    />
  );
}

export default function RebookCohortWizard({ academyProfileId, backHref, extendRoundId }: Props) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();

  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [selectedLocationIds, setSelectedLocationIds] = useState<Set<string>>(new Set());
  const [termEndDate, setTermEndDate] = useState('');
  const [newStartDate, setNewStartDate] = useState('');
  const [newEndDate, setNewEndDate] = useState('');
  const [sessionPrice, setSessionPrice] = useState('');
  const [holidays, setHolidays] = useState<HolidayRange[]>([]);

  const [priorityWindowDays, setPriorityWindowDays] = useState(7);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [strictMollie, setStrictMollie] = useState(false);
  // How non-rebooked sessions become bookable once they OPEN to the public. 'inherit' = copy
  // each source court's flags (legacy default); an explicit mode overrides the whole round.
  const [publicOpenMode, setPublicOpenMode] = useState<PublicOpenMode>('inherit');
  const [publicOpenSplit, setPublicOpenSplit] = useState(false);
  const [requireAdminReview, setRequireAdminReview] = useState(false);
  // Automated reminder to non-responders ~24h before their priority window closes.
  const [autoReminder, setAutoReminder] = useState(true);
  // Hours before each player's deadline the automated reminder fires (stored unit = hours).
  const [reminderLeadHours, setReminderLeadHours] = useState(24);

  const [targetCycleName, setTargetCycleName] = useState(
    t('rebookCohort.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
  );

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Live drain progress (Codex round-10 #4): the client sends invites in chunks after creating the
  // round, so show "X/Y" instead of an indefinite spinner during a potentially long send.
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  const [confirmData, setConfirmData] = useState<ConfirmData | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [ackNoEmail, setAckNoEmail] = useState(false);
  // Pre-fill a warm, personalised default so a new academy starts from something instead of
  // a blank box; fully editable. Leads with "Hoi {first_name}," (substituted per recipient).
  const [invitationMessage, setInvitationMessage] = useState(() => t('rebookShared.defaultInviteMessage'));
  const [invitationSubject, setInvitationSubject] = useState(() => t('rebookShared.defaultInviteSubject'));
  const [reminderMessage, setReminderMessage] = useState(() => t('rebookShared.defaultReminderMessage'));
  const [reminderSubject, setReminderSubject] = useState(() => t('rebookShared.defaultReminderSubject'));
  const [rebookRules, setRebookRules] = useState('');
  // Per-round override of the claim page's standard explanation box ('' = standard copy).
  const [claimInfo, setClaimInfo] = useState('');
  // Trainer/session exclusion: the auto-preview's series (for the trainer checklist) and the
  // excluded series (by sourceSeriesKey). ABC-26: exclusion is exclusion-ONLY — there is no
  // second-bucket subset, no server count for one, and nothing an exclusion grants.
  const [previewGroups, setPreviewGroups] = useState<RebookGroupDetail[]>([]);
  const [excludedSeriesKeys, setExcludedSeriesKeys] = useState<Set<string>>(new Set());
  const [selectionMoved, setSelectionMoved] = useState(false);
  const [notPermitted, setNotPermitted] = useState<
    'session_price' | 'extend_unavailable' | 'not_permitted' | null>(null);

  // ── THE SELECTION SESSION ─────────────────────────────────────────────────────────────────
  //
  // Two facts about this CONVERSATION rather than about what the operator chose, both in refs:
  //
  //   • The round uuid is client-minted and STABLE for the life of the wizard. The derived child
  //     identities are keyed on it, so re-minting on a retry would make the retry a different
  //     round — a transport failure followed by a second click would create a second set of cycles
  //     instead of replaying the first.
  //   • The selection digest arrives WITH a server answer. This wizard derives `bodyRevision` from
  //     `baseBody` and blocks the send whenever it changes, so a digest folded into the body would
  //     invalidate the review it had just produced, on every single answer.
  //
  // The exclusion keys are NOT here: they ARE the operator's choice, they belong in the body, and
  // they are server-issued strings this component only ever echoes.
  const roundIdRef = useRef<string>(newSelectionUuid());
  const selectionDigestRef = useRef<string | null>(null);
  // THE REVIEWED ARTEFACTS — the fingerprint, the minted target identities and the command uuid.
  // The fingerprint binds all three, so the send presents exactly what the review produced.
  const reviewedRef = useRef<ReviewedSelection | null>(null);
  const rpc = useCallback(
    async (fn: string, args: Record<string, unknown>) => {
      const r = await supabase.rpc(fn as never, args as never);
      return { data: r.data as unknown, error: r.error as unknown };
    },
    [],
  );
  const session = () => ({ roundId: roundIdRef.current, selectionDigest: selectionDigestRef.current });

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

  // Extend mode: prefill the wizard from the round being extended. Everything stays editable
  // except the name (the server pins the round label so the new cycles join the round).
  const [extendPrefill, setExtendPrefill] = useState<RebookRoundExtendPrefill | null>(null);
  const [loadingExtend, setLoadingExtend] = useState(Boolean(extendRoundId));
  useEffect(() => {
    if (!extendRoundId) return;
    let cancelled = false;
    (async () => {
      try {
        const prefill = await getRebookRoundExtendPrefill(academyProfileId, extendRoundId);
        if (cancelled) return;
        if (!prefill) {
          toast.error(t('rebookCohort.extendNotFound', 'Deze ronde is niet gevonden.'));
          navigate(backHref);
          return;
        }
        setExtendPrefill(prefill);
        setTargetCycleName(prefill.label);
        setSelectedLocationIds(new Set(prefill.locationIds));
        if (prefill.startDate) setNewStartDate(prefill.startDate);
        if (prefill.endDate) setNewEndDate(prefill.endDate);
        // REVIEW ROUND 5 (P3): THIS IS THE ONE SURVIVING PRICE PREFILL, and it is deliberate —
        // for an EXTEND it restores the round's OWN stored price, not a source-cycle
        // recommendation. It is unreachable today because extend is refused before any of this can
        // be sent. If the pending extend decision ever opens that path, a non-null stored price
        // will make every extend apply-ineligible exactly as the source-cycle prefill did, and
        // this line has to go with it.
        setSessionPrice(prefill.sessionPrice);
        setHolidays(prefill.holidays);
        setPaymentMode(prefill.paymentMode);
        setStrictMollie(prefill.strictMollie);
        setAutoReminder(prefill.autoReminder);
        if (prefill.reminderLeadHours != null) setReminderLeadHours(prefill.reminderLeadHours);
        if (prefill.invitationMessage) setInvitationMessage(prefill.invitationMessage);
        if (prefill.invitationSubject) setInvitationSubject(prefill.invitationSubject);
        if (prefill.reminderMessage) setReminderMessage(prefill.reminderMessage);
        if (prefill.reminderSubject) setReminderSubject(prefill.reminderSubject);
        if (prefill.rebookRules) setRebookRules(prefill.rebookRules);
        if (prefill.claimInfo) setClaimInfo(prefill.claimInfo);
        // Suggest the term end from the round's source cycles (their last session) so the owner
        // usually doesn't have to re-enter it; still adjustable.
        const termEnd = await suggestTermEndFromSources(prefill.sourceCyclusIds);
        if (!cancelled && termEnd) setTermEndDate(termEnd);
      } catch (e) {
        if (!cancelled) {
          toast.error(getFriendlyErrorMessage(e, t('rebookCohort.errExtendLoad', 'Kon de ronde niet laden. Probeer het opnieuw.')));
          navigate(backHref);
        }
      } finally {
        if (!cancelled) setLoadingExtend(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academyProfileId, extendRoundId]);

  // In extend mode "back" lands on the round's manage page (where the flow started).
  const effectiveBackHref = extendPrefill ? `/app/academy/cycles/${extendPrefill.anyCycleId}/rebook` : backHref;

  const toggleLocation = (id: string) => {
    setSelectedLocationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const baseBody = useMemo(
    () => ({
      // Pass B §4: declares that this client can READ the priority accounting; the Edge function
      // refuses a submission it could not report on.
      priorityContractVersion: PRIORITY_PROTOCOL_VERSION,
      academyProfileId,
      extendRoundId: extendRoundId || null,
      locationIds: Array.from(selectedLocationIds),
      termEndDate,
      newStartDate,
      priorityWindowDays,
      memberWindowDays: enableMemberWindow ? memberWindowDays : 0,
      paymentMode,
      strictMollie: paymentMode === 'upfront' && strictMollie,
      // 'inherit' → null so the engine keeps its per-court source copy (unchanged path).
      publicOpenMode: publicOpenMode === 'inherit' ? null : publicOpenMode,
      publicOpenSplit,
      requireAdminReview,
      targetCycleName: targetCycleName.trim(),
      // Date model: the round runs from newStartDate to newEndDate; the session count is derived
      // from that range minus the holiday days. Blank end date → previous term's length (fallback).
      newEndDate: newEndDate || null,
      sessionPrice: sessionPrice === '' ? null : Number(sessionPrice),
      holidays: holidays.filter((h) => h.from && h.to),
      invitationMessage: invitationMessage.trim() || null,
      invitationSubject: invitationSubject.trim() || null,
      reminderMessage: reminderMessage.trim() || null,
      reminderSubject: reminderSubject.trim() || null,
      reminderLeadHours,
      rebookRules: normalizeRichTextHtml(rebookRules),
      claimInfo: normalizeRichTextHtml(claimInfo),
      excludedSeriesKeys: [...excludedSeriesKeys],
      // ABC-26: canonical empty arrays, sent explicitly rather than omitted so old and new clients
      // land on ONE server parse path. There is no state behind them — the second-bucket model is
      // gone, so the exclusion above still works and simply grants nobody a member window.
      secondBucketSeriesKeys: [],
      priorityPeople: [],
      priorityGuests: [],
      memberOpenMessage: null,
      autoReminder,
    }),
    [
      academyProfileId,
      extendRoundId,
      selectedLocationIds,
      termEndDate,
      newStartDate,
      priorityWindowDays,
      enableMemberWindow,
      memberWindowDays,
      paymentMode,
      strictMollie,
      publicOpenMode,
      publicOpenSplit,
      requireAdminReview,
      autoReminder,
      reminderLeadHours,
      targetCycleName,
      newEndDate,
      sessionPrice,
      holidays,
      invitationMessage,
      invitationSubject,
      reminderMessage,
      reminderSubject,
      rebookRules,
      claimInfo,
      excludedSeriesKeys,
    ],
  );

  const inputsValid = selectedLocationIds.size > 0 && Boolean(termEndDate) && Boolean(newStartDate);

  // Auto-count the cohort the moment location + both dates are set, shown up top —
  // no manual "preview" click. The headcount/groups depend only on the cohort inputs
  // (location + dates), so re-run only when those change (not on weeks/price typing).
  const locKey = useMemo(() => [...selectedLocationIds].sort().join(','), [selectedLocationIds]);
  useEffect(() => {
    if (!(selectedLocationIds.size > 0 && termEndDate && newStartDate)) { setPreview(null); setPreviewGroups([]); return; }
    setPreviewing(true);
    // The cohort changed → any trainer/session exclusions were keyed on the old series, and so was
    // the digest they were issued with.
    //
    // REVIEW ROUND 1 (P2): THE DIGEST GOES WITH THEM. Echoing the previous selection's digest at a
    // brand-new selection is a guaranteed `selection_moved` — the server is right, but the operator
    // has changed nothing that needs recovering, and the wizard spent a round trip and a notice
    // telling them so. A first call at a new selection asks WITHOUT one, which is what the digest
    // being optional on preview is for.
    setExcludedSeriesKeys(new Set());
    selectionDigestRef.current = null;
    reviewedRef.current = null;
    const gen = ++previewGenRef.current;
    const handle = setTimeout(async () => {
      previewAbortRef.current?.abort();
      const ac = new AbortController();
      previewAbortRef.current = ac;
      try {
        // `counts`, NOT `review`. This fires on locations and dates alone — no label, no length,
        // no price — which the typed core refuses three separate ways. The counting projection is
        // advisory by construction: it carries no fingerprint, so it cannot arm a send.
        const result = await previewRebookRound(
          // The label rides along so the count's own projection names groups the way the review
          // will. It is NOT part of the selection digest — see `d7_p_selection_digest`.
          { academyProfileId, extendRoundId: extendRoundId || null, locationIds: [...selectedLocationIds],
            termEndDate, newStartDate, paymentMode, requireAdminReview,
            targetCycleName: targetCycleName.trim() },
          { rpc, newUuid: newSelectionUuid, signal: ac.signal },
          session(),
          'counts',
        );
        // Superseded by a newer cohort selection: drop it entirely. It must not repaint the count,
        // and it must not clear a newer request's result either.
        if (gen !== previewGenRef.current || result.phase === 'aborted') return;

        if (result.phase === 'priority_refused') {
          setPriorityRefusal({ reason: result.reason, submitted: result.totalSubmitted });
          setPreview(null); setPreviewGroups([]);
          return;
        }
        if (result.phase === 'not_permitted') {
        // A REAL REVIEW, AND NO SEND.
        //
        // REVIEW ROUND 2 (P2): THE REVIEW STAYS ON SCREEN. What is withheld is the SEND
        // AUTHORITY — `reviewedRef` — not the information. Clearing the review as well made
        // the stated mitigation false: the operator was told the round cannot be sent and
        // simultaneously shown nothing about it.
        setNotPermitted(result.reason);
        reviewedRef.current = null;
        // The AUTO-COUNT has no review to keep: it is the advisory projection, it produces no
        // fingerprint, and there is nothing on screen for the operator to inspect yet.
        return;
      }
      if (result.phase === 'selection_moved') {
          // A cohort count cannot be stale against its own digest — but if the server says the
          // selection moved, the count on screen describes something that no longer exists and is
          // cleared rather than left to look current.
          setSelectionMoved(true);
          selectionDigestRef.current = null;
          setPreview(null); setPreviewGroups([]);
          return;
        }
        if (result.phase === 'unknown' || result.phase === 'creation_failed') {
          // A failed count leaves us with NO authority over the cohort. Clearing it (rather than
          // leaving the last good number on screen behind a toast that fades) is what stops the
          // operator continuing against a figure the server never confirmed.
          if (result.phase === 'unknown') setUnknownOutcome({ reason: result.reason, targetCycleId: null });
          else setNoWork(true);
          setPreview(null); setPreviewGroups([]);
          return;
        }
        const data = result.body;
        clearOutcomes();
        selectionDigestRef.current = result.selectionDigest;
        const previewResult: PreviewResult = {
          groups: count(data.groups),
          players: count(data.players),
          suggestedWeeks: count(data.suggestedWeeks),
          suggestedPrice: optionalNumber(data.suggestedPrice),
          pricesIncludeVat: typeof data.pricesIncludeVat === 'boolean' ? data.pricesIncludeVat : null,
          alreadySentGroups: count(data.alreadySentGroups),
        };
        setPreview(previewResult);
        setPreviewGroups(Array.isArray(data.groupsDetail) ? (data.groupsDetail as RebookGroupDetail[]) : []);
        // Pre-fill the end date + price from the previous term when the user hasn't set them. The last
        // session lands (weeks-1) weeks after the start → that's the suggested end date (adjustable).
        setNewEndDate((e2) => {
          if (e2 || !newStartDate || previewResult.suggestedWeeks <= 0) return e2;
          return format(addWeeks(parse(newStartDate, 'yyyy-MM-dd', new Date()), previewResult.suggestedWeeks - 1), 'yyyy-MM-dd');
        });
      // REVIEW ROUND 4 (P1): THE PRICE IS NO LONGER PREFILLED, and this is the difference
      // between a blocked flow and an UNSENDABLE one. ABC-27 marks any non-null session
      // price apply-ineligible, so auto-filling it from the source term meant an eligible
      // review immediately made itself un-appliable — and re-reviewing simply refilled it.
      // The suggestion is still SHOWN beside the field; typing one is the operator's
      // choice, and they are told plainly why it withholds the send.
      // (was: setSessionPrice(<the source term's modal price>))
      } finally {
        if (gen === previewGenRef.current) setPreviewing(false);
      }
    }, 600);
    // Cancel the debounce AND abort an in-flight count. The generation guard already makes a late
    // response inert; aborting stops it costing anything and closes the unmount case.
    return () => { clearTimeout(handle); previewAbortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academyProfileId, extendRoundId, locKey, termEndDate, newStartDate, paymentMode, requireAdminReview]);

  // Trainer checklist (built from the auto-preview's series) + exclusion handlers.
  const previewTrainers = useMemo(() => {
    const m = new Map<string, { name: string; keys: string[] }>();
    for (const g of previewGroups) {
      if (!g.sourceSeriesKey) continue;
      const tid = g.trainerId ?? '_';
      const cur = m.get(tid) ?? { name: g.trainerName || t('rebookCohort.unknownTrainer', 'Onbekende trainer'), keys: [] as string[] };
      cur.keys.push(g.sourceSeriesKey);
      m.set(tid, cur);
    }
    return [...m.entries()].map(([id, v]) => ({ id, name: v.name, keys: v.keys }));
  }, [previewGroups, t]);

  const trainerIncluded = (keys: string[]) => keys.some((k) => !excludedSeriesKeys.has(k));

  // Excluding a series (via trainer or session) removes it from the round. That is ALL it does —
  // ABC-26 removed the paired "…and let their players book a freed seat" decision, so there is no
  // second set to keep in step and no per-removal toggle to flip.
  const toggleTrainer = (keys: string[], include: boolean) => {
    setExcludedSeriesKeys((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => (include ? next.delete(k) : next.add(k)));
      return next;
    });
  };
  const toggleExcludedKey = (key: string) => {
    setExcludedSeriesKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Re-run the review dryRun (debounced) as exclusions change while the review is open,
  // so the distinct-player headline + totals stay server-accurate.
  // ── ABC-26: terminal outcomes ────────────────────────────────────────────────────────────
  //
  // All PERSISTENT, never toasts: each one must stay readable while the operator decides what to do
  // about it, and each one blocks sending. Keyed on a structured reason, never a display string.
  const [priorityRefusal, setPriorityRefusal] = useState<{ reason: PriorityRefusalReason; submitted: number } | null>(null);
  const [recovered, setRecovered] = useState<
    { roundId: string; targetCycleId: string; via: 'replay' | 'ledger' } | null>(null);
  const [unknownOutcome, setUnknownOutcome] = useState<
    { reason: RoundUnknownReason; targetCycleId: string | null; commandId?: string;
      recovery?: 'not_visible' | 'unreadable' } | null>(null);
  const [noWork, setNoWork] = useState(false);
  const clearOutcomes = useCallback(() => {
    setPriorityRefusal(null); setUnknownOutcome(null); setRecovered(null); setNoWork(false); setSelectionMoved(false); setNotPermitted(null);
  }, []);

  // The EXACT identity of the request. Any change to any field that reaches the server invalidates
  // an open review instead of silently riding along into creation.
  const bodyRevision = useMemo(() => JSON.stringify(baseBody), [baseBody]);
  const baseBodyRef = useRef(baseBody);
  const bodyRevisionRef = useRef(bodyRevision);
  useEffect(() => { baseBodyRef.current = baseBody; bodyRevisionRef.current = bodyRevision; }, [baseBody, bodyRevision]);

  // Two INDEPENDENT ordering guards — the cohort count and the review are separate conversations
  // with the server and can be in flight at the same time. Each keeps its own generation counter
  // and AbortController: a superseded response is dropped even if it lands last, and the request is
  // aborted so it usually never lands at all.
  const previewGenRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const reviewGenRef = useRef(0);
  const reviewAbortRef = useRef<AbortController | null>(null);
  const [reviewPending, setReviewPending] = useState(false);

  /**
   * Recompute the open review. Called on a debounce whenever the exclusions change.
   *
   * The old version swallowed every failure and deliberately kept the previous review on screen.
   * That is precisely the stale-authority bug: the numbers described a request the server had since
   * rejected, and the send button stayed live against them. Failure now CLEARS the review.
   */
  const refreshReview = useCallback(async () => {
    const gen = ++reviewGenRef.current;
    reviewAbortRef.current?.abort();
    const ac = new AbortController();
    reviewAbortRef.current = ac;
    const snapshot = baseBodyRef.current;
    const revision = bodyRevisionRef.current;
    setReviewPending(true);
    try {
      // `review`: this is the screen the operator approves, so it must carry the fingerprint.
      const result = await previewRebookRound(
        snapshot, { rpc, newUuid: newSelectionUuid, signal: ac.signal }, session(), 'review');
      // Out of order / superseded: contributes nothing and overwrites nothing.
      if (gen !== reviewGenRef.current || result.phase === 'aborted') return;

      if (result.phase === 'priority_refused') {
        setPriorityRefusal({ reason: result.reason, submitted: result.totalSubmitted });
        setConfirmData(null);
        return;
      }
      if (result.phase === 'unknown') {
        setUnknownOutcome({ reason: result.reason, targetCycleId: null });
        setConfirmData(null);
        return;
      }
      if (result.phase === 'creation_failed') {
        setNoWork(true);
        setConfirmData(null);
        return;
      }
      if (result.phase === 'not_permitted') {
        // A REAL REVIEW, AND NO SEND.
        //
        // REVIEW ROUND 2 (P2): THE REVIEW STAYS ON SCREEN. What is withheld is the SEND
        // AUTHORITY — `reviewedRef` — not the information. Clearing the review as well made
        // the stated mitigation false: the operator was told the round cannot be sent and
        // simultaneously shown nothing about it.
        setNotPermitted(result.reason);
        reviewedRef.current = null;
        // REVIEW ROUND 3 (P2): THE REVIEW STAYS HERE TOO. This fix landed in the other wizard only,
        // so the cohort operator — who reaches `refused_session_price` on the ORDINARY path, since
        // the count prefills the source price — was told the round could not be sent and shown
        // nothing about it.
        if (result.body) {
          const d = result.body;
          selectionDigestRef.current = result.selectionDigest ?? null;
          setAckNoEmail(false);
          setConfirmData({
            revision,
            body: snapshot,
            targetCycles: Array.isArray(d.targetCycles) ? (d.targetCycles as Array<{ name: string }>) : [],
            groups: count(d.groups),
            players: count(d.players),
            totalSessions: count(d.totalSessions),
            effWeeks: count(d.effWeeks),
            groupsDetail: Array.isArray(d.groupsDetail) ? (d.groupsDetail as RebookGroupDetail[]) : [],
            noEmailTotal: count(d.noEmailTotal),
            emailInvitationTotal: count(d.emailInvitationTotal),
            rosterAsOf: typeof d.rosterAsOf === 'string' ? d.rosterAsOf : null,
            grandInvoiceTotal: optionalNumber(d.grandInvoiceTotal) ?? 0,
          });
        }
        return;
      }
      if (result.phase === 'selection_moved') {
        // The review described a selection the server no longer derives. It is DROPPED, not
        // refreshed in place: `sendBlocked` is driven by the review, so leaving a stale one on
        // screen would leave the send armed against numbers nothing will honour.
        setSelectionMoved(true);
        selectionDigestRef.current = null;
        reviewedRef.current = null;
        setConfirmData(null);
        return;
      }
      selectionDigestRef.current = result.selectionDigest;
      reviewedRef.current = result.reviewed;
      const data = result.body;
      clearOutcomes();
      setConfirmData((prev) => (prev ? {
        revision,
        body: snapshot,
        targetCycles: Array.isArray(data.targetCycles) ? (data.targetCycles as Array<{ name: string }>) : prev.targetCycles,
        groups: count(data.groups),
        players: count(data.players),
        totalSessions: count(data.totalSessions),
        effWeeks: count(data.effWeeks),
        groupsDetail: Array.isArray(data.groupsDetail) ? (data.groupsDetail as RebookGroupDetail[]) : prev.groupsDetail,
        noEmailTotal: count(data.noEmailTotal),
        emailInvitationTotal: count(data.emailInvitationTotal),
        rosterAsOf: typeof data.rosterAsOf === 'string' ? data.rosterAsOf : null,
        // REVIEW ROUND 1 (P2): NOT `count`. That helper takes SAFE INTEGERS only, so a
        // legitimate total of 59.85 rendered as 0 — a review screen quietly showing the
        // operator a price of nothing. Money is not an integer here.
        grandInvoiceTotal: optionalNumber(data.grandInvoiceTotal) ?? 0,
      } : prev));
    } catch {
      // Client-side fault: the review becomes UNVERIFIED, never silently stale.
      if (gen === reviewGenRef.current) {
        setUnknownOutcome({ reason: 'unreadable_response', targetCycleId: null });
        setConfirmData(null);
      }
    } finally {
      if (gen === reviewGenRef.current) setReviewPending(false);
    }
  }, [clearOutcomes, rpc]);
  const exclusionSig = useMemo(
    () => [...excludedSeriesKeys].sort().join(','),
    [excludedSeriesKeys],
  );
  const reviewOpenRef = useRef(false);
  useEffect(() => { reviewOpenRef.current = confirmData !== null; }, [confirmData]);

  // ── The two blocking predicates ─────────────────────────────────────────────────────────────
  //
  // Checked BOTH on the button (`disabled`) and inside the handler it calls. A disabled button is a
  // hint, not a guarantee: the handler is still reachable by a click racing a re-render, by a
  // keyboard activation, and by a test — and it is the handler that talks to the server.
  const anyTerminalOutcome = priorityRefusal !== null || unknownOutcome !== null || noWork
    || selectionMoved || notPermitted !== null;
  // PENDING only. Opening the review is how an operator RECOVERS from a terminal outcome — it
  // clears the notices and asks the server again — so blocking it on a standing outcome would make
  // the notice permanent and the page unusable. Creation is what must never run under one.
  const previewBlocked = submitting || previewing || preparing;
  const reviewIsStale = confirmData === null || confirmData.revision !== bodyRevision;
  const sendBlocked = submitting || preparing || reviewPending || reviewIsStale || anyTerminalOutcome;
  useEffect(() => {
    if (!reviewOpenRef.current) return;
    const h = setTimeout(() => { refreshReview(); }, 500);
    return () => clearTimeout(h);
  }, [exclusionSig, refreshReview]);

  // Build the review summary (what will be created + emailed) BEFORE sending — a fresh
  // dryRun that reflects the chosen weeks + holidays. Opens the full-page review.
  const prepareConfirm = async () => {
    if (!inputsValid || !preview || preview.players <= 0 || previewBlocked) return;
    // Shares the review generation/abort guards with refreshReview: opening the review supersedes
    // any refresh still in flight, and vice versa.
    const gen = ++reviewGenRef.current;
    reviewAbortRef.current?.abort();
    const ac = new AbortController();
    reviewAbortRef.current = ac;
    const snapshot = baseBody;
    const revision = bodyRevision;
    setPreparing(true);
    clearOutcomes();
    try {
      // `review`: this is the screen the operator approves, so it must carry the fingerprint.
      const result = await previewRebookRound(
        snapshot, { rpc, newUuid: newSelectionUuid, signal: ac.signal }, session(), 'review');
      if (gen !== reviewGenRef.current || result.phase === 'aborted') return;

      if (result.phase === 'priority_refused') {
        setPriorityRefusal({ reason: result.reason, submitted: result.totalSubmitted });
        setConfirmData(null);
        return;
      }
      if (result.phase === 'unknown') {
        setUnknownOutcome({ reason: result.reason, targetCycleId: null });
        setConfirmData(null);
        return;
      }
      if (result.phase === 'creation_failed') {
        setNoWork(true);
        setConfirmData(null);
        return;
      }
      if (result.phase === 'not_permitted') {
        // A REAL REVIEW, AND NO SEND.
        //
        // REVIEW ROUND 2 (P2): THE REVIEW STAYS ON SCREEN. What is withheld is the SEND
        // AUTHORITY — `reviewedRef` — not the information. Clearing the review as well made
        // the stated mitigation false: the operator was told the round cannot be sent and
        // simultaneously shown nothing about it.
        setNotPermitted(result.reason);
        reviewedRef.current = null;
        // REVIEW ROUND 3 (P2): THE REVIEW STAYS HERE TOO. This fix landed in the other wizard only,
        // so the cohort operator — who reaches `refused_session_price` on the ORDINARY path, since
        // the count prefills the source price — was told the round could not be sent and shown
        // nothing about it.
        if (result.body) {
          const d = result.body;
          selectionDigestRef.current = result.selectionDigest ?? null;
          setAckNoEmail(false);
          setConfirmData({
            revision,
            body: snapshot,
            targetCycles: Array.isArray(d.targetCycles) ? (d.targetCycles as Array<{ name: string }>) : [],
            groups: count(d.groups),
            players: count(d.players),
            totalSessions: count(d.totalSessions),
            effWeeks: count(d.effWeeks),
            groupsDetail: Array.isArray(d.groupsDetail) ? (d.groupsDetail as RebookGroupDetail[]) : [],
            noEmailTotal: count(d.noEmailTotal),
            emailInvitationTotal: count(d.emailInvitationTotal),
            rosterAsOf: typeof d.rosterAsOf === 'string' ? d.rosterAsOf : null,
            grandInvoiceTotal: optionalNumber(d.grandInvoiceTotal) ?? 0,
          });
        }
        return;
      }
      if (result.phase === 'selection_moved') {
        setSelectionMoved(true);
        selectionDigestRef.current = null;
        reviewedRef.current = null;
        setConfirmData(null);
        return;
      }
      selectionDigestRef.current = result.selectionDigest;
      reviewedRef.current = result.reviewed;
      const data = result.body;
      setAckNoEmail(false);
      setConfirmData({
        revision,
        body: snapshot,
        groups: count(data.groups),
        players: count(data.players),
        totalSessions: count(data.totalSessions),
        effWeeks: count(data.effWeeks),
        groupsDetail: Array.isArray(data.groupsDetail) ? (data.groupsDetail as RebookGroupDetail[]) : [],
        noEmailTotal: count(data.noEmailTotal),
        emailInvitationTotal: count(data.emailInvitationTotal),
        rosterAsOf: typeof data.rosterAsOf === 'string' ? data.rosterAsOf : null,
        // REVIEW ROUND 1 (P2): NOT `count`. That helper takes SAFE INTEGERS only, so a
        // legitimate total of 59.85 rendered as 0 — a review screen quietly showing the
        // operator a price of nothing. Money is not an integer here.
        grandInvoiceTotal: optionalNumber(data.grandInvoiceTotal) ?? 0,
        targetCycles: Array.isArray(data.targetCycles) ? (data.targetCycles as Array<{ name: string }>) : [],
      });
      window.scrollTo({ top: 0 });
    } catch {
      if (gen === reviewGenRef.current) {
        setUnknownOutcome({ reason: 'unreadable_response', targetCycleId: null });
        setConfirmData(null);
      }
    } finally {
      if (gen === reviewGenRef.current) setPreparing(false);
    }
  };

  const handleSubmit = async () => {
    // `confirmData` is both the guard and the payload: creation can only use the exact snapshot
    // that was reviewed, and only while that snapshot still matches the live inputs.
    if (!inputsValid || sendBlocked || !confirmData) return;
    setSubmitting(true);
    clearOutcomes();
    // What the operator agreed to send, in the same unit the server reports back: one recipient
    // per (series, player) with an address.
    const approvedInvitations = confirmData.emailInvitationTotal;
    try {
      // Create the round WITHOUT sending, then drain invites in bounded, resumable chunks — the SAME
      // shared orchestration AcademyNewRoundWizard uses (Codex round-9 #1): never an inline blast that
      // a timeout could leave half-sent on a committed round.
      // NO REVIEW ARTEFACTS, NO SEND. The fingerprint is the only thing the apply accepts.
      const reviewed = reviewedRef.current;
      if (!reviewed) {
        setUnknownOutcome({ reason: 'unverified_creation', targetCycleId: null });
        return;
      }
      const result = await createAndDrainRebookRound(
        confirmData.body,
        {
          rpc,
          onProgress: ({ totalSent, total }) => setSendProgress({ sent: totalSent, total }),
        },
        // THE SAME ROUND UUID the wizard has held since it mounted…
        session(),
        // …and the EXACT review the operator approved, so a retry replays the command instead of
        // creating a second round.
        reviewed,
      );
      if (result.phase === 'priority_refused') {
        // Nothing was created and nothing was sent. Persistent, focused, no navigation.
        setPriorityRefusal({ reason: result.reason, submitted: result.totalSubmitted });
        return;
      }
      if (result.phase === 'unknown') {
        // The round MAY exist. Zero invites were drained by construction. Never a success toast and
        // never a navigation — landing on a round page would assert that the round exists.
        // REVIEW ROUND 2 (P2): THE COMMAND UUID TRAVELS WITH IT. Re-presenting it replays the
        // stored receipt instead of creating a second round, so it is the one handle that can
        // resolve an ambiguous apply — and it stopped at the helper boundary before.
        setUnknownOutcome({
          reason: result.reason,
          targetCycleId: result.targetCycleId,
          commandId: result.commandId,
          // D7 TERMINAL CLOSURE: the orchestration ASKED the command ledger before giving up, and
          // what it learned changes what the operator should do next. `absent` means start again
          // safely; `unreadable` means look before creating anything.
          recovery: result.recovery,
        });
        return;
      }
      if (result.phase === 'selection_moved') {
        // Nothing was created and nothing was sent. The review goes with the digest, so the send
        // stays blocked until the operator has seen the current selection.
        setSelectionMoved(true);
        selectionDigestRef.current = null;
        reviewedRef.current = null;
        setConfirmData(null);
        return;
      }
      if (result.phase === 'creation_failed') {
        // Round NOT created (Codex round-9 #2) — show the reason, do NOT navigate.
        if (result.reason === 'already_exists') toast.error(t('rebookCohort.alreadyExists', 'Er bestaat al een ronde met deze naam en startdatum. Geef de nieuwe ronde een andere naam of datum.'));
        else if (result.reason === 'slot_overlap') toast.error(t('newRound.slotOverlap', 'De nieuwe periode botst met bestaande sessies van deze trainer. Kies een andere startdatum of tijd.'));
        else if (result.reason === 'nothing_to_rebook') toast.error(t('rebookCohort.nothingToRebook', 'Er zijn geen spelers om te herboeken.'));
        else toast.error(getFriendlyErrorMessage(new Error(result.reason), t('rebookCohort.errSubmit', 'Kon de ronde niet aanmaken. Probeer het opnieuw.')));
        return;
      }
      // ── THE ROUND EXISTS, AND NOTHING WAS SENT BY THIS ATTEMPT ─────────────────────────────
      //
      // `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1`. Either the server replayed an earlier command
      // or we recovered its receipt from the ledger — both mean an earlier attempt may already have
      // mailed some of these players, and nothing durable records whether it did. So this stops
      // here: a persistent notice, no toast, no navigation, and above all no send. Resuming is an
      // explicit action on the round's own page, where the unresolved counts are visible.
      if (result.phase === 'recovered') {
        setRecovered({ roundId: result.roundId, targetCycleId: result.targetCycleId, via: result.via });
        return;
      }
      // ── OD1/OD2 · THE CONTACT DELTA IS DISCLOSED ON ITS OWN TERMS ────────────────────────
      //
      // REVIEW ROUND 1 (P2): this used to be one arm of the delivery else-if chain, so it was
      // SUPPRESSED whenever delivery was partial or unknown — precisely the situations where an
      // operator most needs to know that the recipient set moved. Approve four, apply reports
      // three, one send fails: they saw only "3 of 4 sent" and never learned that somebody's email
      // address had changed underneath the round. It is a separate fact from how the send went, so
      // it is now a separate notice and both can appear.
      //
      // Null counts mean the server did not state them — a recovered round carries a stored
      // receipt, not a fresh contact read — so there is nothing to compare and nothing is claimed.
      if (approvedInvitations !== null
          && result.contactableCount !== null
          && result.contactableCount !== approvedInvitations) {
        toast.warning(
          t('rebookCohort.contactsMoved', 'De ronde is aangemaakt. Let op: bij het versturen waren {{now}} spelers bereikbaar per e-mail, terwijl je er {{approved}} had goedgekeurd — iemand heeft er tussendoor een e-mailadres toegevoegd of verwijderd. Er zijn {{invites}} e-mails verstuurd.', {
            now: result.contactableCount,
            approved: approvedInvitations,
            invites: result.totalSent,
          }),
        );
      }
      // Round CREATED (navigable). A partial/unknown delivery ⇒ resend from the manage page; never a
      // false "all invited" success. leftover===null means the count is UNKNOWN (a send threw before
      // any count was learned — Codex round-10 #1), so use a no-numbers copy, never a fabricated 0.
      if (result.leftover === null) {
        toast.warning(t('rebookCohort.partialUnknown', 'Ronde aangemaakt, maar het versturen van de uitnodigingen is onderbroken — verstuur ze opnieuw vanaf de beheerpagina.'));
      } else if (result.leftover > 0 || result.outcome === 'error') {
        toast.warning(
          t('rebookCohort.partial', '{{sent}} uitnodigingen verstuurd; {{left}} moeten nog worden verstuurd — via de beheerpagina.', {
            sent: result.totalSent,
            left: result.leftover,
          }),
        );
      } else {
        toast.success(
          t('rebookCohort.success', '{{groups}} groepen · {{players}} spelers uitgenodigd · {{invites}} e-mails', {
            groups: result.groups,
            players: result.players,
            invites: result.totalSent,
          }),
        );
      }
      // Land on the new cycle's rebook management view so the academy can track responses / payments
      // and (on a partial) resend the failed invites via the resume-sending drain. `targetCycleId`
      // is a validated UUID on this arm, so there is no fallback branch to navigate anywhere else.
      navigate(`/app/academy/cycles/${result.targetCycleId}/rebook`);
    } catch (e) {
      // createAndDrainRebookRound does not throw for a server outcome; anything landing here is a
      // genuine client-side fault, and it leaves the world unverified rather than failed.
      setUnknownOutcome({ reason: 'transport_error', targetCycleId: null });
      toast.error(getFriendlyErrorMessage(e, t('rebookCohort.errSubmit', 'Kon de ronde niet aanmaken. Probeer het opnieuw.')));
    } finally {
      setSubmitting(false);
      setSendProgress(null);
    }
  };

  // ABC-26: one notice block, rendered on BOTH the review page and the configure page, so a
  // terminal outcome survives the page switch it usually causes (a refusal clears the review, which
  // returns the operator to configure — where the explanation must already be waiting).
  const outcomeNotices = (
    <>
      <PriorityRefusalAlert
        reason={priorityRefusal?.reason ?? null}
        submitted={priorityRefusal?.submitted ?? 0}
        testId="cohort-priority-refusal"
      />
      <RoundRecoveredNotice
        roundId={recovered?.roundId ?? null}
        targetCycleId={recovered?.targetCycleId ?? null}
        via={recovered?.via ?? null}
        testId="cohort-round-recovered"
      />
      <RoundUnknownAlert
        reason={unknownOutcome?.reason ?? null}
        targetCycleId={unknownOutcome?.targetCycleId ?? null}
        commandId={unknownOutcome?.commandId ?? null}
        recovery={unknownOutcome?.recovery ?? null}
        testId="cohort-round-unknown"
      />
      <RoundNoWorkNotice shown={noWork} testId="cohort-round-no-work" />
      <RoundNotPermittedNotice reason={notPermitted} testId="cohort-round-not-permitted" />
      <RoundSelectionMovedNotice shown={selectionMoved} testId="cohort-round-selection-moved" />
    </>
  );

  if (loadingLocations || loadingExtend) {
    return (
      <div className="container max-w-3xl mx-auto py-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // ===== Review (full page, not a popup — handles a large roster) =====
  if (confirmData) {
    const emailCount = confirmData.emailInvitationTotal;
    // A price is only universal when the operator TYPED one; otherwise each series keeps its own.
    const priceIsUniversal = sessionPrice.trim() !== '';
    return (
      <div className="container max-w-3xl mx-auto px-4 py-6 space-y-4">
        <Button variant="ghost" size="sm" onClick={() => { setConfirmData(null); setAckNoEmail(false); }} disabled={submitting}>
          <ArrowLeft className="h-4 w-4 mr-2" /> {t('rebookCohort.backToEdit', 'Terug naar bewerken')}
        </Button>
        {outcomeNotices}
        <div>
          <h1 className="text-2xl font-bold">{t('rebookCohort.confirmTitle', 'Controleer voordat je verstuurt')}</h1>
          <p className="text-muted-foreground">
            {/* REVIEW ROUND 5 (P2): DO NOT CLAIM ONE PRICE THE ROUND DOES NOT HAVE. A blank price
                field sends `sessionPrice: null`, and the server then gives every series its OWN
                source price; this line substituted the single modal recommendation regardless, so
                a €20/€30 pair of groups read "€20 per sessie" while a child was written at €30.
                The table below always carried the true per-series prices, so the page contradicted
                itself. It is the sendable path that was wrong: a typed price makes the round
                apply-ineligible, so blank is the only case that can reach a send. */}
            {t(priceIsUniversal
                 ? (extendPrefill ? 'rebookCohort.confirmIntroExtend' : 'rebookCohort.confirmIntroRange')
                 : (extendPrefill ? 'rebookCohort.confirmIntroExtendPerGroup' : 'rebookCohort.confirmIntroRangePerGroup'),
              priceIsUniversal
              ? (extendPrefill
                ? 'Je voegt groepen toe aan "{{name}}" van {{start}} t/m {{end}}, € {{price}} per sessie. Dit nodigt de volgende spelers nu per e-mail uit:'
                : 'Je maakt "{{name}}" aan van {{start}} t/m {{end}}, € {{price}} per sessie. Dit nodigt de volgende spelers nu per e-mail uit:')
              : (extendPrefill
                ? 'Je voegt groepen toe aan "{{name}}" van {{start}} t/m {{end}}. Elke groep houdt zijn eigen prijs per sessie — zie de tabel hieronder. Dit nodigt de volgende spelers nu per e-mail uit:'
                : 'Je maakt "{{name}}" aan van {{start}} t/m {{end}}. Elke groep houdt zijn eigen prijs per sessie — zie de tabel hieronder. Dit nodigt de volgende spelers nu per e-mail uit:'), {
              name: targetCycleName.trim() || t('rebookCohort.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
              start: newStartDate ? format(parse(newStartDate, 'yyyy-MM-dd', new Date()), 'd MMM yyyy') : newStartDate,
              end: newEndDate ? format(parse(newEndDate, 'yyyy-MM-dd', new Date()), 'd MMM yyyy') : (newStartDate ? format(parse(newStartDate, 'yyyy-MM-dd', new Date()), 'd MMM yyyy') : ''),
              price: sessionPrice || (preview?.suggestedPrice ?? ''),
            })}
          </p>
          {/* REVIEW ROUND 3 (P1): SHOWN FOR ONE CYCLE TOO. The server disambiguates against the
              round's existing names, so a single group can still be created under a name the
              operator never typed — and hiding the list below two hid exactly that case. */}
          {confirmData.targetCycles.length >= 1 && (
            <p className="text-sm font-medium text-foreground mt-2">
              {t('rebookCohort.confirmMultiCycle', 'Er worden {{count}} aparte cycli aangemaakt (één per groep): {{names}}', {
                count: confirmData.targetCycles.length,
                names: confirmData.targetCycles.map((c) => c.name).join(', '),
              })}
            </p>
          )}
          {holidays.filter((h) => h.from && h.to).length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.confirmHolidayNote', '{{count}} vakantieperiode wordt niet ingepland — die sessies zitten niet in de aantallen hieronder.', { count: holidays.filter((h) => h.from && h.to).length })}
            </p>
          )}
        </div>
        <RebookReviewTable
          groups={confirmData.groupsDetail}
          noEmailTotal={confirmData.noEmailTotal}
          grandInvoiceTotal={confirmData.grandInvoiceTotal}
          locationName={(id) => locations.find((l) => l.id === id)?.name}
          ackNoEmail={ackNoEmail}
          onAckChange={setAckNoEmail}
          interactive
          excludedKeys={excludedSeriesKeys}
          onToggleExcluded={toggleExcludedKey}
          summary={{ groups: confirmData.groups, players: confirmData.players, participantSessions: confirmData.totalSessions }}
        />
        {confirmData.rosterAsOf && (
          /* OD1 · THE ROSTER IS A SNAPSHOT, AND IT SAYS SO. See the same note in the other wizard. */
          <p className="text-xs text-muted-foreground" data-testid="cohort-contacts-asof">
            {t('rebookCohort.contactsSnapshot', 'Contactgegevens gecontroleerd op {{time}}. Wie daarna een e-mailadres toevoegt of verwijdert, verandert wie er een uitnodiging krijgt — we versturen naar de dan geldende gegevens.', {
              time: new Date(confirmData.rosterAsOf).toLocaleString(),
            })}
          </p>
        )}
        <p className="text-sm font-medium">
          {t('rebookCohort.confirmEmails', '{{players}} spelers krijgen nu een uitnodiging per e-mail.', { players: emailCount })}
        </p>
        <div className="space-y-3 rounded-md border p-3">
          <EmailSubjectField
            id="rebook-invite-subject"
            value={invitationSubject}
            onChange={setInvitationSubject}
            disabled={submitting}
            label={t('rebookCohort.inviteSubjectLabel', 'Onderwerp van de uitnodiging (optioneel)')}
            placeholder={t('rebookCohort.inviteSubjectPlaceholder', 'Reserveer je plek voor de volgende cyclus')}
            variablesHelp={t('rebookCohort.inviteVariablesHelp', 'Voeg variabele toe:')}
          />
          <EmailMessageField
            id="rebook-invite-message"
            value={invitationMessage}
            onChange={setInvitationMessage}
            disabled={submitting}
            maxLength={2000}
            label={t('rebookCohort.inviteMessageLabel', 'Persoonlijk bericht in de uitnodiging (optioneel)')}
            placeholder={t('rebookCohort.inviteMessagePlaceholder', 'Bijv. Leuk dat je er weer bij bent! Bevestig hieronder je vaste plek voor de volgende ronde.')}
            variablesHelp={t('rebookCohort.inviteVariablesHelp', 'Voeg variabele toe:')}
          />
        </div>
        {/* The automated reminder lives HERE with the other email content (owner request):
            everything a player will receive is written/reviewed in one place. */}
        <div className="space-y-3 rounded-md border p-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox checked={autoReminder} onCheckedChange={(v) => setAutoReminder(Boolean(v))} className="mt-0.5" />
            <div>
              <div className="text-sm font-medium">{t('rebookShared.autoReminder', 'Automatisch herinneren')}</div>
              <div className="text-xs text-muted-foreground">{t('rebookShared.autoReminderHint', 'Stuur spelers die nog niet reageerden automatisch een herinnering vlak voordat hun voorrang verloopt.')}</div>
            </div>
          </label>
          {autoReminder && (
            <div className="space-y-3 pl-7">
              <RebookReminderLeadField
                id="rebook-cohort-reminder-lead"
                valueHours={reminderLeadHours}
                onChange={setReminderLeadHours}
                disabled={submitting}
              />
              <EmailSubjectField
                id="rebook-cohort-reminder-subject"
                value={reminderSubject}
                onChange={setReminderSubject}
                disabled={submitting}
                label={t('rebookShared.reminderSubjectLabel', 'Onderwerp van de herinnering')}
                placeholder={t('rebookShared.defaultReminderSubject', 'Herinnering: bevestig je plek')}
                variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
              />
              <EmailMessageField
                id="rebook-cohort-reminder-message"
                value={reminderMessage}
                onChange={setReminderMessage}
                disabled={submitting}
                maxLength={2000}
                label={t('rebookShared.reminderMessageLabel', 'Bericht in de herinnering')}
                placeholder={t('rebookShared.defaultReminderMessage', '')}
                variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
              />
            </div>
          )}
        </div>
        <div className="rounded-md border p-3">
          <RebookClaimInfoField
            id="rebook-cohort-claim-info"
            value={claimInfo}
            onChange={setClaimInfo}
            disabled={submitting}
          />
        </div>
        <div className="rounded-md border p-3">
          <RebookRulesField
            academyProfileId={academyProfileId}
            value={rebookRules}
            onChange={setRebookRules}
            disabled={submitting}
          />
        </div>
        <div className="flex flex-wrap justify-end gap-2 sticky bottom-2 rounded-md border bg-background p-2 shadow-sm">
          <Button variant="outline" onClick={() => { setConfirmData(null); setAckNoEmail(false); }} disabled={submitting}>
            {t('common:cancel', 'Annuleren')}
          </Button>
          <Button
            onClick={handleSubmit}
            data-testid="cohort-send"
            disabled={sendBlocked || (confirmData.noEmailTotal > 0 && !ackNoEmail)}
          >
            {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
            {sendProgress
              ? t('rebookCohort.sending', 'Uitnodigingen versturen… {{sent}}/{{total}}', { sent: sendProgress.sent, total: sendProgress.total })
              : submitting
                ? t('common:saving', 'Bezig...')
                : t('rebookCohort.confirmSendCount', 'Verstuur {{count}} uitnodigingen', { count: emailCount })}
          </Button>
        </div>
      </div>
    );
  }

  // ===== Configure =====
  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(effectiveBackHref)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> {t('common:back', 'Terug')}
      </Button>

      {outcomeNotices}

      <div>
        <h1 className="text-2xl font-bold">
          {extendPrefill
            ? t('rebookCohort.extendTitle', 'Groepen toevoegen aan "{{name}}"', { name: extendPrefill.label })
            : t('rebookCohort.title', 'Hele groep opnieuw boeken')}
        </h1>
        <p className="text-muted-foreground">
          {extendPrefill
            ? t(
                'rebookCohort.extendSubtitle',
                'De instellingen van de ronde zijn overgenomen; je kunt alles behalve de naam aanpassen. Groepen die al in de ronde zitten worden overgeslagen — alleen nieuwe groepen worden uitgenodigd.',
              )
            : t(
                'rebookCohort.subtitle',
                'Kies de locatie(s) en de week waarin de huidige termijn eindigt. We zoeken de wekelijkse groepen, kopiëren ze naar de nieuwe ronde en nodigen elke speler uit.',
              )}
        </p>
      </div>

      {/* Live cohort count — appears as soon as location + dates are set */}
      {inputsValid && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-center gap-3 py-3 text-sm">
            <Users className="h-5 w-5 text-primary shrink-0" />
            {previewing && !preview ? (
              <span className="text-muted-foreground inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> {t('rebookCohort.counting', 'Spelers tellen…')}
              </span>
            ) : preview && preview.players > 0 ? (
              <span>
                <span className="font-semibold">{t('rebookCohort.cohortCount', 'Dit betreft {{players}} spelers in {{groups}} groepen.', { players: preview.players, groups: preview.groups })}</span>
                {preview.suggestedWeeks > 0 && (
                  <span className="text-muted-foreground"> {t('rebookCohort.cohortWeeks', '± {{count}} weken per groep.', { count: preview.suggestedWeeks })}</span>
                )}
                {preview.alreadySentGroups > 0 && (
                  <span className="text-muted-foreground"> {t('rebookCohort.alreadySentGroups', '{{count}} groep(en) zitten al in deze ronde en worden overgeslagen.', { count: preview.alreadySentGroups })}</span>
                )}
              </span>
            ) : preview ? (
              <span className="text-muted-foreground">
                {preview.alreadySentGroups > 0
                  ? t('rebookCohort.previewAllSent', 'Alle gevonden groepen ({{count}}) zitten al in deze ronde — er is niets nieuws om toe te voegen.', { count: preview.alreadySentGroups })
                  : t('rebookCohort.previewEmpty', 'Geen spelers gevonden voor deze selectie.')}
              </span>
            ) : null}
          </CardContent>
        </Card>
      )}

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
        <CardContent className="grid sm:grid-cols-3 gap-4">
          <div>
            <Label className="text-xs">{t('rebookCohort.termEnd', 'Einde huidige termijn')}</Label>
            <DateField value={termEndDate} onChange={setTermEndDate} />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.termEndHint', 'De week waarin de huidige termijn eindigt.')}
            </p>
          </div>
          <div>
            <Label className="text-xs">{t('rebookCohort.newStart', 'Start nieuwe ronde')}</Label>
            <DateField value={newStartDate} onChange={setNewStartDate} />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.newStartHint', 'Wanneer de volgende termijn begint.')}
            </p>
          </div>
          <div>
            <Label className="text-xs">{t('rebookCohort.newEnd', 'Einde nieuwe ronde')}</Label>
            <DateField value={newEndDate} onChange={setNewEndDate} />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.newEndHint', 'Leeg = lengte van de vorige ronde. Vakantiedagen worden niet ingepland.')}
            </p>
          </div>
        </CardContent>
      </Card>

      {previewTrainers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('rebookCohort.trainersTitle', 'Welke trainers gaan door?')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="pb-1 text-sm text-muted-foreground">
              {t('rebookCohort.trainersHint', 'Vink trainers uit die niet doorgaan. Hun sessies worden niet opnieuw geboekt.')}
            </p>
            {previewTrainers.map((tr) => (
              <label key={tr.id} className="flex items-center gap-3 rounded p-2 hover:bg-muted cursor-pointer">
                <Checkbox checked={trainerIncluded(tr.keys)} onCheckedChange={(v) => toggleTrainer(tr.keys, Boolean(v))} />
                <span className="text-sm font-medium">{tr.name}</span>
                <span className="text-xs text-muted-foreground">
                  {t('rebookCohort.trainerGroups', '{{n}} groep(en)', { n: tr.keys.length })}
                </span>
              </label>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.priceTitle', 'Prijs per sessie')}</CardTitle>
        </CardHeader>
        <CardContent className="grid sm:grid-cols-2 gap-4">
          <div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t('rebookCohort.sessionPrice', 'Prijs per sessie (€)')}</Label>
              {preview?.pricesIncludeVat != null && (
                <span className="text-xs text-muted-foreground">
                  {preview.pricesIncludeVat ? t('rebookCohort.vatIncl', 'incl. btw') : t('rebookCohort.vatExcl', 'excl. btw')}
                </span>
              )}
            </div>
            <Input
              type="number"
              min={0}
              step="0.01"
              value={sessionPrice}
              onChange={(e) => setSessionPrice(e.target.value)}
              placeholder={preview?.suggestedPrice != null ? String(preview.suggestedPrice) : '0.00'}
            />
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.sessionPriceHint', 'Prijs voor elke sessie in de nieuwe ronde.')}
            </p>
          </div>
        </CardContent>
      </Card>

      <HolidayRangeEditor holidays={holidays} onChange={setHolidays} />

      <Card>
        <CardHeader>
          <CardTitle>{t('rebookCohort.targetName', 'Naam nieuwe ronde')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            value={targetCycleName}
            onChange={(e) => setTargetCycleName(e.target.value)}
            placeholder={t('rebookCohort.targetNamePlaceholder', 'bv. Najaar 2026')}
            disabled={Boolean(extendPrefill)}
          />
          {extendPrefill && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('rebookCohort.extendNameHint', 'Nieuwe groepen worden aan deze bestaande ronde toegevoegd; de naam ligt daarom vast.')}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Payment + access settings are core decisions, not "advanced" — always visible
          (the old collapsible buried the payment mode, which owners must consciously pick). */}
      <RebookPaymentModeField
        academyProfileId={academyProfileId}
        paymentMode={paymentMode}
        setPaymentMode={setPaymentMode}
        strictMollie={strictMollie}
        setStrictMollie={setStrictMollie}
      />

      <RebookPublicOpenModeField
        mode={publicOpenMode}
        setMode={setPublicOpenMode}
        split={publicOpenSplit}
        setSplit={setPublicOpenSplit}
        multiSource
      />

      <RebookAccessWindows
        priorityWindowDays={priorityWindowDays}
        setPriorityWindowDays={setPriorityWindowDays}
        enableMemberWindow={enableMemberWindow}
        setEnableMemberWindow={setEnableMemberWindow}
        memberWindowDays={memberWindowDays}
        setMemberWindowDays={setMemberWindowDays}
        lockMemberWindow={false}
      />

      {/* ABC-26: rendered UNCONDITIONALLY, not under `enableMemberWindow` — see the identical
          block in AcademyNewRoundWizard. Containment truth must not disappear when the member
          window is switched off. The selector is removed, not disabled: a disabled control implies
          the action still exists, and a disabled control with stale state can still be submitted
          by a handler. */}
      <Card>
        <CardHeader><CardTitle>{t('newRound.priorityListTitle', 'Voorrangslijst')}</CardTitle></CardHeader>
        <CardContent>
          <PriorityUnavailableExplanation testId="cohort-priority-unavailable" />
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

      <div className="flex justify-end">
        <Button onClick={prepareConfirm} data-testid="cohort-to-review" disabled={previewBlocked || !preview || preview.players <= 0}>
          {preparing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ChevronRight className="h-4 w-4 mr-2" />}
          {preparing ? t('common:loading', 'Bezig...') : t('rebookCohort.toReview', 'Volgende: controleren')}
        </Button>
      </div>
    </div>
  );
}
