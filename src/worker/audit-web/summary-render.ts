// Web result-page renderers (plan U9). Thin wrappers over the shared
// buildScorecardBody / buildScorecardMarkdown that pass a web `tool`
// shape ({ name: domain, url }) and suppress the CLI-only chrome
// (tier/language/install header rows are absent on the tool object;
// badge-embed, reproduce-CTA, and the version-scored detail row are
// suppressed via the shared renderer's opts). Same single source of
// truth as /score/live/<binary>, so /web/<domain> stays structurally
// aligned with the CLI scorecards.

import {
  buildScorecardBody as sharedBuildScorecardBody,
  buildScorecardMarkdown as sharedBuildScorecardMarkdown,
  escHtml as sharedEscHtml,
} from '../../shared/scorecard-format.mjs';
import { WEB_BREADCRUMB, WEB_CTA_NOTE_HTML } from './copy';

type WebScorecardShape = {
  spec_version?: string;
  target_url?: string;
  tool?: { name?: string; url?: string };
  badge?: { score_pct?: number };
};

export interface WebSummaryInput {
  scorecard: WebScorecardShape;
  domain: string;
  targetUrl: string;
}

function webTool(input: WebSummaryInput): { name: string; url: string } {
  return {
    name: input.scorecard.tool?.name ?? input.domain,
    url: input.scorecard.tool?.url ?? input.targetUrl,
  };
}

/** HTML body for /web/<domain>, rendered through the shared renderer. */
export function buildWebSummaryBody(input: WebSummaryInput): string {
  const headerSubline = `Website <a href="${sharedEscHtml(input.targetUrl)}">${sharedEscHtml(input.targetUrl)}</a> · agent-readiness audit`;
  return sharedBuildScorecardBody(webTool(input), input.scorecard, {
    breadcrumb: WEB_BREADCRUMB,
    headerSubline,
    hideBadgeEmbed: true,
    hideReproduce: true,
    hideVersionRow: true,
    ctaNoteHtml: WEB_CTA_NOTE_HTML,
  });
}

/** Markdown twin for /web/<domain>.md. Absolute principle links for cross-origin fetch. */
export function buildWebSummaryMarkdown(input: WebSummaryInput): string {
  const tool = webTool(input);
  const header = `# ${tool.name} — Agent-Readiness Audit\n\nWebsite: [${input.targetUrl}](${input.targetUrl})`;
  return sharedBuildScorecardMarkdown(tool, input.scorecard, {
    baseUrl: 'https://anc.dev',
    header,
    hideBadgeEmbed: true,
    hideReproduce: true,
    hideVersionRow: true,
  });
}
