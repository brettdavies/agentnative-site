// What a scorecard page's x-anc-clip header says, the og script reason it maps to, and the next command to run. The
// og-cards smoke names these when a clip does not appear; scripts/og/status.sh and the reason-code table in
// RELEASES-PREFLIGHT.md carry the same map, and tests/og-status-script.test.ts holds all three to this one.
//
// Commands are templates: <env> is staging or production, <base> the site under test, <target> the scorecard,
// <run> the x-anc-clip-run id, and <render-worker> / <site-worker> that environment's Worker names.

export type ClipCause = { reason: string; cause: string; command: string };

export const CLIP_CAUSES: Readonly<Record<string, ClipCause>> = {
  present: {
    reason: 'ok',
    cause: 'the clip exists and the page names it',
    command: 'scripts/og/status.sh <base> <target>',
  },
  off: {
    reason: 'switch-off',
    cause: 'OG_VIDEO_ENABLED is not set on the site Worker, so no render is asked for',
    command: 'scripts/og/setup.sh <env> --check',
  },
  queued: {
    reason: 'clip-rendering',
    cause: 'the RenderJob is claimed and waiting for its alarm',
    command: 'bunx wrangler tail <render-worker> --format json --search <run>',
  },
  rendering: {
    reason: 'clip-rendering',
    cause: 'the RenderJob is drawing or encoding the clip',
    command: 'bunx wrangler tail <render-worker> --format json --search <run>',
  },
  failed: {
    reason: 'clip-failed',
    cause: 'the RenderJob failed its last retry; its og.render records carry the error and the binding code',
    command: 'bunx wrangler tail <render-worker> --format json --search <run>',
  },
  none: {
    reason: 'clip-missing',
    cause: 'no RenderJob answered for the current card: no render was asked for, or the status call failed',
    command: 'bunx wrangler tail <site-worker> --format json --search score.og',
  },
};

/** x-anc-card: fallback means the render Worker could not draw the card, so its clip is not coming either. */
export const CARD_FALLBACK: ClipCause = {
  reason: 'card-fallback',
  cause: 'the render Worker could not draw the card, and the site served its default card',
  command: 'bunx wrangler tail <site-worker> --format json --search fallback',
};

export type CommandValues = { base: string; target: string; run?: string };

/** The environment a base URL is: anc.dev is production, anything else staging. */
export function environmentOf(base: string): 'production' | 'staging' {
  return /^(www\.)?anc\.dev$/.test(new URL(base).hostname) ? 'production' : 'staging';
}

export function fillCommand(template: string, values: CommandValues): string {
  const env = environmentOf(values.base);
  return template
    .replaceAll('<env>', env)
    .replaceAll('<base>', values.base)
    .replaceAll('<target>', values.target)
    .replaceAll('<run>', values.run ?? '')
    .replaceAll('<render-worker>', env === 'production' ? 'anc-og-render' : 'anc-og-render-staging')
    .replaceAll('<site-worker>', env === 'production' ? 'agentnative-site' : 'agentnative-site-staging');
}
