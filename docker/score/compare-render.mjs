// Text and markdown renderings of the report compare-diff.mjs builds. The
// text form goes to the terminal; the markdown form is the table pasted into
// pull request descriptions.

const sides = (report) => (report.mode === 'aa' ? ['run 1', 'run 2'] : ['base', 'head']);
/** What the two sides are: two builds, or in an A/A two runs of one build. */
const unit = (report) => (report.mode === 'aa' ? 'run' : 'build');
const moves = (report) => (report.mode === 'aa' ? 'that differ' : 'moved');
const short = (commit) => commit.slice(0, 12);
const plain = (value) => (value === null || value === undefined ? 'null' : String(value));

/** A row field as `value`, or `base -> head` when the move changed it. */
function fieldChange(move, field, arrow) {
  const [base, head] = [move.base, move.head].map((value) => (value ? plain(value[field]) : '(absent)'));
  return move.fields.includes(field) && base !== head ? `${base} ${arrow} ${head}` : head;
}

const note = (move) => {
  const parts = (move.propagated_from ?? []).map((audit) => `propagated from \`${audit}\``);
  if (move.change !== 'changed') parts.unshift(`row ${move.change}`);
  return parts.join('; ');
};

function showSlot(slot) {
  if (slot.absent) return '(row absent)';
  if ('value' in slot) return plain(slot.value);
  return `${slot.status}, confidence ${slot.confidence}, evidence: ${plain(slot.evidence)}`;
}

/**
 * Per-run results as letters, so eight results fit one line: the first run,
 * then each rerun, `-` where the tool did not score, and the majority.
 */
function lettered(runs) {
  const letters = new Map();
  const letter = (slot) => {
    if (slot === null) return '-';
    const key = JSON.stringify(slot);
    if (!letters.has(key)) letters.set(key, String.fromCharCode(65 + letters.size));
    return letters.get(key);
  };
  const line = (side) =>
    `${[side.initial, ...side.reruns].map(letter).join(' ')} (majority ${side.majority ? letter(side.majority) : 'none'})`;
  const [base, head] = [line(runs.base), line(runs.head)];
  return { base, head, legend: [...letters].map(([key, name]) => `${name} = ${showSlot(JSON.parse(key))}`) };
}

/** Whether every run under each build scored and returned the same result. */
const unanimous = (runs) =>
  [runs.base, runs.head].every((side) => {
    const slots = [side.initial, ...side.reruns].map((slot) => JSON.stringify(slot));
    return side.initial !== null && new Set(slots).size === 1;
  });

function title(report, manifest) {
  const { base, head } = manifest.builds;
  return report.mode === 'aa'
    ? `A/A of ${short(base.commit)}: one build, run twice`
    : `Before/after: base ${short(base.commit)}, head ${short(head.commit)}`;
}

function toolCounts(report) {
  const { selected, compared, rerun } = report.tools;
  const reran = rerun.length > 0 ? `, ${rerun.length} rerun three times (${rerun.join(', ')})` : '';
  return `${selected} tools selected, ${compared} scored under both ${unit(report)}s${reran}`;
}

const neither = (report) => report.not_scored.filter((t) => t.base !== 'ok' && t.head !== 'ok');
const oneBuild = (report) => report.not_scored.filter((t) => t.base === 'ok' || t.head === 'ok');
const round = (n) => (n === 0 ? 'first run' : `rerun ${n}`);

function textTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((cells) => cells[column].length)));
  return rows.map((cells) => `  ${cells.map((text, column) => text.padEnd(widths[column])).join('  ')}`.trimEnd());
}

/** A moved row already prints both values, so runs that all agree need only a count. */
function textRuns(entry, [baseName, headName], moved = false) {
  if (moved && unanimous(entry.runs)) {
    const agree = (side) => `${side.reruns.length + 1} of ${side.reruns.length + 1} agree`;
    return [`      runs  ${baseName}: ${agree(entry.runs.base)}  ${headName}: ${agree(entry.runs.head)}`];
  }
  const { base, head, legend } = lettered(entry.runs);
  return [`      runs  ${baseName}: ${base}  ${headName}: ${head}`, ...legend.map((line) => `        ${line}`)];
}

export function renderText(report, manifest) {
  const names = sides(report);
  const out = [title(report, manifest), `image ${manifest.image.id}, network ${manifest.network}`, toolCounts(report)];
  const section = (heading, lines) => out.push('', heading, ...lines);

  const moved = [];
  for (const move of report.moved) {
    const cells = [
      move.tool,
      move.id,
      move.audit_id,
      fieldChange(move, 'status', '->'),
      fieldChange(move, 'confidence', '->'),
    ];
    moved.push({ cells: [...cells, note(move)], move });
  }
  const table = textTable([['TOOL', 'ID', 'AUDIT_ID', 'STATUS', 'CONFIDENCE', 'NOTE'], ...moved.map((m) => m.cells)]);
  const movedLines = moved.length > 0 ? [table[0]] : [];
  moved.forEach(({ move }, index) => {
    movedLines.push(table[index + 1]);
    if (move.fields.includes('evidence')) {
      movedLines.push(`      evidence ${names[0]}: ${plain(move.base?.evidence)}`);
      movedLines.push(`      evidence ${names[1]}: ${plain(move.head?.evidence)}`);
    }
    if (move.runs) movedLines.push(...textRuns(move, names, true));
  });
  section(
    `${report.mode === 'aa' ? 'Rows that differ between the two runs' : 'Moved rows'}: ${moved.length}`,
    movedLines,
  );

  const derived = report.derived_moved.map((d) => [d.tool, d.field, plain(d.base), plain(d.head)]);
  section(
    `Derived fields ${moves(report)}: ${derived.length}`,
    derived.length > 0 ? textTable([['TOOL', 'FIELD', ...names.map((name) => name.toUpperCase())], ...derived]) : [],
  );

  if (report.mode !== 'aa') {
    const perRun = (entry) => [
      `  ${entry.tool}  ${entry.id ?? entry.field}  ${entry.audit_id ?? ''}`.trimEnd(),
      ...textRuns(entry, names),
    ];
    const unstable = [...report.unstable, ...report.derived_unstable];
    section(`Unstable, no majority under one build: ${unstable.length}`, unstable.flatMap(perRun));
    section(`Re-measured, not moved: ${report.remeasured.length}`, report.remeasured.flatMap(perRun));
  }

  const bugs = report.harness_bugs.flatMap((bug) =>
    bug.derived.map((d) => `  ${bug.tool}  ${round(bug.round)}  ${d.field}  ${plain(d.base)} -> ${plain(d.head)}`),
  );
  section(`Harness bugs, a derived field moved where no row did: ${bugs.length}`, bugs);

  const absent = neither(report).map((t) => [t.tool, round(t.round), t.base, t.head]);
  section(
    `Did not run under either ${unit(report)}: ${absent.length}`,
    absent.length > 0 ? textTable([['TOOL', 'ROUND', ...names.map((name) => name.toUpperCase())], ...absent]) : [],
  );
  const failed = oneBuild(report).map((t) => [t.tool, round(t.round), t.base, t.head]);
  section(
    `Scoring failures under one ${unit(report)} only: ${failed.length}`,
    failed.length > 0 ? textTable([['TOOL', 'ROUND', ...names.map((name) => name.toUpperCase())], ...failed]) : [],
  );
  return `${out.join('\n')}\n`;
}

/**
 * Table-cell text: pipes escaped, newlines as breaks, and `<` escaped outside
 * code spans, where GitHub would otherwise drop it as an unknown tag.
 */
function cell(text) {
  const parts = String(text).split(/(`[^`]*`)/);
  const escaped = parts.map((part, index) => (index % 2 === 1 ? part : part.replaceAll('<', '&lt;')));
  return escaped.join('').replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function mdTable(header, rows) {
  if (rows.length === 0) return ['None.'];
  const line = (cells) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)];
}

const code = (text) => `\`${text}\``;

export function renderMarkdown(report, manifest) {
  const names = sides(report);
  const { base, head } = manifest.builds;
  const builds =
    report.mode === 'aa'
      ? `A/A of ${code(short(base.commit))}: one build, run twice.`
      : `Base ${code(short(base.commit))}, head ${code(short(head.commit))}.`;
  const out = [`${builds} Image ${code(manifest.image.id)}, network ${code(manifest.network)}. ${toolCounts(report)}.`];
  const section = (heading, lines) => out.push('', `### ${heading}`, '', ...lines);

  const evidence = (move) =>
    move.fields.includes('evidence')
      ? `${names[0]}: ${plain(move.base?.evidence)}\n${names[1]}: ${plain(move.head?.evidence)}`
      : '(unchanged)';
  section(
    `${report.mode === 'aa' ? 'Rows that differ between the two runs' : 'Moved rows'} (${report.moved.length})`,
    mdTable(
      ['tool', 'id', 'audit_id', 'status', 'confidence', 'evidence', 'note'],
      report.moved.map((move) => [
        move.tool,
        code(move.id),
        code(move.audit_id),
        fieldChange(move, 'status', '→'),
        fieldChange(move, 'confidence', '→'),
        evidence(move),
        note(move),
      ]),
    ),
  );

  section(
    `Derived fields ${moves(report)} (${report.derived_moved.length})`,
    mdTable(
      ['tool', 'field', ...names],
      report.derived_moved.map((d) => [d.tool, code(d.field), plain(d.base), plain(d.head)]),
    ),
  );

  if (report.mode !== 'aa') {
    const perRun = (verdict) => (entry) => {
      const runs = lettered(entry.runs);
      const subject = entry.field ? [code(entry.field), ''] : [code(entry.id), code(entry.audit_id)];
      return [entry.tool, ...subject, verdict, runs.base, runs.head, runs.legend.join('\n')];
    };
    const voted = [...report.moved, ...report.derived_moved].filter((move) => move.runs);
    const split = voted.filter((move) => !unanimous(move.runs));
    const rows = [
      ...split.map(perRun('moved')),
      ...report.unstable.map(perRun('unstable')),
      ...report.derived_unstable.map(perRun('unstable')),
      ...report.remeasured.map(perRun('not moved')),
    ];
    section(
      `Per-run results: first run, reruns 1 to 3, majority (${rows.length})`,
      mdTable(['tool', 'id or field', 'audit_id', 'verdict', `${names[0]} runs`, `${names[1]} runs`, 'values'], rows),
    );
    if (split.length < voted.length) {
      out.push('', 'A moved row or field not listed here returned one result in every run of each build.');
    }
  }

  section(
    `Harness bugs, a derived field moved where no row did (${report.harness_bugs.length})`,
    mdTable(
      ['tool', 'round', 'field', ...names],
      report.harness_bugs.flatMap((bug) =>
        bug.derived.map((d) => [bug.tool, round(bug.round), code(d.field), plain(d.base), plain(d.head)]),
      ),
    ),
  );
  const status = (t) => [t.tool, round(t.round), t.base, t.head];
  section(
    `Did not run under either ${unit(report)} (${neither(report).length})`,
    mdTable(['tool', 'round', ...names], neither(report).map(status)),
  );
  section(
    `Scoring failures under one ${unit(report)} only (${oneBuild(report).length})`,
    mdTable(['tool', 'round', ...names], oneBuild(report).map(status)),
  );
  return `${out.join('\n')}\n`;
}
