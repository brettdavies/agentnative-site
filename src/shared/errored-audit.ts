/**
 * True when a CLI scorecard reports an audit that errored (`summary.error`
 * above 0): a run that could not check part of the tool, which anc 0.7.0
 * exits 3 on. Such a run is served but never saved, so its next request
 * scores fresh instead of reading the partial result back for the cache's
 * lifetime.
 */
export function hasErroredAudits(scorecard: unknown): boolean {
  const errors = (scorecard as { summary?: { error?: unknown } } | null)?.summary?.error;
  return typeof errors === 'number' && errors > 0;
}
