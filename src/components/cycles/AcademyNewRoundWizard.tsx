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
import { addWeeks, format, startOfDay } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePickerPopover } from '@/components/ui/date-picker-popover';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Send } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabaseClient';
import { getFriendlyErrorMessage } from '@/lib/friendlyError';
import { createAndDrainRebookRound, previewRebookRound, type RoundUnknownReason } from '@/lib/rebookInviteSend';
import { newSelectionUuid, type ReviewedSelection } from '@/lib/rebookSelectionDriver';
import { getCycles, type Cycle } from '@/lib/cycles';
import { fetchCyclusLabels, buildCyclusLabel, type CyclusRosterEntry } from '@/lib/cyclusLabel';
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

interface Props {
  academyProfileId: string;
  backHref: string;
}

interface HolidayRange {
  name: string;
  from: string;
  to: string;
}

// Review summary returned by the dryRun before anything is created/emailed.
//
// `revision` and `body` pin the review to the EXACT request that produced it. Creation re-sends
// `body` rather than rebuilding it from live state, and the send button is blocked whenever
// `revision` no longer matches the live inputs — so a round can never be created from a shape the
// operator did not see.
interface ReviewData {
  revision: string;
  body: Record<string, unknown>;
  groups: number;
  players: number;
  totalSessions: number;
  effWeeks: number;
  suggestedPrice: number | null;
  groupsDetail: RebookGroupDetail[];
  noEmailTotal: number;
  /** Invitations this send authorizes: summed per included series, not a deduped headcount. */
  emailInvitationTotal: number;
  /** When the server took the contact snapshot this review shows. Disclosure only, never authority. */
  rosterAsOf: string | null;
  grandInvoiceTotal: number;
  /**
   * The names the SERVER will give the cycles it creates.
   *
   * REVIEW ROUND 3 (P1): this wizard used to display the raw label it had typed, while the server
   * runs a disambiguation chain over the round's existing names. With one series and a same-date
   * cycle already holding `Ronde`, the review said `Ronde` and the round was written as
   * `Ronde — Ma 18:00`. Fixing the derivation and fingerprinting it made the wrong name STABLE; it
   * did not make it the name the operator saw.
   */
  targetCycles: Array<{ name: string }>;
}

/** A safe, non-negative integer from an untrusted response field — never `Number(...)`. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
/** An optional numeric field: a real finite number, or null. */
const optionalNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Academy "new round" / rebook wizard, keyed on a SOURCE CYCLUS.
 *
 * Mirrors creating a new session (start date, number of weeks, price per session) and reuses the
 * /slot/new date picker. It shows a stepped preview of exactly what will be created and emailed
 * before sending.
 *
 * IT NAMES A CYCLE; THE DATABASE DECIDES WHAT THAT MEANS. The selection surface clusters the
 * cyclus's slots into weekly series by academy-local weekday and time, generates the occurrences
 * (skipping holidays) rather than copying source slots 1:1, and names each child with the legacy
 * disambiguation chain. This wizard never sees a source slot and could not reconstruct one — the
 * derivation bridges are granted to no client role.
 */
export default function AcademyNewRoundWizard({ academyProfileId, backHref }: Props) {
  const { t } = useTranslation('cycles');
  const navigate = useNavigate();
  // ABC-26: the three terminal outcomes that must stay on screen. All are PERSISTENT — a blocking
  // result that a toast takes away is a result the operator cannot act on — and all are keyed on a
  // structured reason, never a display string.
  const [priorityRefusal, setPriorityRefusal] = useState<{ reason: PriorityRefusalReason; submitted: number } | null>(null);
  const [recovered, setRecovered] = useState<
    { roundId: string; targetCycleId: string; via: 'replay' | 'ledger' } | null>(null);
  const [unknownOutcome, setUnknownOutcome] = useState<
    { reason: RoundUnknownReason; targetCycleId: string | null; commandId?: string;
      recovery?: 'not_visible' | 'unreadable' } | null>(null);
  const [noWork, setNoWork] = useState(false);
  const [selectionMoved, setSelectionMoved] = useState(false);
  const [notPermitted, setNotPermitted] = useState<
    'session_price' | 'extend_unavailable' | 'not_permitted' | null>(null);
  /** Clear every terminal notice at the start of a new attempt, so none of them can look current. */
  const clearOutcomes = () => {
    setPriorityRefusal(null); setUnknownOutcome(null); setRecovered(null); setNoWork(false); setSelectionMoved(false); setNotPermitted(null);
  };

  // ── THE SELECTION SESSION ─────────────────────────────────────────────────────────────────
  //
  // Two facts that belong to this CONVERSATION rather than to what the operator chose, and both
  // live in refs for reasons that are not stylistic:
  //
  //   • The round uuid is client-minted and must be STABLE. Re-minting it on a retry would make the
  //     retry a different round — the derived child identities are keyed on it — so a transport
  //     failure followed by a second click would create a second set of cycles instead of replaying
  //     the first. It is minted ONCE, when the wizard mounts.
  //   • The selection digest arrives WITH a server answer. Folding it into `baseBody` would change
  //     `bodyRevision`, which is what blocks the send when the form no longer matches the review —
  //     so every answer would invalidate the review it had just produced.
  const roundIdRef = useRef<string>(newSelectionUuid());
  const selectionDigestRef = useRef<string | null>(null);
  // THE REVIEWED ARTEFACTS. The fingerprint binds the minted target identities and the command
  // uuid, so the send must present exactly what the review produced — re-deriving any of them
  // would apply something the operator never approved.
  const reviewedRef = useRef<ReviewedSelection | null>(null);
  const rpc = useCallback(
    async (fn: string, args: Record<string, unknown>) => {
      const r = await supabase.rpc(fn as never, args as never);
      return { data: r.data as unknown, error: r.error as unknown };
    },
    [],
  );
  // Ordering guard: only the NEWEST preview may write state. An older in-flight response is
  // discarded even if it lands last, and its AbortController is fired so it usually never lands.
  const previewGenRef = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const [searchParams] = useSearchParams();

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [cyclusLabels, setCyclusLabels] = useState<Map<string, CyclusRosterEntry>>(new Map());
  const [loadingCycles, setLoadingCycles] = useState(true);

  const [step, setStep] = useState<'configure' | 'review'>('configure');

  const [sourceCyclusId, setSourceCyclusId] = useState<string>(searchParams.get('source') ?? '');
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [sessionPrice, setSessionPrice] = useState('');
  const [holidays, setHolidays] = useState<HolidayRange[]>([]);
  const [targetCycleName, setTargetCycleName] = useState(
    t('newRound.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
  );

  const [priorityWindowDays, setPriorityWindowDays] = useState(7);
  const [memberWindowDays, setMemberWindowDays] = useState(7);
  const [enableMemberWindow, setEnableMemberWindow] = useState(true);
  const [paymentMode, setPaymentMode] = useState<RebookPaymentMode>('deferred_split');
  const [strictMollie, setStrictMollie] = useState(false);
  // How non-rebooked sessions become bookable once they OPEN to the public. 'inherit' = copy
  // the source court's flags (legacy default); an explicit mode overrides the whole round.
  const [publicOpenMode, setPublicOpenMode] = useState<PublicOpenMode>('inherit');
  const [publicOpenSplit, setPublicOpenSplit] = useState(false);
  const [requireAdminReview, setRequireAdminReview] = useState(false);
  // Automated reminder to non-responders ~24h before their priority window closes.
  const [autoReminder, setAutoReminder] = useState(true);
  // Hours before each player's deadline the automated reminder fires (stored unit = hours).
  const [reminderLeadHours, setReminderLeadHours] = useState(24);

  const [review, setReview] = useState<ReviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Live invite-drain progress ({ sent, total }) while a large round emails out.
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  const [ackNoEmail, setAckNoEmail] = useState(false);
  // Pre-fill a warm, personalised default so a new academy starts from something instead of
  // a blank box; fully editable. Leads with "Hoi {first_name}," (substituted per recipient).
  const [invitationMessage, setInvitationMessage] = useState(() => t('rebookShared.defaultInviteMessage'));
  const [invitationSubject, setInvitationSubject] = useState(() => t('rebookShared.defaultInviteSubject'));
  // The automated-reminder email text (used by auto-rebook-reminder; also pre-fills the manual send).
  const [reminderMessage, setReminderMessage] = useState(() => t('rebookShared.defaultReminderMessage'));
  const [reminderSubject, setReminderSubject] = useState(() => t('rebookShared.defaultReminderSubject'));
  const [rebookRules, setRebookRules] = useState('');
  // Per-round override of the claim page's standard explanation box ('' = standard copy).
  const [claimInfo, setClaimInfo] = useState('');
  useEffect(() => {
    getCycles('academy', academyProfileId)
      .then(setCycles)
      .catch((e) => toast.error(getFriendlyErrorMessage(e, t('newRound.errLoadCycles', 'Kon de cycli niet laden. Probeer het opnieuw.'))))
      .finally(() => setLoadingCycles(false));
  }, [academyProfileId, t]);

  // Enrich the source dropdown with each cyclus's day/time + roster + location.
  useEffect(() => {
    fetchCyclusLabels('academy', academyProfileId).then(setCyclusLabels);
  }, [academyProfileId]);

  const cyclusLabel = (c: Cycle): string => buildCyclusLabel(cyclusLabels.get(c.id)) ?? c.name;

  // Only genuine weekly training cycli are rebookable. Hide event/registration
  // cycles (no weekly series → an empty round) and rounds this wizard itself
  // generated (they carry a rebook_* settings marker) so a "Volgende ronde" can't
  // be picked as a source and rebooked again.
  const sourceCycles = useMemo(
    () => cycles.filter((c) => c.type === 'cyclus' && !c.settings?.rebook_payment_mode),
    [cycles],
  );

  const newStartDate = startDate ? format(startDate, 'yyyy-MM-dd') : '';
  const newEndDate = endDate ? format(endDate, 'yyyy-MM-dd') : '';
  const inputsValid = Boolean(sourceCyclusId) && Boolean(newStartDate);

  const baseBody = useMemo(
    () => ({
      // Pass B §4: declares that this client can READ the priority accounting. The Edge function
      // refuses a submission it could not report on, rather than returning a green round whose
      // refusals this page cannot show.
      priorityContractVersion: PRIORITY_PROTOCOL_VERSION,
      // THE TENANT IS NOW THE CALLER'S TO NAME. The retired edge function resolved the academy
      // from the source cyclus when the body omitted it; the typed surface authorizes against the
      // academy the CALLER names and re-anchors the cyclus to it, so an omitted academy is not a
      // convenience — it is a call that can only be refused.
      academyProfileId,
      sourceCyclusId,
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
      // Date model: the round runs from newStartDate to newEndDate; the number of sessions is
      // derived from that range minus the holiday days. When the end date is left blank, the
      // edge fn falls back to the previous round's length (suggestedWeeks).
      newEndDate: newEndDate || null,
      sessionPrice: sessionPrice === '' ? null : Number(sessionPrice),
      holidays: holidays.filter((h) => h.from && h.to),
      invitationMessage: invitationMessage.trim() || null,
      invitationSubject: invitationSubject.trim() || null,
      reminderMessage: reminderMessage.trim() || null,
      reminderSubject: reminderSubject.trim() || null,
      rebookRules: normalizeRichTextHtml(rebookRules),
      claimInfo: normalizeRichTextHtml(claimInfo),
      // Split by type: registered profiles vs accountless guests (two separate settings arrays,
      // each with its own can_book_member_window clause).
      // ABC-26: canonical empty arrays, always. Sending the fields explicitly (rather than
      // omitting them) makes the request self-describing and keeps the server's parse on one
      // code path for old and new clients alike.
      priorityPeople: [],
      priorityGuests: [],
      memberOpenMessage: null,
      autoReminder,
      reminderLeadHours,
    }),
    [academyProfileId, sourceCyclusId, newStartDate, newEndDate, priorityWindowDays, enableMemberWindow, memberWindowDays, paymentMode, strictMollie, publicOpenMode, publicOpenSplit, requireAdminReview, targetCycleName, sessionPrice, holidays, invitationMessage, invitationSubject, reminderMessage, reminderSubject, rebookRules, claimInfo, autoReminder, reminderLeadHours],
  );

  // The EXACT identity of the request. Every field that reaches the server is in it, so any change
  // an operator makes after reviewing — a date, the price, the round name, the reminder copy —
  // invalidates the review rather than silently riding along into creation.
  const bodyRevision = useMemo(() => JSON.stringify(baseBody), [baseBody]);
  // The LIVE revision, readable from inside an in-flight await: a closure captures the value
  // it started with, which is exactly what a staleness check must not compare against itself.
  const bodyRevisionRef = useRef(bodyRevision);
  useEffect(() => { bodyRevisionRef.current = bodyRevision; }, [bodyRevision]);
  // Blocking conditions for the send button AND for the handler it calls. Both are checked: a
  // disabled button is a hint, not a guarantee — the handler can still be reached by a stale
  // click, a keyboard activation racing a re-render, or a test.
  const reviewIsStale = review === null || review.revision !== bodyRevision;
  const sendBlocked =
    submitting || previewing || reviewIsStale || priorityRefusal !== null || unknownOutcome !== null
    || noWork || selectionMoved || notPermitted !== null;

  // Step 1 → 2: dryRun to compute exactly what will be created + emailed.
  //
  // Every non-preview answer is a PERSISTENT notice, and every one of them clears the review: a
  // review left on screen next to a refusal is a page showing two contradictory truths, and the
  // send button is driven by the review.
  const handleReview = async () => {
    if (!inputsValid) {
      toast.error(t('newRound.errFillRequired', 'Kies een cyclus en een startdatum.'));
      return;
    }
    const gen = ++previewGenRef.current;
    previewAbortRef.current?.abort();
    const ac = new AbortController();
    previewAbortRef.current = ac;
    // Snapshot the request AND its revision before awaiting, so the result is matched against the
    // inputs it was actually computed from — not against whatever the form holds when it returns.
    const snapshot = baseBody;
    const revision = bodyRevision;
    setPreviewing(true);
    clearOutcomes();
    try {
      // ── NO LENGTH? ASK FOR THE SOURCE TERM FIRST ──────────────────────────────────────────
      //
      // REVIEW ROUND 2 (P1). This screen offers "leave the end date blank to reuse the previous
      // round's length", and the typed core refuses an intent carrying neither an end date nor a
      // week count — so the blank-end-date flow reported "there is nothing to rebook" and could
      // never reach the suggestion that would have filled it in.
      //
      // `counts` is the projection that can answer without a length. It DESCRIBES the term that
      // ran; it does not substitute one, which is the rule the server enforces and this respects:
      // the field is filled in on screen and the operator reviews again, having seen it.
      if (!endDate) {
        const counted = await previewRebookRound(
          snapshot,
          { rpc, newUuid: newSelectionUuid, signal: ac.signal },
          { roundId: roundIdRef.current, selectionDigest: selectionDigestRef.current },
          'counts',
        );
        // REVIEW ROUND 3 (P2): THE FORM MUST NOT HAVE MOVED EITHER. `previewGenRef` only advances
        // on another Review click, and the source and date controls stay enabled while the count
        // is in flight — so an operator who picked an end date or a different source mid-flight had
        // the stale answer overwrite their input and clear the digest they had just invalidated.
        if (gen !== previewGenRef.current || counted.phase === 'aborted') return;
        if (revision !== bodyRevisionRef.current) return;
        if (counted.phase === 'preview') {
          const weeks = count(counted.body.suggestedWeeks);
          selectionDigestRef.current = counted.selectionDigest;
          if (weeks > 0 && startDate) {
            setEndDate(startOfDay(addWeeks(startDate, weeks - 1)));
            // The review is not run against a length the operator has not seen: filling the field
            // changes the request, so they confirm it and ask again.
            return;
          }
        }
      }

      // `review`, not `counts`: this wizard's preview IS the review — it carries the label, the
      // dates and the length, and its numbers are what the operator approves before sending.
      const result = await previewRebookRound(
        snapshot,
        { rpc, newUuid: newSelectionUuid, signal: ac.signal },
        { roundId: roundIdRef.current, selectionDigest: selectionDigestRef.current },
        'review',
      );
      // A superseded request carries no information about the world: it must not clear, replace or
      // contradict the authority held by the request that superseded it.
      if (gen !== previewGenRef.current || result.phase === 'aborted') return;

      if (result.phase === 'priority_refused') {
        setPriorityRefusal({ reason: result.reason, submitted: result.totalSubmitted });
        setReview(null);
        return;
      }
      if (result.phase === 'unknown') {
        setUnknownOutcome({ reason: result.reason, targetCycleId: null });
        setReview(null);
        return;
      }
      if (result.phase === 'creation_failed') {
        // A dry run that proves there is nothing to create. Not an error, and not a toast.
        setNoWork(true);
        setReview(null);
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
        if (result.body) {
          const d = result.body;
          selectionDigestRef.current = result.selectionDigest ?? null;
          setAckNoEmail(false);
          setReview({
            revision,
            body: snapshot,
            groups: count(d.groups),
            players: count(d.players),
            totalSessions: count(d.totalSessions),
            effWeeks: count(d.effWeeks),
            suggestedPrice: optionalNumber(d.suggestedPrice),
            groupsDetail: Array.isArray(d.groupsDetail) ? (d.groupsDetail as RebookGroupDetail[]) : [],
            noEmailTotal: count(d.noEmailTotal),
            emailInvitationTotal: count(d.emailInvitationTotal),
            rosterAsOf: typeof d.rosterAsOf === 'string' ? d.rosterAsOf : null,
            grandInvoiceTotal: optionalNumber(d.grandInvoiceTotal) ?? 0,
            targetCycles: Array.isArray(d.targetCycles) ? (d.targetCycles as Array<{ name: string }>) : [],
          });
          setStep('review');
        }
        return;
      }
      if (result.phase === 'selection_moved') {
        // The sessions changed under the digest this page was holding. The review is cleared —
        // it describes a selection the server no longer derives — and the operator is told to look
        // again rather than being shown numbers nothing will honour.
        setSelectionMoved(true);
        setReview(null);
        selectionDigestRef.current = null;
        reviewedRef.current = null;
        return;
      }

      selectionDigestRef.current = result.selectionDigest;
      reviewedRef.current = result.reviewed;
      const data = result.body;
      const players = count(data.players);
      if (players === 0) {
        setNoWork(true);
        setReview(null);
        return;
      }
      // Pre-fill the end date + price from the previous round when the user left them blank.
      // The last session lands (weeks-1) weeks after the start, so that's the suggested end date —
      // the user sees a concrete range they can shorten/extend and re-check.
      const suggestedWeeks = count(data.suggestedWeeks);
      const suggestedPrice = optionalNumber(data.suggestedPrice);
      if (!endDate && startDate && suggestedWeeks > 0) setEndDate(startOfDay(addWeeks(startDate, suggestedWeeks - 1)));
      // REVIEW ROUND 4 (P1): THE PRICE IS NO LONGER PREFILLED, and this is the difference
      // between a blocked flow and an UNSENDABLE one. ABC-27 marks any non-null session
      // price apply-ineligible, so auto-filling it from the source term meant an eligible
      // review immediately made itself un-appliable — and re-reviewing simply refilled it.
      // The suggestion is still SHOWN beside the field; typing one is the operator's
      // choice, and they are told plainly why it withholds the send.
      // (was: setSessionPrice(<the source term's modal price>))
      setAckNoEmail(false);
      setReview({
        revision,
        body: snapshot,
        groups: count(data.groups),
        players,
        totalSessions: count(data.totalSessions),
        effWeeks: count(data.effWeeks),
        suggestedPrice,
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
      setStep('review');
    } catch {
      // previewRebookRound never throws for a server outcome, so anything here is a client-side
      // fault. It leaves the preview UNVERIFIED rather than failed, and it clears the review.
      if (gen === previewGenRef.current) {
        setUnknownOutcome({ reason: 'unreadable_response', targetCycleId: null });
        setReview(null);
      }
    } finally {
      if (gen === previewGenRef.current) setPreviewing(false);
    }
  };

  // Step 2: create the round (fast), THEN drain the invite emails from the client
  // in bounded, resumable chunks. This avoids one giant edge invocation that could
  // hit the wall-clock and silently partial-send a large first blast.
  const handleSubmit = async () => {
    // The same guard the button renders, re-evaluated here. `review` is also the SNAPSHOT that gets
    // sent, so creation can only ever use the exact shape that was reviewed.
    if (!inputsValid || sendBlocked || !review || review.players <= 0) return;
    setSubmitting(true);
    setSendProgress(null);
    clearOutcomes();
    try {
      // 1. Create the round + claims WITHOUT sending (skipInvites) — returns fast.
      //    roundAware:true tells the engine we can drain a MULTI-cycle round (one cycle per
      //    series); without it a multi-target run sends inline so an old client never strands
      //    sibling cycles' invites.
      // Create the round WITHOUT sending, then drain invites in bounded, resumable chunks — the SHARED
      // orchestration both wizards use, so neither can regress to an inline blast (Codex round-9 #1).
      // What the operator agreed to send, in the same unit the server reports back and the drain
      // actually produces: one recipient per (series, player) with an address.
      const approvedInvitations = review.emailInvitationTotal;
      // THE DENOMINATOR OF "x OF y INVITATIONS SENT" IS INVITATIONS, NOT PEOPLE.
      //
      // REVIEW ROUND 1 (P2): this was `review.players`, the DISTINCT headcount. A player in two
      // included groups is one person and two invitations, so a partial send of one of them read
      // "1 of 1 invitations sent" while one was still queued. The correct denominator was already
      // computed on the line above.
      const total = approvedInvitations;
      // NO REVIEW ARTEFACTS, NO SEND. The fingerprint is the only thing the apply accepts, so a
      // review that produced none is a review this page may display but must never act on.
      const reviewed = reviewedRef.current;
      if (!reviewed) {
        setUnknownOutcome({ reason: 'unverified_creation', targetCycleId: null });
        return;
      }
      setSendProgress({ sent: 0, total });
      const result = await createAndDrainRebookRound(
        review.body,
        {
          rpc,
          onProgress: ({ totalSent, total: sendable }) => setSendProgress({ sent: totalSent, total: sendable || total }),
        },
        // THE SAME ROUND UUID the wizard has held since it mounted…
        { roundId: roundIdRef.current, selectionDigest: selectionDigestRef.current },
        // …and the EXACT review the operator approved. A retry re-enters here with both unchanged,
        // so the command replays instead of creating a second round.
        reviewed,
      );
      if (result.phase === 'priority_refused') {
        // Nothing was created and nothing was sent. Persistent, focused, no navigation.
        setPriorityRefusal({ reason: result.reason, submitted: result.totalSubmitted });
        return;
      }
      if (result.phase === 'unknown') {
        // The round MAY exist. Zero invites were drained by construction. Never a success toast and
        // never a navigation — landing the operator on a round page would assert the round exists.
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
        // Nothing was created and nothing was sent. The review is dropped with the digest, so the
        // send stays blocked until the operator has seen the current selection.
        setSelectionMoved(true);
        setReview(null);
        selectionDigestRef.current = null;
        return;
      }
      if (result.phase === 'creation_failed') {
        // The round was NOT created (Codex round-9 #2) — show the reason and do NOT navigate.
        if (result.reason === 'already_exists') toast.error(t('newRound.alreadyExists', 'Er bestaat al een ronde met deze naam en startdatum. Geef de nieuwe ronde een andere naam of datum.'));
        else if (result.reason === 'slot_overlap') toast.error(t('newRound.slotOverlap', 'De nieuwe periode botst met bestaande sessies van deze trainer. Kies een andere startdatum of tijd.'));
        else if (result.reason === 'nothing_to_rebook') toast.error(t('newRound.nothingToRebook', 'Er zijn geen spelers om te herboeken.'));
        else toast.error(t('newRound.errSubmit', 'Kon de ronde niet aanmaken. Probeer het opnieuw.'));
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
          t('newRound.contactsMoved', 'De ronde is aangemaakt. Let op: bij het versturen waren {{now}} spelers bereikbaar per e-mail, terwijl je er {{approved}} had goedgekeurd — iemand heeft er tussendoor een e-mailadres toegevoegd of verwijderd. Er zijn {{invites}} e-mails verstuurd.', {
            now: result.contactableCount,
            approved: approvedInvitations,
            invites: result.totalSent,
          }),
        );
      }
      // Round CREATED and fully VERIFIED (the only navigable arm). A partial/unknown delivery ⇒
      // resend from the rebook page. leftover===null means the count is UNKNOWN (a send threw before
      // any count was learned — Codex round-10 #1): use a no-numbers copy, never a fabricated total.
      if (result.leftover === null) {
        toast.warning(
          t('newRound.invitesPartialUnknown', 'De ronde is aangemaakt, maar het versturen van de uitnodigingen is onderbroken — verstuur de rest via de ronde-pagina.'),
          result.sampleError ? { description: result.sampleError } : undefined,
        );
      } else if (result.leftover > 0 || result.outcome === 'error') {
        toast.warning(
          t('newRound.invitesPartial', '{{sent}} van {{total}} uitnodigingen verstuurd. De ronde is aangemaakt — verstuur de rest via de ronde-pagina.', {
            sent: result.totalSent,
            total: total || result.totalSent + result.leftover,
          }),
          result.sampleError ? { description: result.sampleError } : undefined,
        );
      } else {
        toast.success(
          t('newRound.success', '{{groups}} groep(en) · {{players}} spelers uitgenodigd · {{invites}} e-mails', {
            groups: result.groups,
            players: result.players,
            invites: result.totalSent,
          }),
        );
      }
      // Land on the new cycle's rebook management view. `targetCycleId` is a validated UUID on this
      // arm, so there is no fallback branch that could navigate somewhere unrelated.
      navigate(`/app/academy/cycles/${result.targetCycleId}/rebook`);
    } catch (e) {
      // createAndDrainRebookRound does not throw for a server outcome; anything landing here is a
      // genuine client-side fault, and it leaves the world unverified rather than failed.
      setUnknownOutcome({ reason: 'transport_error', targetCycleId: null });
      toast.error(getFriendlyErrorMessage(e, t('newRound.errSubmit', 'Kon de ronde niet aanmaken. Probeer het opnieuw.')));
    } finally {
      setSubmitting(false);
      setSendProgress(null);
    }
  };

  if (loadingCycles) {
    return (
      <div className="container max-w-3xl mx-auto py-6">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const effPrice = sessionPrice || (review?.suggestedPrice != null ? String(review.suggestedPrice) : '');
  // A price is only universal when the operator TYPED one; otherwise each series keeps its own.
  const priceIsUniversal = sessionPrice.trim() !== '';

  return (
    <div className="container max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(backHref)}>
        <ArrowLeft className="h-4 w-4 mr-2" /> {t('common:back', 'Terug')}
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{t('newRound.title', 'Volgende ronde opzetten')}</h1>
        <p className="text-muted-foreground">
          {t('newRound.subtitle', 'Kies een cyclus, een startdatum en het aantal weken. We maken één nieuwe ronde aan en geven je huidige spelers als eerste de kans hun vaste plek te houden.')}
        </p>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('font-medium', step === 'configure' ? 'text-foreground' : 'text-muted-foreground')}>
          1. {t('newRound.stepConfigure', 'Instellen')}
        </span>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
        <span className={cn('font-medium', step === 'review' ? 'text-foreground' : 'text-muted-foreground')}>
          2. {t('newRound.stepReview', 'Controleren & versturen')}
        </span>
      </div>

      {/* ABC-26: terminal outcomes live ABOVE the step switch, so a refusal raised on step 2 is
          still on screen after the operator steps back to fix the inputs. Rendering them inside a
          step made them vanish exactly when they were being acted on. */}
      <PriorityRefusalAlert
        reason={priorityRefusal?.reason ?? null}
        submitted={priorityRefusal?.submitted ?? 0}
      />
      <RoundRecoveredNotice
        roundId={recovered?.roundId ?? null}
        targetCycleId={recovered?.targetCycleId ?? null}
        via={recovered?.via ?? null}
        testId="round-recovered"
      />
      <RoundUnknownAlert
        reason={unknownOutcome?.reason ?? null}
        targetCycleId={unknownOutcome?.targetCycleId ?? null}
        commandId={unknownOutcome?.commandId ?? null}
        recovery={unknownOutcome?.recovery ?? null}
      />
      <RoundNoWorkNotice shown={noWork} />
      <RoundNotPermittedNotice reason={notPermitted} />
      <RoundSelectionMovedNotice shown={selectionMoved} />

      {step === 'configure' && (
        <>
          <Card>
            <CardHeader><CardTitle>{t('newRound.source', 'Welke cyclus kopiëren?')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label className="text-xs">{t('newRound.sourceLabel', 'Cyclus')}</Label>
                <Select
                  value={sourceCyclusId}
                  onValueChange={(v) => {
                    setSourceCyclusId(v);
                    setReview(null);
                    // A NEW SOURCE IS A NEW SELECTION. Keeping the old digest would make the first
                    // review of it a guaranteed `selection_moved` — correct, and a wasted round
                    // trip that tells the operator to recover from something they just did.
                    selectionDigestRef.current = null;
                    reviewedRef.current = null;
                  }}
                >
                  <SelectTrigger><SelectValue placeholder={t('newRound.selectCyclus', 'Kies een cyclus')} /></SelectTrigger>
                  <SelectContent>
                    {sourceCycles.map((c) => <SelectItem key={c.id} value={c.id}>{cyclusLabel(c)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('newRound.sourceHint', 'We nemen het wekelijkse patroon en de spelers van deze cyclus over.')}
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('newRound.whenAndHowMany', 'Wanneer loopt de ronde?')}</CardTitle></CardHeader>
            <CardContent className="grid sm:grid-cols-3 gap-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('newRound.startDate', 'Startdatum')}</Label>
                <DatePickerPopover
                  value={startDate}
                  onChange={(d) => { if (d) { setStartDate(startOfDay(d)); setReview(null); } }}
                  disabled={(date) => date < startOfDay(new Date())}
                  className="w-full"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('newRound.endDate', 'Einddatum')}</Label>
                <DatePickerPopover
                  value={endDate}
                  onChange={(d) => { if (d) { setEndDate(startOfDay(d)); setReview(null); } }}
                  disabled={(date) => (startDate ? date < startDate : date < startOfDay(new Date()))}
                  className="w-full"
                />
                <p className="text-xs text-muted-foreground">{t('newRound.endDateHint', 'Leeg = lengte van de vorige ronde. Vakantiedagen worden niet ingepland.')}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('newRound.sessionPrice', 'Prijs per sessie (€)')}</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={sessionPrice}
                  onChange={(e) => setSessionPrice(e.target.value)}
                  placeholder="0.00"
                />
                <p className="text-xs text-muted-foreground">{t('newRound.sessionPriceHint', 'Geldt voor elke sessie in de nieuwe ronde.')}</p>
              </div>
            </CardContent>
          </Card>

          <HolidayRangeEditor holidays={holidays} onChange={setHolidays} />

          <Card>
            <CardHeader><CardTitle>{t('newRound.targetName', 'Naam nieuwe ronde')}</CardTitle></CardHeader>
            <CardContent>
              <Input value={targetCycleName} onChange={(e) => setTargetCycleName(e.target.value)} placeholder={t('newRound.targetNamePlaceholder', 'bv. Najaar 2026')} />
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

          {/* ABC-26: rendered UNCONDITIONALLY, not under `enableMemberWindow`.
              The old gate made sense when the card held a selector that only mattered during the
              member window. It now holds the containment truth, and gating truth on a toggle means
              the explanation vanishes the moment an operator turns the member window off — exactly
              when they are most likely to go looking for where the priority list went.
              The selector is GONE, not disabled: a disabled control still implies the action exists
              and will return, and a disabled control with stale state can still be submitted by a
              handler. There is nothing here to submit. */}
          <Card>
            <CardHeader><CardTitle>{t('newRound.priorityListTitle', 'Voorrangslijst')}</CardTitle></CardHeader>
            <CardContent>
              <PriorityUnavailableExplanation testId="new-round-priority-unavailable" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('newRound.publicRelease', 'Publiek vrijgeven')}</CardTitle></CardHeader>
            <CardContent>
              <label className="flex items-start gap-3 cursor-pointer">
                <Checkbox checked={requireAdminReview} onCheckedChange={(v) => setRequireAdminReview(Boolean(v))} />
                <div>
                  <div className="text-sm font-medium">{t('newRound.requireReview', 'Mijn goedkeuring vereist voordat het publiek wordt')}</div>
                  <div className="text-xs text-muted-foreground">{t('newRound.requireReviewHint', 'De plekken blijven verborgen totdat je ze zelf vrijgeeft.')}</div>
                </div>
              </label>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleReview} disabled={previewing || !inputsValid}>
              {previewing ? t('common:loading', 'Bezig...') : t('newRound.toReview', 'Controleren')}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </>
      )}

      {step === 'review' && review && (
        <>
          <Card>
            <CardHeader><CardTitle>{t('newRound.reviewTitle', 'Dit gaat er gebeuren')}</CardTitle></CardHeader>
            <CardContent className="space-y-4 text-sm">
              <p>
                {/* REVIEW ROUND 5 (P2): DO NOT CLAIM ONE PRICE THE ROUND DOES NOT HAVE. A blank
                    price field sends `sessionPrice: null`, and the server then gives every series
                    its OWN source price. This line used to substitute the single modal
                    recommendation anyway, so a €20/€30 pair of groups read "€20 per sessie" while a
                    child was written at €30. It is exactly the sendable path that was wrong: a
                    typed price makes the round apply-ineligible, so blank is the only case that
                    can reach a send. */}
                {t(priceIsUniversal ? 'newRound.reviewIntroRange' : 'newRound.reviewIntroRangePerGroup',
                  priceIsUniversal
                    ? 'Je maakt "{{name}}" aan van {{start}} t/m {{end}}, € {{price}} per sessie:'
                    : 'Je maakt "{{name}}" aan van {{start}} t/m {{end}}. Elke groep houdt zijn eigen prijs per sessie — zie de tabel hieronder:', {
                  // THE SERVER'S NAME, NOT THE TYPED ONE (review round 3, P1). The database runs a
                  // disambiguation chain over the round's existing names, so what gets created can
                  // differ from what was typed — and this line is the operator's only sight of it.
                  // Falling back to the typed label only when the server named nothing.
                  name: review.targetCycles.map((c) => c.name).join(', ')
                    || targetCycleName.trim()
                    || t('newRound.defaultCycleName', 'Volgende ronde {{year}}', { year: new Date().getFullYear() }),
                  start: newStartDate,
                  end: newEndDate || newStartDate,
                  price: effPrice || '—',
                })}
              </p>
              {holidays.filter((h) => h.from && h.to).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('newRound.reviewHolidayNote', '{{count}} vakantieperiode wordt niet ingepland — die sessies zitten niet in de aantallen hieronder.', { count: holidays.filter((h) => h.from && h.to).length })}
                </p>
              )}
              <RebookReviewTable
                groups={review.groupsDetail}
                noEmailTotal={review.noEmailTotal}
                grandInvoiceTotal={review.grandInvoiceTotal}
                ackNoEmail={ackNoEmail}
                onAckChange={setAckNoEmail}
                paymentMode={paymentMode}
                // REVIEW ROUND 1 (P2): THE SERVER'S TOTALS, as the cohort wizard already passes.
                // Without them the table sums per-series players, so a person in two groups is
                // displayed twice — while `review.players` is the authoritative DISTINCT headcount
                // the server computed for exactly that reason.
                summary={{
                  groups: review.groups,
                  players: review.players,
                  participantSessions: review.totalSessions,
                }}
              />
              {holidays.filter((h) => h.from && h.to).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('newRound.reviewHolidays', 'Vakanties overgeslagen: {{names}}', {
                    names: holidays.filter((h) => h.from && h.to).map((h) => h.name || `${h.from}–${h.to}`).join(', '),
                  })}
                </p>
              )}
              {review.rosterAsOf && (
                /* OD1 · THE ROSTER IS A SNAPSHOT, AND IT SAYS SO.
                   Contact data is a mutable attribute of a person, not identity of this command:
                   the reviewed receipt binds WHO and WHAT, never how they are reachable. So the
                   round is not frozen against a contact edit — it is sent against whatever is
                   current — and the operator is told that plainly rather than being left to assume
                   the list they approved is the list that gets mailed. */
                <p className="text-xs text-muted-foreground" data-testid="new-round-contacts-asof">
                  {t('newRound.contactsSnapshot', 'Contactgegevens gecontroleerd op {{time}}. Wie daarna een e-mailadres toevoegt of verwijdert, verandert wie er een uitnodiging krijgt — we versturen naar de dan geldende gegevens.', {
                    time: new Date(review.rosterAsOf).toLocaleString(),
                  })}
                </p>
              )}
              <p className="font-medium">
                {t('newRound.reviewEmails', '{{players}} spelers krijgen nu een uitnodiging per e-mail.', {
                  players: review.emailInvitationTotal,
                })}
              </p>
              <div className="space-y-3 rounded-md border p-3">
                <EmailSubjectField
                  id="rebook-invite-subject"
                  value={invitationSubject}
                  onChange={setInvitationSubject}
                  disabled={submitting}
                  label={t('newRound.inviteSubjectLabel', 'Onderwerp van de uitnodiging (optioneel)')}
                  placeholder={t('newRound.inviteSubjectPlaceholder', 'Reserveer je plek voor de volgende cyclus')}
                  variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
                />
                <EmailMessageField
                  id="rebook-invite-message"
                  value={invitationMessage}
                  onChange={setInvitationMessage}
                  disabled={submitting}
                  maxLength={2000}
                  label={t('newRound.inviteMessageLabel', 'Persoonlijk bericht in de uitnodiging (optioneel)')}
                  placeholder={t('newRound.inviteMessagePlaceholder', 'Bijv. Leuk dat je er weer bij bent! Bevestig hieronder je vaste plek voor de volgende ronde.')}
                  variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
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
                      id="rebook-newround-reminder-lead"
                      valueHours={reminderLeadHours}
                      onChange={setReminderLeadHours}
                      disabled={submitting}
                    />
                    <EmailSubjectField
                      id="rebook-reminder-subject"
                      value={reminderSubject}
                      onChange={setReminderSubject}
                      disabled={submitting}
                      label={t('rebookShared.reminderSubjectLabel', 'Onderwerp van de herinnering')}
                      placeholder={t('rebookShared.defaultReminderSubject', 'Herinnering: bevestig je plek')}
                      variablesHelp={t('newRound.inviteVariablesHelp', 'Voeg variabele toe:')}
                    />
                    <EmailMessageField
                      id="rebook-reminder-message"
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
                  id="rebook-newround-claim-info"
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
            </CardContent>
          </Card>

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep('configure')} disabled={submitting}>
              <ArrowLeft className="h-4 w-4 mr-2" /> {t('newRound.backToConfigure', 'Aanpassen')}
            </Button>
            {/* Blocked on the SAME condition the handler re-checks: pending, stale (the inputs moved
                since this review was computed), or any terminal outcome standing. */}
            <Button
              onClick={handleSubmit}
              data-testid="new-round-send"
              disabled={sendBlocked || (review.noEmailTotal > 0 && !ackNoEmail)}
            >
              <Send className="h-4 w-4 mr-2" />
              {sendProgress
                ? t('newRound.sending', 'Uitnodigingen versturen… {{sent}}/{{total}}', { sent: sendProgress.sent, total: sendProgress.total })
                : submitting
                  ? t('common:saving', 'Bezig...')
                  : t('newRound.confirmSend', 'Aanmaken & spelers uitnodigen')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
