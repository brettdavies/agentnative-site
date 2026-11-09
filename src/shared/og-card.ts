// The site-wide social card. Scorecard pages override the image URL; every
// other page keeps this path and this alt text. One constant so the shell
// emitter and the Worker template substituter cannot drift.

export const SITE_OG_IMAGE_PATH = '/og-image.png';

export const SITE_OG_IMAGE_ALT =
  'anc.dev, the agent-native standard: MUST run without prompting, SHOULD speak machine-first, MAY decorate when a TTY is open. One bar for agent-readiness, on two surfaces.';
