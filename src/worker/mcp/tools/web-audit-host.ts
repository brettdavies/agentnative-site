// One audit_website run, hosted the way the transact endpoint hosts one: it
// claims the site's AuditJob, marks the in-flight flags, and appends every
// event to the job, so a browser tab or another MCP call that arrives
// mid-run attaches to this run instead of auditing the site a second time.
//
//   claim ......... a run already holding the job is attached to when the
//                   caller may attach; otherwise this run proceeds beside it
//                   and owns none of its keys
//   run ........... the web core's event stream, every event onto the job
//   settle ........ the job's appends land and the flags clear before the
//                   caller answers

import { auditErrorFor, CTA_RETRY, isTerminalEvent, type TerminalEvent } from '../../../shared/audit-events';
import { awaitJobTerminal, claimJob, type InFlightEnv, InFlightFlags } from '../../audit/inflight';
import { type RunWebAuditInput, runWebAuditStream, type WebCoreEnv } from '../../audit-web/core';

export type HostedAuditInput = Omit<RunWebAuditInput, 'env' | 'surface' | 'probeFetch'> & {
  /** False for a caller whose request differs from any run it could join (an explicit listing choice). */
  attach: boolean;
  signal?: AbortSignal;
};

/** The run's terminal event, and whether it came from another caller's run this call attached to. */
export type HostedAudit = { attached: boolean; terminal: TerminalEvent | null };

export async function hostWebAudit(env: WebCoreEnv & InFlightEnv, input: HostedAuditInput): Promise<HostedAudit> {
  const { attach, signal, ...run } = input;
  const host = run.target.host;
  const startedAt = new Date().toISOString();
  const job = await claimJob(env, 'web', host, startedAt);
  if (job.kind === 'running' && attach) {
    return { attached: true, terminal: await awaitJobTerminal(env, job.name, signal) };
  }
  const writer = job.kind === 'claimed' ? job.writer : null;
  const flags = new InFlightFlags(env, 'web', startedAt, writer?.name ?? null, job.kind !== 'running');
  await flags.mark(host);
  writer?.append({ type: 'accepted', lane: 'web', target: host, started_at: startedAt });
  let terminal: TerminalEvent | null = null;
  try {
    for await (const event of runWebAuditStream({ ...run, env, surface: 'mcp' })) {
      writer?.append(event);
      if (isTerminalEvent(event)) terminal = event;
    }
  } finally {
    // An attached reader waits on a terminal line, so a run that produced
    // none still closes its job with one.
    if (!terminal)
      writer?.append({ type: 'error', ...auditErrorFor('incomplete_response_contract', { cta: CTA_RETRY }) });
    await writer?.settled();
    await flags.clear();
  }
  return { attached: false, terminal };
}
