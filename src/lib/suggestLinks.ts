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
  } catch {}
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
  } catch {}
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

  // Split notes by commas, "en", "and", newlines
  const fragments = notes
    .split(/,|\n|(?:\s+en\s+)|(?:\s+and\s+)/gi)
    .map(f => f.trim())
    .filter(f => f.length >= 3);

  const unmatched: string[] = [];
  
  for (const fragment of fragments) {
    const normalizedFragment = normalize(fragment);
    
    // Check if this fragment matches any registered player
    const isMatched = [...normalizedNames].some(name => 
      name === normalizedFragment || 
      name.includes(normalizedFragment) || 
      normalizedFragment.includes(name)
    );
    if (isMatched) continue;

    // Check if fragment looks like a name (not just filler words)
    const words = normalizedFragment.split(/\s+/).filter(w => w.length >= 2);
    const meaningfulWords = words.filter(w => !FILLER_WORDS.has(w) && !PARTICLES.has(w));
    
    // Need at least one meaningful word that starts with uppercase in original
    const originalWords = fragment.split(/\s+/).filter(w => w.length >= 2);
    const hasCapitalizedWord = originalWords.some(w => /^[A-Z\u00C0-\u00FF]/.test(w));
    
    if (meaningfulWords.length === 0 || !hasCapitalizedWord) continue;
    
    // Skip if all words are filler
    if (meaningfulWords.length < 1) continue;

    // Check if dismissed
    if (dismissed.has(`${request.id}::${normalizedFragment}`)) continue;
    
    unmatched.push(fragment);
  }

  return unmatched;
}
  requestId: string,
  playerLinks: PlayerLink[],
): string[] {
  const link = playerLinks.find(pl => pl.intake_request_id === requestId);
  if (!link) return [];
  return playerLinks
    .filter(pl => pl.link_group === link.link_group && pl.intake_request_id !== requestId)
    .map(pl => pl.intake_request_id);
}
