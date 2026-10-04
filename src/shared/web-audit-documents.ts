/** Documents web-audit discovery keeps for later checks, by the key a `retained-document` check names. */
export const RETAINED_DOCUMENT_KEYS = ['ai-catalog', 'api-catalog', 'server-card'] as const;

export type RetainedDocumentKey = (typeof RETAINED_DOCUMENT_KEYS)[number];
