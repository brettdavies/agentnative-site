// Web-audit audience/CTA copy (plan U9). One place for the web result
// page's explanatory strings so the wrappers in summary-render.ts stay
// structure-only. The shared renderer needs no CLI-specific chrome for
// web (tier/language/install/badge/reproduce are all suppressed), so this
// dictionary carries only the web-specific breadcrumb + CTA note.

export const WEB_BREADCRUMB = { href: '/web', label: '← Web leaderboard' };

export const WEB_CTA_NOTE_HTML =
  "This scorecard reflects the target's public agent-facing surface at audit time. " +
  'Re-run the audit from <a href="/web-audit">anc.dev/web-audit</a> to refresh it, ' +
  'or call the <code>audit_website</code> MCP tool.';

export const WEB_RESULT_TITLE_SUFFIX = 'Agent-Readiness Audit';
