// The page shell every Worker-rendered HTML page fills. The template is
// `dist/_internal/score-live-shell.html`, emitted by the build from the
// same `emitShell()` that builds the static pages, so a Worker page and a
// static page share one layout. It is fetched once per isolate and held.
//
// Placeholders: {{TITLE}}, {{DESCRIPTION}}, {{CANONICAL_PATH}}, {{BODY}},
// {{MARKDOWN_TWIN_PATH}} (the footer's twin link), and {{ALTERNATES}} (the
// `<link rel="alternate">` lines in the head). A page that names no twin
// gets `<canonical>.md`; a result page passes its `/md` and `/json`
// representations.

import { markdownAlternateLink } from '../shared/result-head';
import { escHtml } from '../shared/scorecard-format.mjs';

let shellTemplatePromise: Promise<string> | null = null;

export async function loadShellTemplate(env: { ASSETS: Fetcher }): Promise<string> {
  if (!shellTemplatePromise) {
    shellTemplatePromise = (async () => {
      const res = await env.ASSETS.fetch(new Request('https://assets.internal/_internal/score-live-shell.html'));
      if (!res.ok) throw new Error(`shell template missing (status ${res.status})`);
      return await res.text();
    })().catch((err) => {
      shellTemplatePromise = null;
      throw err;
    });
  }
  return shellTemplatePromise;
}

/** Test-only: drop the cached template. */
export function _resetShellTemplateCache(): void {
  shellTemplatePromise = null;
}

export type ShellFields = {
  title: string;
  description: string;
  canonicalPath: string;
  /** Rendered body HTML; every visitor-controlled value is already escaped. */
  body: string;
  /** The page's markdown twin; defaults to `<canonical>.md`. */
  markdownTwinPath?: string;
  /** The head's alternate links; defaults to the markdown twin alone. */
  alternatesHtml?: string;
};

export function substituteShell(template: string, fields: ShellFields): string {
  const twin = fields.markdownTwinPath ?? `${fields.canonicalPath}.md`;
  const alternates = fields.alternatesHtml ?? markdownAlternateLink(twin);
  return template
    .replaceAll('{{TITLE}}', escHtml(fields.title))
    .replaceAll('{{DESCRIPTION}}', escHtml(fields.description))
    .replaceAll('{{CANONICAL_PATH}}', escHtml(fields.canonicalPath))
    .replaceAll('{{MARKDOWN_TWIN_PATH}}', escHtml(twin))
    .replaceAll('{{ALTERNATES}}', alternates)
    .replaceAll('{{BODY}}', fields.body);
}
