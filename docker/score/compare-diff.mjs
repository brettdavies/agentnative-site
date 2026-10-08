// Row diff for docker/score/compare.sh. Reads the run directory the harness
// writes (runs/<n>/status.tsv plus runs/<n>/{base,head}/<tool>.json) and
// decides which rows moved.
//
//   bun docker/score/compare-diff.mjs rerun-set <run-dir> [--noise <tsv>]
//   bun docker/score/compare-diff.mjs report <run-dir> [--noise <tsv>]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { badgeColor } from '../../src/build/badge.mjs';
import { renderMarkdown, renderText } from './compare-render.mjs';

const ROW_FIELDS = ['status', 'evidence', 'confidence'];
const ANTECEDENT = /^antecedent `([^`]+)` /;
const ABSENT = { absent: true };

/**
 * A result slot is `null` when the tool did not score in that run, and
 * otherwise an object: a row's `{status, evidence, confidence}`, a derived
 * field's `{value}`, or `{absent: true}`.
 *
 * @typedef {Record<string, unknown> | null} Slot
 * @typedef {{ rows: Map<string, Slot>, derived: Map<string, Slot> }} Facts
 * @typedef {{ status: string, facts: Facts | null }} Side
 * @typedef {Map<string, { base: Side, head: Side }>} Round
 */

/**
 * The report, which is also the shape of diff.json. `runs` is present on
 * entries from a tool that reran: the first run, each rerun, and the majority
 * of the reruns, per build.
 *
 * @typedef {{ status: string, evidence: string | null, confidence: string }} RowValue
 * @typedef {{ initial: Slot, reruns: Slot[], majority: Slot }} Tally
 * @typedef {{ base: Tally, head: Tally }} Runs
 * @typedef {{ tool: string, id: string, audit_id: string }} RowKey
 * @typedef {RowKey & { change: 'changed' | 'added' | 'removed', fields: string[], base: RowValue | null,
 *   head: RowValue | null, propagated_from?: string[], runs?: Runs }} RowMove
 * @typedef {RowKey & { noise_listed: boolean, runs: Runs }} VotedRow
 * @typedef {{ tool: string, field: string, base: unknown, head: unknown, runs?: Runs }} DerivedMove
 * @typedef {{
 *   mode: string,
 *   tools: { selected: number, compared: number, rerun: string[] },
 *   moved: RowMove[],
 *   noise: VotedRow[],
 *   unstable: VotedRow[],
 *   remeasured: VotedRow[],
 *   derived_moved: DerivedMove[],
 *   derived_noise: Array<{ tool: string, field: string, runs: Runs }>,
 *   derived_unstable: Array<{ tool: string, field: string, runs: Runs }>,
 *   harness_bugs: Array<{ tool: string, round: number, derived: DerivedMove[] }>,
 *   not_scored: Array<{ tool: string, round: number, base: string, head: string }>,
 * }} Report
 */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The score range that shares one badge fill with `pct`. badgeColor holds the
 * site's cohort-band thresholds; reading the range back from it keeps them in
 * one place.
 *
 * @param {number | null} pct
 * @returns {string | null}
 */
export function cohortBand(pct) {
  if (typeof pct !== 'number') return null;
  const fill = badgeColor(pct);
  let low = pct;
  let high = pct;
  while (low > 0 && badgeColor(low - 1) === fill) low--;
  while (high < 100 && badgeColor(high + 1) === fill) high++;
  return `${low}-${high}`;
}

/**
 * @param {any} scorecard
 * @param {string} file
 * @returns {Facts}
 */
function factsOf(scorecard, file) {
  const rows = new Map();
  for (const result of scorecard.results) {
    const key = `${result.id}\t${result.audit_id}`;
    if (rows.has(key)) throw new Error(`${file}: two rows share (${result.id}, ${result.audit_id})`);
    rows.set(key, { status: result.status, evidence: result.evidence ?? null, confidence: result.confidence });
  }
  const pct = scorecard.badge?.score_pct ?? null;
  const derived = new Map(
    [
      ['audience', scorecard.audience ?? null],
      ['audience_reason', scorecard.audience_reason ?? null],
      ['badge.score_pct', pct],
      ['badge.eligible', scorecard.badge?.eligible ?? null],
      ['band', cohortBand(pct)],
      ...Object.entries(scorecard.summary ?? {}).map(([count, n]) => [`summary.${count}`, n]),
    ].map(([field, value]) => [field, { value }]),
  );
  return { rows, derived };
}

/**
 * @param {string} runDir
 * @returns {Round[]} round 0 first, then each rerun
 */
export function loadRun(runDir) {
  const rounds = [];
  for (let n = 0; existsSync(join(runDir, 'runs', String(n), 'status.tsv')); n++) {
    const dir = join(runDir, 'runs', String(n));
    const side = (name, tool, status) => {
      const file = join(dir, name, `${tool}.json`);
      return { status, facts: status === 'ok' ? factsOf(JSON.parse(readFileSync(file, 'utf8')), file) : null };
    };
    const round = new Map();
    for (const line of readFileSync(join(dir, 'status.tsv'), 'utf8').split('\n').filter(Boolean)) {
      const [tool, base, head] = line.split('\t');
      round.set(tool, { base: side('base', tool, base), head: side('head', tool, head) });
    }
    rounds.push(round);
  }
  return rounds;
}

/**
 * Keys whose slots differ between two maps; a key one map lacks is absent there.
 *
 * @param {Map<string, Slot>} base
 * @param {Map<string, Slot>} head
 */
function differing(base, head) {
  return [...new Set([...base.keys(), ...head.keys()])]
    .map((key) => ({ key, base: base.get(key) ?? ABSENT, head: head.get(key) ?? ABSENT }))
    .filter((entry) => !same(entry.base, entry.head));
}

function rowMove(tool, key, base, head) {
  const [id, audit_id] = key.split('\t');
  const change = base.absent ? 'added' : head.absent ? 'removed' : 'changed';
  const fields = ROW_FIELDS.filter((field) => change !== 'changed' || base[field] !== head[field]);
  return { tool, id, audit_id, change, fields, base: base.absent ? null : base, head: head.absent ? null : head };
}

const derivedMove = (tool, field, base, head) => ({ tool, field, base: base.value ?? null, head: head.value ?? null });

/**
 * The slot two or more runs agree on, or `null` when no two agree. A run that
 * did not score casts no vote.
 *
 * @param {Slot[]} slots
 * @returns {Slot}
 */
export function majority(slots) {
  const votes = new Map();
  for (const slot of slots) {
    if (slot === null) continue;
    const key = JSON.stringify(slot);
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const winner = [...votes].find(([, count]) => count >= 2);
  return winner ? JSON.parse(winner[0]) : null;
}

/**
 * @param {string} text a noise list an A/A run wrote
 * @returns {Set<string>} `tool\tid\taudit_id` keys
 */
export function parseNoise(text) {
  const rows = text.split('\n').filter((line) => line && !line.startsWith('tool\tid\t'));
  return new Set(rows.map((line) => line.split('\t').slice(0, 3).join('\t')));
}

/** @param {Report} report an A/A report, whose moved rows are the noise */
export function noiseTsv(report) {
  const rows = report.moved.map((m) => [m.tool, m.id, m.audit_id, m.fields.join(',')].join('\t'));
  return `${['tool\tid\taudit_id\tfields', ...rows].join('\n')}\n`;
}

/**
 * Tools the before/after measures three more times: every tool with a moved
 * row in the first run, and every tool the noise list names.
 *
 * @param {Round} initial
 * @param {Set<string>} noise
 */
export function rerunSet(initial, noise) {
  const noisy = new Set([...noise].map((key) => key.split('\t')[0]));
  return [...initial.keys()]
    .filter((tool) => {
      const { base, head } = initial.get(tool);
      return noisy.has(tool) || (base.facts && head.facts && differing(base.facts.rows, head.facts.rows).length > 0);
    })
    .sort();
}

function labelPropagated(moves) {
  const movedAudits = new Set(moves.map((move) => move.audit_id));
  for (const move of moves) {
    const cited = [move.base, move.head].map((value) => value?.evidence?.match(ANTECEDENT)?.[1]);
    const from = [...new Set(cited.filter((audit) => movedAudits.has(audit)))];
    if (from.length > 0) move.propagated_from = from;
  }
}

/**
 * Every slot a key took across the first run and the reruns, per build.
 *
 * @param {Array<{ base: Side, head: Side } | undefined>} pairs one per round
 * @param {'rows' | 'derived'} kind
 */
function votes(pairs, kind) {
  const keys = new Set(
    pairs.flatMap((pair) => [pair?.base, pair?.head].flatMap((s) => [...(s?.facts?.[kind].keys() ?? [])])),
  );
  const tally = (side, key) => {
    const [initial, ...reruns] = pairs.map((pair) =>
      pair?.[side].facts ? (pair[side].facts[kind].get(key) ?? ABSENT) : null,
    );
    return { initial, reruns, majority: majority(reruns) };
  };
  return [...keys].map((key) => {
    const runs = { base: tally('base', key), head: tally('head', key) };
    const scored = [runs.base, runs.head]
      .flatMap((side) => [side.initial, ...side.reruns])
      .filter((slot) => slot !== null);
    return { key, runs, varies: new Set(scored.map((slot) => JSON.stringify(slot))).size > 1 };
  });
}

/** Whether some run under each build returned the same result. */
function sharesResult(runs) {
  const seen = (side) => new Set([side.initial, ...side.reruns].filter(Boolean).map((slot) => JSON.stringify(slot)));
  const base = seen(runs.base);
  return [...seen(runs.head)].some((result) => base.has(result));
}

/**
 * Whether a voted key moved, is noise, has no majority under a build, or was
 * measured again and held. `null` is a key that never differed and nobody
 * listed.
 *
 * A noise-listed key differs between two runs of one build, so differing
 * majorities alone do not show that the builds differ: a row that flips at
 * random gives two builds different majorities about half the time. It moves
 * only when the builds share no result at all.
 */
function verdict({ runs, varies }, noiseListed) {
  const [base, head] = [runs.base.majority, runs.head.majority];
  if (base && head && !same(base, head)) return noiseListed && sharesResult(runs) ? 'noise' : 'moved';
  if (!varies && !noiseListed) return null;
  return base && head ? 'remeasured' : 'unstable';
}

/**
 * Per round: a tool that did not score under a build, and a pair whose
 * derived fields differ while every row agrees. Derived fields are computed
 * from the rows, so that second case means the row diff missed something.
 */
function recordRounds(report, tool, pairs) {
  pairs.forEach((pair, round) => {
    if (!pair) return;
    if (!pair.base.facts || !pair.head.facts) {
      report.not_scored.push({ tool, round, base: pair.base.status, head: pair.head.status });
      return;
    }
    const derived = differing(pair.base.facts.derived, pair.head.facts.derived);
    if (derived.length > 0 && differing(pair.base.facts.rows, pair.head.facts.rows).length === 0) {
      const fields = derived.map((d) => derivedMove(tool, d.key, d.base, d.head));
      report.harness_bugs.push({ tool, round, derived: fields });
    }
  });
}

function firstRunMoves(report, tool, { base, head }) {
  if (!base.facts || !head.facts) return [];
  for (const d of differing(base.facts.derived, head.facts.derived)) {
    report.derived_moved.push(derivedMove(tool, d.key, d.base, d.head));
  }
  return differing(base.facts.rows, head.facts.rows).map((d) => rowMove(tool, d.key, d.base, d.head));
}

function votedMoves(report, tool, pairs, noise) {
  const moved = [];
  let noisyTool = false;
  for (const vote of votes(pairs, 'rows')) {
    const [id, audit_id] = vote.key.split('\t');
    const noise_listed = noise.has(`${tool}\t${vote.key}`);
    noisyTool ||= noise_listed;
    const { runs } = vote;
    const kind = verdict(vote, noise_listed);
    if (kind === 'moved') moved.push({ ...rowMove(tool, vote.key, runs.base.majority, runs.head.majority), runs });
    else if (kind) report[kind].push({ tool, id, audit_id, noise_listed, runs });
  }
  // A scorecard's derived fields follow its rows, so a noise-listed row makes
  // every derived field of its tool as noisy as the row.
  for (const vote of votes(pairs, 'derived')) {
    const { runs } = vote;
    const kind = verdict(vote, noisyTool);
    if (kind === 'moved') {
      report.derived_moved.push({ ...derivedMove(tool, vote.key, runs.base.majority, runs.head.majority), runs });
    } else if (kind === 'noise' || kind === 'unstable') {
      report[`derived_${kind}`].push({ tool, field: vote.key, runs });
    }
  }
  return moved;
}

/**
 * @param {Round[]} rounds round 0 first, then each rerun
 * @param {{ mode: string, noise?: Set<string> }} options
 * @returns {Report}
 */
export function buildReport(rounds, { mode, noise = new Set() }) {
  const [initial, ...reruns] = rounds;
  /** @type {Report} */
  const report = {
    mode,
    tools: { selected: initial.size, compared: 0, rerun: [] },
    moved: [],
    noise: [],
    unstable: [],
    remeasured: [],
    derived_moved: [],
    derived_noise: [],
    derived_unstable: [],
    harness_bugs: [],
    not_scored: [],
  };
  const order = (move) => `${move.id}\t${move.audit_id}`;

  for (const tool of [...initial.keys()].sort()) {
    const pairs = rounds.map((round) => round.get(tool));
    recordRounds(report, tool, pairs);
    if (pairs[0].base.facts && pairs[0].head.facts) report.tools.compared += 1;

    const reran = reruns.some((round) => round.has(tool));
    if (reran) report.tools.rerun.push(tool);
    const moved = reran ? votedMoves(report, tool, pairs, noise) : firstRunMoves(report, tool, pairs[0]);
    labelPropagated(moved);
    report.moved.push(...moved.sort((a, b) => (order(a) < order(b) ? -1 : 1)));
  }
  return report;
}

if (import.meta.main) {
  const [command, runDir, ...rest] = process.argv.slice(2);
  const noiseAt = rest.indexOf('--noise');
  const noise = noiseAt === -1 ? new Set() : parseNoise(readFileSync(rest[noiseAt + 1], 'utf8'));
  const rounds = loadRun(runDir);

  if (command === 'rerun-set') {
    process.stdout.write(
      rerunSet(rounds[0], noise)
        .map((tool) => `${tool}\n`)
        .join(''),
    );
  } else if (command === 'report') {
    const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
    const report = buildReport(rounds, { mode: manifest.mode, noise });
    writeFileSync(join(runDir, 'diff.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(runDir, 'diff.md'), renderMarkdown(report, manifest));
    if (manifest.mode === 'aa') writeFileSync(join(runDir, 'noise.tsv'), noiseTsv(report));
    process.stdout.write(renderText(report, manifest));
  } else {
    console.error('usage: compare-diff.mjs <rerun-set|report> <run-dir> [--noise <tsv>]');
    process.exit(2);
  }
}
