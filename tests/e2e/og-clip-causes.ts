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
  unknown: {
    reason: 'clip-unknown',
    cause:
      "the RenderJob did not answer the page's status call within 250 ms, as happens while it draws frames; the next fetch asks again",
    command: 'scripts/og/status.sh <base> <target>',
  },
  none: {
    reason: 'clip-missing',
    cause: 'no render was asked for the current card, or its job ended without a stored clip',
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

/** A run id from a response header passes only in its own shape, since an agent may run the command it lands in. */
const RUN_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function fillCommand(template: string, values: CommandValues): string {
  const env = environmentOf(values.base);
  const run = values.run && RUN_ID_RE.test(values.run) ? values.run : '';
  return template
    .replace(' --search <run>', run ? ` --search ${run}` : '')
    .replaceAll('<env>', env)
    .replaceAll('<base>', values.base)
    .replaceAll('<target>', values.target)
    .replaceAll('<render-worker>', env === 'production' ? 'anc-og-render' : 'anc-og-render-staging')
    .replaceAll('<site-worker>', env === 'production' ? 'agentnative-site' : 'agentnative-site-staging');
}
