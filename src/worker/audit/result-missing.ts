// The result pages for a target with no result: the shell they share, and the
// page for a target the public audit refuses for good.

import type { Representation } from '../../shared/audit-routes';
import { type LocalTargetError, localTargetBodyHtml, localTargetMarkdown } from '../audit-web/local-target';
import { applyHeaders } from '../headers';
import { loadShellTemplate, substituteShell } from '../shell-template';

type ShellEnv = Parameters<typeof loadShellTemplate>[0];

/** The refusal in the representation asked for: the command that audits the target, and no way to retry. */
export async function refusedTarget(
  ctx: {
    request: Request;
    env: ShellEnv;
    pathname: string;
    representation: Representation;
    legacy?: boolean;
  },
  error: LocalTargetError,
): Promise<Response> {
  const { request, env, pathname, representation, legacy } = ctx;
  const opts = { request, pathname, servedMarkdown: representation === 'md', servedJson: representation === 'json' };
  if (representation === 'json') return applyHeaders(new Response(JSON.stringify({ error }), { status: 404 }), opts);
  if (representation === 'md') return applyHeaders(new Response(localTargetMarkdown(error), { status: 404 }), opts);
  return missingPage(env, opts, {
    title: 'Refused — anc.dev',
    description: error.message,
    breadcrumb: error.value,
    markdownTwinPath: legacy ? undefined : `${pathname}/md`,
    body: localTargetBodyHtml(error),
  });
}

/** A 404 in the site shell. */
export async function missingPage(
  env: ShellEnv,
  opts: Parameters<typeof applyHeaders>[1],
  page: { title: string; description: string; breadcrumb: string; markdownTwinPath: string | undefined; body: string },
): Promise<Response> {
  let template: string;
  try {
    template = await loadShellTemplate(env);
  } catch (err) {
    return new Response(`shell template unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const html = substituteShell(template, { ...page, canonicalPath: opts.pathname, alternatesHtml: '' });
  return applyHeaders(
    new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    opts,
  );
}
