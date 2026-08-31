// The argument both web result-page renderers accept.
//
// It lives apart from either renderer because neither owns it: the HTML page
// and the markdown twin are two presentations of one input, and a caller
// hands the same object to both.

import { CANONICAL_SITE_URL } from '../../shared/site-url';
import type { WebAuditFreshness } from './cache';
import type { WebRemediationCatalog } from './remediation';
import type { FreshnessState } from './summary-freshness';
import { freshnessState, resolveFreshness } from './summary-freshness';
import { type WebScorecardShape, type WebSummaryModel, webSummaryModel } from './summary-model';

export interface WebSummaryInput {
  scorecard: WebScorecardShape;
  domain: string;
  targetUrl: string;
  /** Friendly display label from the seed; falls back to the domain. */
  name?: string;
  /** Static remediation catalog; absent entries degrade to generic prompts. */
  remediation?: WebRemediationCatalog;
  /** Origin for skill links in prompts; defaults to the canonical site. */
  origin?: string;
  /**
   * Response-envelope freshness for this render. Omitted degrades to the
   * unknown-instant state rather than synthesizing a scoring time.
   */
  freshness?: WebAuditFreshness;
  /**
   * Clock for the refresh-eligibility decision. Injectable so the three
   * timestamp states are reproducible; the emitted instants never depend on it.
   */
  now?: number;
}

/** Everything a renderer needs, resolved once from the caller's input. */
export type WebSummaryView = {
  model: WebSummaryModel;
  freshness: WebAuditFreshness;
  freshnessState: FreshnessState;
};

export function webSummaryView(input: WebSummaryInput): WebSummaryView {
  const freshness = resolveFreshness(input.freshness);
  return {
    model: webSummaryModel({
      scorecard: input.scorecard,
      domain: input.domain,
      targetUrl: input.targetUrl,
      name: input.name,
      remediation: input.remediation,
      origin: input.origin ?? CANONICAL_SITE_URL,
    }),
    freshness,
    freshnessState: freshnessState(freshness, input.now ?? Date.now()),
  };
}
