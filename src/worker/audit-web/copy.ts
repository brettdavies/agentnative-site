// The website result page's explanatory copy, in one place so the
// renderer stays structure-only.

const SURFACE = "This scorecard reflects the target's public agent-facing surface";
const REAUDIT_HTML = 'Re-audit from the control above to refresh it, or call the <code>audit_website</code> MCP tool.';

/** The closing note's first sentence for a result that evaluated hosts the site declares. */
export const WEB_SURFACE_NOTE_HOSTS = `${SURFACE} and the hosts it declares at audit time.`;

export const WEB_CTA_NOTE_HTML = `${SURFACE} at audit time. ${REAUDIT_HTML}`;

export const WEB_CTA_NOTE_HOSTS_HTML = `${WEB_SURFACE_NOTE_HOSTS} ${REAUDIT_HTML}`;
