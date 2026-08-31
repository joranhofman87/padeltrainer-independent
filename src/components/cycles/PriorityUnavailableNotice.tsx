import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, HelpCircle, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { PriorityRefusalReason } from '@/lib/priorityUnavailable';
import type { RoundUnknownReason } from '@/lib/rebookInviteSend';
import type { ApplyStatus, PreviewStatus } from '@/lib/rebookRoundCommand';
import type { RoundUnknownReason as D7UnknownReason } from '@/lib/rebookRoundDriver';

/**
 * ABC-26 — the one place the rebook wizards say what happened to a round.
 *
 * Everything terminal lives here so the two wizards cannot phrase the same outcome differently,
 * and so the a11y contract is written once:
 *
 *  1. `PriorityUnavailableExplanation` — the STANDING explanation, shown wherever the priority
 *     selector used to be. Persistent and localized; it never claims anyone was admitted, emailed,
 *     or will receive priority.
 *  2. `PriorityRefusalAlert` — the server refused the request. Nothing was created.
 *  3. `RoundUnknownAlert` — we could not verify what happened. The round may or may not exist.
 *  4. `RoundNoWorkNotice` — the server answered, and there was nothing to rebook.
 *  5. `RebookRoundCommandRefusalAlert` / `RebookRoundCommandUnknownAlert` — the D7 (ABC-27) round
 *     command surface's closed answers. They reuse the SAME `TerminalNotice` frame rather than
 *     inventing a second notice system, so the a11y contract, the focus-once rule and the
 *     persistence rule hold for the new path exactly as they do for the legacy one.
 *
 * Two rules hold for all of them:
 *
 *  • PERSISTENT, never a toast. A toast for a blocking outcome disappears while the operator is
 *    still deciding what to do about it, and is gone entirely by the time they scroll back.
 *  • Keyed on the STRUCTURED reason, never on a display string. A display-string key changes with
 *    the translation, silently breaking both React reconciliation and any test that matches on it.
 */

/**
 * Shared frame for a terminal outcome: announced, focusable, and focused exactly once per distinct
 * reason — so a re-render cannot steal focus mid-typing, and a genuinely new outcome always does.
 */
function TerminalNotice({
  reasonKey,
  variant,
  icon,
  title,
  body,
  testId,
  dataAttr,
}: {
  reasonKey: string | null;
  variant: 'destructive' | 'default';
  icon: ReactNode;
  title: string;
  body: string;
  testId: string;
  dataAttr: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (reasonKey) ref.current?.focus();
  }, [reasonKey]);
  if (!reasonKey) return null;
  return (
    <Alert variant={variant} ref={ref} tabIndex={-1} role="alert" aria-live="assertive" data-testid={testId} {...dataAttr}>
      {icon}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{body}</AlertDescription>
    </Alert>
  );
}

export function PriorityUnavailableExplanation({ testId = 'priority-unavailable' }: { testId?: string }) {
  const { t } = useTranslation('cycles');
  return (
    <p className="text-xs text-muted-foreground" data-testid={testId} role="note">
      {t(
        'newRound.priority.unavailableExplanation',
        'Extra voorrang geven aan bepaalde spelers is nu niet beschikbaar. De ronde wordt gewoon aangemaakt en iedereen in de geselecteerde sessies krijgt een uitnodiging.',
      )}
    </p>
  );
}

/**
 * A server refusal. `submitted` is the RAW count the operator submitted, taken from a SUCCESSFULLY
 * PARSED refusal — never a `?? 0` fallback, which would report "0 selected" for a refusal whose
 * counts we could not read.
 */
export function PriorityRefusalAlert({
  reason,
  submitted,
  testId = 'priority-refusal',
}: {
  reason: PriorityRefusalReason | null;
  submitted: number;
  testId?: string;
}) {
  const { t } = useTranslation('cycles');
  return (
    <TerminalNotice
      reasonKey={reason}
      variant="destructive"
      icon={<AlertCircle className="h-4 w-4" />}
      title={t('newRound.priority.refusedTitle', 'De ronde is niet aangemaakt')}
      body={reason ? t(`newRound.priority.refusal.${reason}`, REASON_FALLBACK[reason], { count: submitted }) : ''}
      testId={testId}
      dataAttr={reason ? { 'data-refusal-reason': reason } : {}}
    />
  );
}

/**
 * We could not verify what happened — a transport failure, an unreadable body, a drifted field, or
 * a legacy edge that may have emailed people with accounting we never saw.
 *
 * This is deliberately NOT phrased as a failure. Saying "the round could not be created" after a
 * write may have landed is the same false confidence in the opposite direction, and it invites a
 * retry that would create a second round.
 */
export function RoundUnknownAlert({
  reason,
  targetCycleId,
  commandId,
  recovery,
  testId = 'round-unknown',
}: {
  reason: RoundUnknownReason | null;
  targetCycleId?: string | null;
  /**
   * The command uuid, when one was in flight.
   *
   * REVIEW ROUND 2 (P2): rendered as DATA, never as an action. Re-presenting it replays the stored
   * receipt instead of creating a second round, so it is the one handle that can resolve an
   * ambiguous apply — and it previously stopped at the helper boundary, leaving the operator a
   * terminal notice and no way to find out what happened.
   */
  commandId?: string | null;
  /**
   * WHAT THE COMMAND LEDGER SAID WHEN THE CLIENT ASKED IT.
   *
   * D7 TERMINAL CLOSURE. `absent` is a real, checked answer — no command was recorded for this
   * actor under either handle, so nothing was written and reviewing again is safe. It must read
   * differently from `unreadable`, which means we asked and still do not know; rendering the
   * weaker claim in the stronger words is exactly what this notice family exists to prevent.
   */
  recovery?: 'not_visible' | 'unreadable' | null;
  testId?: string;
}) {
  const { t } = useTranslation('cycles');
  const body = reason
    ? t(`newRound.outcome.unknown.${reason}`, UNKNOWN_FALLBACK[reason])
    : '';
  // REVIEW ROUND 1 (P1): NEITHER WORDING MAY PROMISE SAFETY. The ledger answers "not yours" and
  // "does not exist" with the same row, on purpose, so "no round was created — start again" was a
  // claim the client had no standing to make. Both messages now send the operator to look.
  const checked = recovery === 'not_visible'
    ? t('newRound.outcome.unknownCheckedNotVisible',
      'We hebben daarna gezocht en vonden geen ronde voor deze poging onder jouw account. Controleer eerst het ronde-overzicht voordat je een nieuwe aanmaakt.')
    : recovery === 'unreadable'
      ? t('newRound.outcome.unknownCheckedUnreadable',
        'We hebben geprobeerd het te controleren, maar konden geen uitsluitsel krijgen. Maak geen tweede ronde aan voordat je dit hebt nagekeken.')
      : '';
  return (
    <TerminalNotice
      reasonKey={reason}
      variant="destructive"
      icon={<HelpCircle className="h-4 w-4" />}
      title={t('newRound.outcome.unknownTitle', 'We konden niet bevestigen wat er is gebeurd')}
      body={checked ? `${body} ${checked}`.trim() : body}
      testId={testId}
      dataAttr={{
        ...(reason ? { 'data-unknown-reason': reason } : {}),
        ...(recovery ? { 'data-recovery': recovery } : {}),
        // Preserved for inspection/recovery. Rendered as data, NOT as a link: following it
        // automatically would be a navigation on an unverified creation.
        ...(targetCycleId ? { 'data-target-cycle-id': targetCycleId } : {}),
        ...(commandId ? { 'data-command-id': commandId } : {}),
      }}
    />
  );
}

/**
 * THE ROUND EXISTS; ITS INVITATIONS ARE UNRESOLVED.
 *
 * `D7_RECOVERY_AMBIGUOUS_PROVIDER_SEND_P1_V1`. Reached when the server REPLAYED an earlier command,
 * or when a lost apply response was resolved from the command ledger. Either way an earlier attempt
 * may already have emailed some of these players, and nothing durable records whether it did — a
 * provider send is only written down by `invited_at`, and that is stamped AFTER the send returns.
 *
 * So this is not a success and not a failure: it is a state that needs a person. It is persistent
 * and it does not navigate, because the operator has to go and look at the round before deciding to
 * resume — and resuming from there is their explicit choice, not this page's.
 */
export function RoundRecoveredNotice({
  roundId,
  targetCycleId,
  via,
  testId = 'round-recovered',
}: {
  roundId: string | null;
  targetCycleId?: string | null;
  via?: 'replay' | 'ledger' | null;
  testId?: string;
}) {
  const { t } = useTranslation('cycles');
  return (
    <TerminalNotice
      reasonKey={roundId}
      variant="default"
      icon={<HelpCircle className="h-4 w-4" />}
      title={t('newRound.outcome.recoveredTitle', 'De ronde bestaat al — controleer de uitnodigingen')}
      body={t('newRound.outcome.recoveredBody', 'Deze ronde is al eerder aangemaakt. We hebben nu niets verstuurd: een eerdere poging kan sommige spelers al een uitnodiging hebben gestuurd, en dat is niet met zekerheid vast te stellen. Open de ronde om te zien wie al een uitnodiging heeft en verstuur daar de rest.')}
      testId={testId}
      dataAttr={{
        'data-round-id': roundId ?? '',
        ...(targetCycleId ? { 'data-target-cycle-id': targetCycleId } : {}),
        ...(via ? { 'data-recovered-via': via } : {}),
      }}
    />
  );
}

/**
 * The server answered clearly and there was nothing to do. A real, non-alarming result — but a
 * PERSISTENT one: it used to be a toast, so an operator who looked away saw an empty review page
 * with no explanation of why it was empty.
 */
export function RoundNoWorkNotice({
  shown,
  testId = 'round-no-work',
}: {
  shown: boolean;
  testId?: string;
}) {
  const { t } = useTranslation('cycles');
  return (
    <TerminalNotice
      reasonKey={shown ? 'no_work' : null}
      variant="default"
      icon={<Info className="h-4 w-4" />}
      title={t('newRound.outcome.noWorkTitle', 'Er is niets om te herboeken')}
      body={t(
        'newRound.outcome.noWorkBody',
        'We hebben geen spelers gevonden voor deze selectie. Pas de cyclus, locaties of datums aan en controleer opnieuw.',
      )}
      testId={testId}
      dataAttr={{}}
    />
  );
}

/**
 * The selection moved under the operator's feet.
 *
 * A DISTINCT OUTCOME, WITH A DISTINCT RECOVERY. It is not `RoundUnknownAlert` — nothing is
 * uncertain, the server was perfectly clear and nothing was created. It is not `RoundNoWorkNotice`
 * — there IS something to rebook, it simply is not what this page last showed. The one thing the
 * operator has to do is look again, so that is what this says, and it is the only notice whose body
 * asks for an action on this page rather than on another one.
 *
 * `variant="default"`, not destructive: a source cycle gaining or losing a session between two
 * clicks is ordinary, and dressing it as an error teaches operators to ignore red.
 */
export function RoundSelectionMovedNotice({
  shown,
  testId = 'round-selection-moved',
}: {
  shown: boolean;
  testId?: string;
}) {
  const { t } = useTranslation('cycles');
  return (
    <TerminalNotice
      reasonKey={shown ? 'selection_moved' : null}
      variant="default"
      icon={<Info className="h-4 w-4" />}
      title={t('newRound.outcome.selectionMovedTitle', 'De sessies zijn gewijzigd')}
      body={t(
        'newRound.outcome.selectionMovedBody',
        'Er is niets aangemaakt en niets verstuurd. De sessies in deze selectie zijn veranderd sinds je ze bekeek — controleer het overzicht opnieuw voordat je verstuurt.',
      )}
      testId={testId}
      dataAttr={{}}
    />
  );
}

/**
 * The server reviewed the intent and will not let it be SENT.
 *
 * DISTINCT FROM EVERY OTHER NOTICE, because the operator's position is distinct: there is a real
 * review on screen, nothing is uncertain, nothing is missing, and the round still cannot be
 * created. The body names the rule rather than apologising generically, because the two reachable
 * reasons have completely different remedies — clear the price, or create a new round instead of
 * extending one.
 */
export function RoundNotPermittedNotice({
  reason,
  testId = 'round-not-permitted',
}: {
  reason: 'session_price' | 'extend_unavailable' | 'not_permitted' | null;
  testId?: string;
}) {
  const { t } = useTranslation('cycles');
  const fallback: Record<'session_price' | 'extend_unavailable' | 'not_permitted', string> = {
    session_price:
      'Er is niets aangemaakt. Een eigen prijs per sessie kan in deze ronde niet worden toegepast — laat het prijsveld leeg om de prijs van de bronsessies over te nemen.',
    extend_unavailable:
      'Er is niets aangemaakt. Deze ronde kan niet worden uitgebreid; maak in plaats daarvan een nieuwe ronde aan.',
    not_permitted:
      'Er is niets aangemaakt. De server heeft deze ronde beoordeeld en staat versturen niet toe.',
  };
  return (
    <TerminalNotice
      reasonKey={reason}
      variant="destructive"
      icon={<AlertTriangle className="h-4 w-4" />}
      title={t('newRound.outcome.notPermittedTitle', 'Deze ronde kan niet worden verstuurd')}
      body={reason ? t(`newRound.outcome.notPermitted.${reason}`, fallback[reason]) : ''}
      testId={testId}
      dataAttr={reason ? { 'data-not-permitted-reason': reason } : {}}
    />
  );
}

const REASON_FALLBACK: Record<PriorityRefusalReason, string> = {
  priority_unavailable:
    'Er is niets aangemaakt. Extra voorrang voor {{count}} geselecteerde speler(s) is nu niet beschikbaar; verwijder de selectie en probeer opnieuw.',
  unsupported_protocol_version:
    'Er is niets aangemaakt. Deze pagina is verouderd — herlaad de pagina en probeer opnieuw.',
  blank_identifier: 'Er is niets aangemaakt. Een van de geselecteerde spelers had geen geldig kenmerk.',
  invalid_identifier: 'Er is niets aangemaakt. Een van de geselecteerde spelers had een ongeldig kenmerk.',
  malformed_input: 'Er is niets aangemaakt. De selectie kon niet gelezen worden — herlaad de pagina.',
  duplicate_identifier: 'Er is niets aangemaakt. Een speler stond twee keer in de selectie.',
  too_many_submitted: 'Er is niets aangemaakt. Er waren te veel spelers geselecteerd.',
};

const UNKNOWN_FALLBACK: Record<RoundUnknownReason, string> = {
  unreadable_response:
    'Het antwoord van de server kon niet gelezen worden. Mogelijk is de ronde wel aangemaakt, mogelijk niet — er is vanaf deze pagina niets verstuurd. Controleer de rondes-pagina voordat je het opnieuw probeert.',
  unverified_creation:
    'De server antwoordde onvolledig, dus we kunnen niet bevestigen dat de ronde is aangemaakt. Er is vanaf deze pagina niets verstuurd. Controleer de rondes-pagina voordat je het opnieuw probeert.',
  unsupported_inline_delivery:
    'De server gebruikt een oudere versie die uitnodigingen zelf verstuurt. We kunnen niet nagaan wie er een e-mail heeft gekregen. Controleer de ronde-pagina voordat je opnieuw verstuurt.',
  transport_error:
    'De verbinding met de server is mislukt. Mogelijk is de ronde wel aangemaakt, mogelijk niet — er is vanaf deze pagina niets verstuurd. Controleer de rondes-pagina voordat je het opnieuw probeert.',
};

// ── D7 (ABC-27) — the round command surface's closed outcomes ────────────────────────────────
//
// One key per closed status, and the key IS the status. A message that merges two statuses is a
// message that tells the operator less than the server said; there are exactly twenty answers and
// each of them means something different about what to do next.

/**
 * The server refused a round command. NOTHING was created — every one of these statuses is a
 * committed refusal with zero mutation and zero capability issuance.
 */
export function RebookRoundCommandRefusalAlert({
  status,
  testId = 'round-command-refusal',
}: {
  status: Exclude<PreviewStatus | ApplyStatus, 'previewed' | 'applied' | 'replayed'> | null;
  testId?: string;
}) {
  const { t } = useTranslation('cycles');
  return (
    <TerminalNotice
      reasonKey={status}
      variant="destructive"
      icon={<AlertCircle className="h-4 w-4" />}
      title={t('newRound.command.refusedTitle', 'De ronde is niet aangemaakt')}
      body={status ? t(`newRound.command.refusal.${status}`, COMMAND_REFUSAL_FALLBACK[status]) : ''}
      testId={testId}
      dataAttr={status ? { 'data-command-status': status } : {}}
    />
  );
}

/**
 * We could not read what the command surface said.
 *
 * DELIBERATELY NOT PHRASED AS A FAILURE, and it carries the command id. An apply may well have
 * landed; the id is the ONLY thing that can resolve that, through the driver's recovery hops. It is
 * rendered as DATA, never as a link — following it automatically would be a navigation on an
 * unverified creation, and re-submitting with a fresh id is how one action becomes two rounds.
 */
export function RebookRoundCommandUnknownAlert({
  reason,
  commandId,
  testId = 'round-command-unknown',
}: {
  reason: D7UnknownReason | null;
  commandId?: string | null;
  testId?: string;
}) {
  const { t } = useTranslation('cycles');
  return (
    <TerminalNotice
      reasonKey={reason}
      variant="destructive"
      icon={<HelpCircle className="h-4 w-4" />}
      title={t('newRound.command.unknownTitle', 'We konden niet bevestigen wat er is gebeurd')}
      body={reason ? t(`newRound.command.unknown.${reason}`, COMMAND_UNKNOWN_FALLBACK[reason]) : ''}
      testId={testId}
      dataAttr={{
        ...(reason ? { 'data-unknown-reason': reason } : {}),
        ...(commandId ? { 'data-command-id': commandId } : {}),
      }}
    />
  );
}

type CommandRefusalStatus =
  Exclude<PreviewStatus | ApplyStatus, 'previewed' | 'applied' | 'replayed'>;

const COMMAND_REFUSAL_FALLBACK: Record<CommandRefusalStatus, string> = {
  refused:
    'Er is niets aangemaakt. Je hebt geen beheerrechten voor deze academie, of je sessie is verlopen — log opnieuw in en probeer het nog een keer.',
  invalid_request:
    'Er is niets aangemaakt. De ingevoerde gegevens vallen buiten wat een ronde mag bevatten. Controleer de datums, het aantal weken en de geselecteerde sessies.',
  command_tenant_mismatch:
    'Er is niets aangemaakt. Deze opdracht hoort bij een andere academie. Herlaad de pagina en begin opnieuw.',
  command_kind_mismatch:
    'Er is niets aangemaakt. Deze opdracht is eerder gebruikt om iets anders te doen. Herlaad de pagina en begin opnieuw.',
  command_payload_mismatch:
    'Er is niets aangemaakt. De gegevens zijn gewijzigd sinds je ze goedkeurde. Controleer de ronde opnieuw en bevestig daarna.',
  round_not_found: 'Er is niets aangemaakt. Deze ronde bestaat niet (meer) binnen deze academie.',
  round_closed:
    'Er is niets aangemaakt. Deze ronde is al gestart met versturen, dus er kunnen geen sessies meer aan toegevoegd worden. Maak een nieuwe ronde aan.',
  round_legacy_review_required:
    'Er is niets aangemaakt. Deze ronde komt uit de oude opzet en moet eerst handmatig nagekeken worden.',
  round_command_in_progress:
    'Er is niets aangemaakt. Iemand anders werkt op dit moment aan deze ronde. Probeer het zo opnieuw.',
  child_not_found: 'Er is niets aangemaakt. Een van de geselecteerde cyclussen bestaat niet in deze academie.',
  child_not_draft: 'Er is niets aangemaakt. Een van de geselecteerde cyclussen heeft een status die dit niet toelaat.',
  child_already_in_round: 'Er is niets aangemaakt. Een van de geselecteerde cyclussen hoort al bij een ronde.',
  duplicate_sibling_series: 'Er is niets aangemaakt. Deze reeks zit al in de ronde.',
  expected_version_mismatch:
    'Er is niets aangemaakt. De ronde is gewijzigd sinds je deze pagina opende. Herlaad de pagina en probeer opnieuw.',
  session_price_refused:
    'Er is niets aangemaakt. Een ronde met een eigen sessieprijs kan nog niet automatisch aangemaakt worden.',
  incoherent_source:
    'Er is niets aangemaakt. De geselecteerde sessies binnen een cyclus zijn niet gelijk ingesteld. Controleer de sessies en probeer opnieuw.',
  review_fingerprint_mismatch:
    'Er is niets aangemaakt. De goedgekeurde controle kon niet gelezen worden. Controleer de ronde opnieuw en bevestig daarna.',
  source_drift:
    'Er is niets aangemaakt. De onderliggende sessies zijn gewijzigd sinds je de ronde controleerde. Controleer opnieuw en bevestig daarna.',
};

const COMMAND_UNKNOWN_FALLBACK: Record<D7UnknownReason, string> = {
  transport_error:
    'De verbinding met de server is mislukt. Mogelijk is de ronde wel aangemaakt, mogelijk niet — er is niets verstuurd. Controleer de rondes-pagina voordat je het opnieuw probeert.',
  unreadable_probe:
    'Het antwoord van de server kon niet gelezen worden. Er is niets aangemaakt en niets verstuurd. Herlaad de pagina en probeer opnieuw.',
  unreadable_preview:
    'De controle van de server kon niet gelezen worden. Er is niets aangemaakt en niets verstuurd. Herlaad de pagina en probeer opnieuw.',
  unreadable_apply:
    'Het antwoord van de server kon niet gelezen worden. Mogelijk is de ronde wel aangemaakt — er is niets verstuurd. Controleer de rondes-pagina voordat je het opnieuw probeert.',
  unreadable_lookup:
    'We konden de status van deze opdracht niet opvragen. Controleer de rondes-pagina voordat je het opnieuw probeert.',
  probe_not_understood:
    'De server gaf een antwoord dat we niet konden plaatsen. Er is niets aangemaakt en niets verstuurd. Herlaad de pagina en probeer opnieuw.',
  review_fingerprint_unreadable:
    'De controle van de server kwam onvolledig binnen. Er is niets aangemaakt en niets verstuurd. Herlaad de pagina en probeer opnieuw.',
};
