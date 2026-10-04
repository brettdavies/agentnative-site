/** Read-only discovery JSON may be fetched cross-origin by agent tools and scanners. */
export const DISCOVERY_CORS_HEADERS = {
  'access-control-allow-origin': '*',
} as const;
