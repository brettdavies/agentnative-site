// The shape of `anc audit --output json`, following anc's published
// schema/scorecard.schema.json for every field the scorecard renderers read.

import { z } from 'zod';

const count = z.number().int().nonnegative();
const text = z.string();
const nullableText = z.string().nullable();
const levelCounts = z.looseObject({ total: count, verified: count });

// Objects stay loose and enum-like strings other than `status` stay plain
// strings, so an additive anc release cannot stop live scoring.
const scorecardShape = z.looseObject({
  schema_version: text,
  results: z.array(
    z.looseObject({
      id: text,
      label: text,
      group: text,
      layer: text,
      status: z.enum(['pass', 'warn', 'fail', 'opt_out', 'n_a', 'skip', 'error']),
      evidence: nullableText,
      confidence: text,
      tier: nullableText,
      audit_id: text,
    }),
  ),
  summary: z.looseObject({
    total: count,
    pass: count,
    warn: count,
    fail: count,
    opt_out: count,
    n_a: count,
    skip: count,
    error: count,
  }),
  coverage_summary: z.looseObject({ must: levelCounts, should: levelCounts, may: levelCounts }),
  audience: nullableText,
  audit_profile: nullableText,
  spec_version: text,
  tool: z.looseObject({ name: text, binary: nullableText, version: nullableText }),
  anc: z.looseObject({ version: text }),
  run: z.looseObject({
    invocation: text,
    started_at: text,
    duration_ms: count,
    platform: z.looseObject({ os: text, arch: text }),
  }),
  target: z.looseObject({ kind: text, path: nullableText, command: nullableText }),
  badge: z.looseObject({
    eligible: z.boolean(),
    score_pct: z.number().int().min(0).max(100),
    embed_markdown: nullableText,
    scorecard_url: nullableText,
    badge_url: nullableText,
    convention_url: text,
  }),
});

/**
 * Returns the path of the first field that departs from the scorecard shape,
 * or null when the value matches. The path names declared fields only, never
 * a value, so it is safe to return to the caller.
 */
export function scorecardShapeIssue(value: unknown): string | null {
  const parsed = scorecardShape.safeParse(value);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.path.join('.') || 'root';
}
