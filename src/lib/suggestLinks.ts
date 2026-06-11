import { type IntakeRequestWithProposal, type PlayerLink } from '@/lib/cycles';

const DISMISSED_KEY = 'dismissed-link-suggestions';
const PARTICLES = new Set(['van', 'de', 'den', 'der', 'het', 'ter', 'ten', 'een']);

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Build a set of "requestId::suggestedId" pairs that were dismissed */
export function getDismissedSuggestions(): Set<string> {
  try {
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as string[];
      return new Set(arr);
    }
  } catch { /* non-fatal: corrupt/unavailable localStorage — fall back to empty set */ }
  return new Set();
}

export function dismissSuggestion(requestId: string, suggestedId: string): void {
  const dismissed = getDismissedSuggestions();
  dismissed.add(`${requestId}::${suggestedId}`);
  localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
}

export function isDismissed(requestId: string, suggestedId: string, dismissed: Set<string>): boolean {
  return dismissed.has(`${requestId}::${suggestedId}`);
}

/**
 * Get suggested links for a single request based on name mentions in notes.
 * Filters out already-linked players and dismissed suggestions.
 */
export function getSuggestedLinks(
  request: IntakeRequestWithProposal,
  allRequests: IntakeRequestWithProposal[],
  linkedIds: Set<string>,
  dismissed: Set<string>,
): IntakeRequestWithProposal[] {
  if (!request.notes || !allRequests.length) return [];

  const normalizedNotes = normalize(request.notes);
  const excludeIds = new Set([request.id, ...linkedIds]);

  return allRequests.filter(other => {
    if (other.cycle_id !== request.cycle_id) return false;
    if (excludeIds.has(other.id)) return false;
    if (isDismissed(request.id, other.id, dismissed)) return false;

    const tokens = normalize(other.full_name).split(/\s+/).filter(t => t.length >= 2);
    if (tokens.length === 0) return false;

    const significantTokens = tokens.filter(t => !PARTICLES.has(t));
    if (significantTokens.length === 0) return false;

    return significantTokens.every(t => t.length >= 3 && normalizedNotes.includes(t));
  });
}

/**
 * Get linked request IDs for a specific request from playerLinks data.
 */
export function getLinkedIdsForRequest(
  requestId: string,
  playerLinks: PlayerLink[],
): string[] {
  const link = playerLinks.find(pl => pl.intake_request_id === requestId);
  if (!link) return [];
  return playerLinks
    .filter(pl => pl.link_group === link.link_group && pl.intake_request_id !== requestId)
    .map(pl => pl.intake_request_id);
}

// --- Unmatched mentions ---

const DISMISSED_UNMATCHED_KEY = 'dismissed-unmatched-mentions';

const FILLER_WORDS = new Set([
  'ik', 'wil', 'graag', 'samen', 'met', 'ook', 'nog', 'heel', 'erg',
  'een', 'mijn', 'naar', 'voor', 'dat', 'die', 'dit', 'het', 'zijn',
  'haar', 'onze', 'hun', 'kan', 'zou', 'wij', 'zij', 'hij', 'niet',
  'wel', 'als', 'maar', 'want', 'omdat', 'dus', 'dan', 'bij', 'aan',
  'uit', 'over', 'tot', 'door', 'heb', 'heeft', 'hebben', 'ben', 'was',
  'were', 'will', 'would', 'like', 'to', 'with', 'and', 'also', 'the',
  'want', 'train', 'play', 'practice', 'lesson', 'les', 'training',
  'trainingen', 'padel', 'tennis', 'keer', 'per', 'week',
  'ochtend', 'middag', 'avond', 'morning', 'afternoon', 'evening',
  'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'privé', 'private', 'duo', 'groep', 'group',
  'voorkeur', 'liefst', 'eventueel', 'misschien', 'bijvoorbeeld',
  'spelen', 'gespeeld', 'ervaring', 'niveau', 'level',
  'jaar', 'jaren', 'maanden', 'months', 'years',
]);

export function getDismissedUnmatched(): Set<string> {
  try {
    const stored = localStorage.getItem(DISMISSED_UNMATCHED_KEY);
    if (stored) {
      return new Set(JSON.parse(stored) as string[]);
    }
  } catch { /* non-fatal: corrupt/unavailable localStorage — fall back to empty set */ }
  return new Set();
}

export function dismissUnmatchedMention(requestId: string, phrase: string): void {
  const dismissed = getDismissedUnmatched();
  dismissed.add(`${requestId}::${normalize(phrase)}`);
  localStorage.setItem(DISMISSED_UNMATCHED_KEY, JSON.stringify([...dismissed]));
}

/**
 * Extract name-like phrases from notes that don't match any registration.
 */
export function getUnmatchedMentions(
  request: IntakeRequestWithProposal,
  allRequests: IntakeRequestWithProposal[],
  dismissed: Set<string>,
): string[] {
  if (!request.notes || !allRequests.length) return [];

  const notes = request.notes;

  // Build set of normalized names in the cycle
  const normalizedNames = new Set(
    allRequests
      .filter(r => r.cycle_id === request.cycle_id && r.id !== request.id)
      .map(r => normalize(r.full_name))
  );

  // Regex: find sequences of capitalized words, optionally connected by particles
  // Matches: "Stefan Mols", "Els van der Meulen", "Angelique Mutsaers"
  // Does NOT match: "Ik speel" (lowercase 2nd word), "Geen tennisachtergrond"
  const PARTICLE_RE = '(?:van|de|den|der|het|ter|ten|een)';
  const CAP_WORD = '[A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]+';
  const NAME_RE = new RegExp(
    `${CAP_WORD}(?:\\s+${PARTICLE_RE})*(?:\\s+${CAP_WORD})+`,
    'g'
  );

  // Also match single capitalized words after "met" / "samen met"
  const SINGLE_AFTER_MET = /(?:samen\s+)?met\s+([A-Z\u00C0-\u00FF][a-z\u00E0-\u00FF]{2,})/g;

  const candidates = new Set<string>();

  // Multi-word name candidates
  for (const match of notes.matchAll(NAME_RE)) {
    const candidate = match[0];
    // Cap at 4 significant words (excluding particles)
    const words = candidate.split(/\s+/);
    const significant = words.filter(w => !PARTICLES.has(w.toLowerCase()));
    if (significant.length <= 4) {
      candidates.add(candidate);
    }
  }

  // Single names after "met"
  for (const match of notes.matchAll(SINGLE_AFTER_MET)) {
    const word = match[1];
    if (!FILLER_WORDS.has(word.toLowerCase()) && !PARTICLES.has(word.toLowerCase())) {
      candidates.add(word);
    }
  }

  const unmatched: string[] = [];

  for (const candidate of candidates) {
    const normalizedCandidate = normalize(candidate);

    // Skip if all significant words are filler
    const words = normalizedCandidate.split(/\s+/).filter(w => w.length >= 2);
    const meaningful = words.filter(w => !FILLER_WORDS.has(w) && !PARTICLES.has(w));
    if (meaningful.length === 0) continue;

    // Skip if it matches a registered player
    const isMatched = [...normalizedNames].some(name =>
      name === normalizedCandidate ||
      name.includes(normalizedCandidate) ||
      normalizedCandidate.includes(name)
    );
    if (isMatched) continue;

    // Skip if dismissed
    if (dismissed.has(`${request.id}::${normalizedCandidate}`)) continue;

    unmatched.push(candidate);
  }

  return unmatched;
}
