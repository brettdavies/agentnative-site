// The caption lines a check row carries about its check rather than its
// host: a pass in a superseded shape, and a stored row whose check id is
// retired. Written once as rich text, so the result page and its markdown
// twin say the same sentence.

import { cardSuffixUrl } from './discovery-documents';
import type { Rich } from './rich-text';

/** Where SEP-2127 puts a card, from the registry's discovery config. */
export type CardLocations = { card_suffix: string; ai_catalog: string };

// Stands in for an endpoint the scorecard did not record.
const ENDPOINT_PLACEHOLDER = '<endpoint>';

function cardUrl(endpoint: string | null, suffix: string): string {
  if (endpoint === null || !URL.canParse(endpoint)) return `${ENDPOINT_PLACEHOLDER}${suffix}`;
  return cardSuffixUrl(endpoint, suffix);
}

/**
 * The note on a server card that passed in the SEP-1649 shape. Without the
 * registry's card locations it states the shape alone, since the move it
 * would name has no URL to point at.
 */
export function supersededNote(endpoint: string | null, locations: CardLocations | null): Rich {
  const shape = 'Superseded shape (SEP-1649).';
  if (locations === null) return [shape];
  return [
    `${shape} SEP-2127 moves the card to `,
    { code: cardUrl(endpoint, locations.card_suffix) },
    ', listed in ',
    { code: locations.ai_catalog },
    '.',
  ];
}

export function retiredNote(successor: string): Rich {
  return [`Retired check, replaced by ${successor}. Re-audit to score it.`];
}
