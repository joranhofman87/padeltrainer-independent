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
