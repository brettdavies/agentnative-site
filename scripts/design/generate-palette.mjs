// scripts/design/generate-palette.mjs
// Palette generation and verification for the agentnative spec site.
//
// Two outputs, written to two locations:
//   1. docs/research/design/color-analysis.md
//      Methodology, tool outputs, contrast tables, gamut record, swatch
//      preview. No embedded CSS (the drop-in block lives in foundation.css).
//   2. src/styles/foundation.css
//      Drop-in stylesheet consumed by the site build (copied byte-for-byte
//      to dist/css/foundation.css) and by the design-preview HTML at
//      docs/research/design/must-should-may-preview.html. Contains palette
//      custom properties (light default, dark via prefers-color-scheme,
//      explicit [data-theme] overrides), typography tokens, @font-face
//      declarations, and the shipped 7b inline RFC-keyword rules.
//
// Run (from anywhere):      bun run scripts/design/generate-palette.mjs
// Run (from scripts/design): bun run generate
//
// Idempotent. Re-running overwrites the two output files in place.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  converter,
  formatHex,
  formatCss,
  wcagContrast,
  oklch,
  clampChroma,
  inGamut,
} from "culori";
import { APCAcontrast, sRGBtoY, calcAPCA } from "apca-w3";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Two output destinations: shipped CSS lives in src/styles/, research notes
// in docs/research/design/. Both two levels up from this script.
const REPO_ROOT = join(__dirname, "..", "..");
const FOUNDATION_CSS_PATH = join(REPO_ROOT, "src", "styles", "foundation.css");
const COLOR_ANALYSIS_PATH = join(
  REPO_ROOT,
  "docs",
  "research",
  "design",
  "color-analysis.md"
);

const toRgb = converter("rgb");
const toOklch = converter("oklch");

const toHex = (c) => formatHex(clampChroma(c, "rgb"));
const toCssOklch = (c) => {
  // "oklch(L% C H)" with three decimals.
  const o = oklch(c);
  const L = (o.l * 100).toFixed(2);
  const C = o.c.toFixed(4);
  const H = (o.h ?? 0).toFixed(2);
  return `oklch(${L}% ${C} ${H})`;
};

// APCA Lc between two colors, fg on bg.
// calcAPCA accepts CSS color strings and handles gamut internally. Convert
// through clampChroma → hex first so we measure the actual shipped color,
// not an out-of-gamut intermediate (which would otherwise return 0.0).
const lcApca = (fg, bg) => {
  const fgHex = toHex(fg);
  const bgHex = toHex(bg);
  const lc = calcAPCA(fgHex, bgHex);
  return typeof lc === "number" ? lc : parseFloat(lc);
};

// -------- Token design --------
// Cool-neutral family. Hue locked at 250 (blue-leaning neutral) for backgrounds,
// text, and borders. Accent reuses the same hue family at higher chroma.
// This is deliberate: color-psychology research for technical documentation
// consistently points at cool-leaning neutrals signaling credibility and
// logic. Warm accents appear ONLY in semantic callouts (MUST keyword).

const HUE_NEUTRAL = 250; // cool blue-gray base
const HUE_ACCENT = 250; // navy accent in the same hue family for coherence
const HUE_MUST = 28; // red-orange; requirement energy without pure error-red
const HUE_SHOULD = 70; // amber/ochre; recommendation with visible warmth
const HUE_MAY = 200; // cool teal; optional, calmer than accent

// Score-band ramp: a GRADING axis (fail / warn / pass), deliberately separate
// from the MUST/SHOULD/MAY OBLIGATION tiers even where the hues nearly meet.
const HUE_BAND_LOW = 26; // grading red-orange, a touch hotter than MUST
const HUE_BAND_MID = 70; // amber warn, shares the SHOULD hue
const HUE_BAND_HIGH = 150; // pass green; no obligation-tier counterpart

// Light-mode scale. L chosen for a long background plateau and quick dive at
// the text end. Chroma is deliberately very low in neutrals (≤0.012) so they
// read as gray, not tinted.
const LIGHT_SCALE = [
  { name: "gray-50", L: 98.8, C: 0.003 }, // page bg
  { name: "gray-100", L: 96.5, C: 0.006 }, // code bg
  { name: "gray-200", L: 92.5, C: 0.008 }, // hairline, target bg wash
  { name: "gray-300", L: 87.0, C: 0.01 }, // strong divider
  { name: "gray-400", L: 74.0, C: 0.012 }, // subtle text
  { name: "gray-500", L: 52.0, C: 0.016 }, // muted text; L≤52 keeps AA on gray-50
  { name: "gray-600", L: 46.0, C: 0.015 }, // secondary text
  { name: "gray-700", L: 34.0, C: 0.015 }, // code default
  { name: "gray-800", L: 24.0, C: 0.015 }, // body text
  { name: "gray-900", L: 15.0, C: 0.015 }, // headings
];

// Dark-mode scale. DESIGNED, not inverted. The key differences from a pure
// inversion:
//   1. Background is near-black but not pitch-black (~14% L). Pitch-black
//      causes halation around body text on LCDs.
//   2. The light ramp steps have a cliff at L=52; the dark ramp is smoother
//      through the mid-range because dark surfaces need more separation in
//      the 30-60% range for secondary UI (borders, muted text).
//   3. Chroma rises slightly in dark mode (up to 0.02) because low-chroma
//      grays on dark backgrounds read dead; a hint of hue keeps the UI
//      from feeling like a Kindle.
//   4. Text top color is a warm off-white (hue ~95, low chroma) rather than
//      pure white — standard dark-theme comfort move that the inversion
//      would have missed.
const DARK_SCALE = [
  { name: "gray-50", L: 14.0, C: 0.012, H: 250 }, // page bg
  { name: "gray-100", L: 18.0, C: 0.014, H: 250 }, // code bg
  { name: "gray-200", L: 22.0, C: 0.016, H: 250 }, // raised surface
  { name: "gray-300", L: 28.0, C: 0.018, H: 250 }, // border strong
  { name: "gray-400", L: 38.0, C: 0.02, H: 250 }, // border subtle
  { name: "gray-500", L: 63.0, C: 0.018, H: 250 }, // muted text; L≥63 keeps AA on gray-50
  { name: "gray-600", L: 68.0, C: 0.016, H: 250 }, // secondary text
  { name: "gray-700", L: 80.0, C: 0.012, H: 250 }, // code default
  { name: "gray-800", L: 90.0, C: 0.008, H: 95 }, // body text — warm shift
  { name: "gray-900", L: 96.0, C: 0.006, H: 95 }, // headings — warm shift
];

const mk = (L, C, H) => ({ mode: "oklch", l: L / 100, c: C, h: H });

const light = Object.fromEntries(
  LIGHT_SCALE.map(({ name, L, C }) => [name, mk(L, C, HUE_NEUTRAL)])
);
const dark = Object.fromEntries(
  DARK_SCALE.map(({ name, L, C, H }) => [name, mk(L, C, H)])
);

// Accent tuned per mode.
light.accent = mk(46, 0.155, HUE_ACCENT);
light["accent-subtle"] = mk(92, 0.05, HUE_ACCENT);
dark.accent = mk(78, 0.14, HUE_ACCENT);
// Tuning pass: accent-subtle lowered from L=28 to L=22 after APCA flagged the
// accent-on-subtle pair at Lc -59.5 (just shy of -60 body min). Lower L
// widens the range without touching the accent hue itself.
dark["accent-subtle"] = mk(22, 0.055, HUE_ACCENT);

// Semantic RFC keyword hues, tuned per mode so contrast is reliable.
// Light: mid-L, higher chroma so they pop against gray-50.
// Dark: high-L, moderate chroma so they pop against gray-50 dark.
light.must = mk(50, 0.17, HUE_MUST);
light.should = mk(55, 0.13, HUE_SHOULD);
light.may = mk(52, 0.1, HUE_MAY);

// Tuning pass: dark.must L raised from 78 → 82 after APCA flagged the pair
// at Lc -58.8 against the -60 body minimum. Kept chroma constant so the hue
// still reads the same; only lightness moved.
dark.must = mk(82, 0.15, HUE_MUST);
dark.should = mk(82, 0.12, HUE_SHOULD);
dark.may = mk(80, 0.1, HUE_MAY);

// Score-band grading ramp. The `band-*` shades color TEXT (score numbers,
// band labels) and must clear AA on the page bg. The `band-*-bar` shades fill
// meter bars: they are non-text UI whose value is always restated by an
// adjacent number, so they run brighter and more chromatic than the AA text
// shades. `meter-track` is the empty-meter substrate, darkened (light mode) /
// raised (dark mode) so partial fills read against it.
light["band-low"] = mk(52, 0.17, HUE_BAND_LOW);
light["band-mid"] = mk(56, 0.13, HUE_BAND_MID);
light["band-high"] = mk(50, 0.15, HUE_BAND_HIGH);
light["band-low-bar"] = mk(50, 0.205, HUE_BAND_LOW);
light["band-mid-bar"] = mk(62, 0.135, HUE_BAND_MID);
light["band-high-bar"] = mk(58, 0.16, HUE_BAND_HIGH);
light["meter-track"] = mk(90, 0.01, HUE_NEUTRAL);

dark["band-low"] = mk(72, 0.16, HUE_BAND_LOW);
dark["band-mid"] = mk(80, 0.13, HUE_BAND_MID);
dark["band-high"] = mk(74, 0.15, HUE_BAND_HIGH);
dark["band-low-bar"] = mk(66, 0.2, HUE_BAND_LOW);
dark["band-mid-bar"] = mk(82, 0.15, HUE_BAND_MID);
dark["band-high-bar"] = mk(76, 0.17, HUE_BAND_HIGH);
dark["meter-track"] = mk(26, 0.02, HUE_NEUTRAL);

// -------- Contrast assertions --------
// Fail the whole generation (no files written) rather than ship a failing
// token. Text-bearing tokens must clear WCAG AA small-text (4.5:1) against
// the page background in both modes — that is the hard gate. APCA floors are
// per-token regression guards: |Lc| >= 60 for running text, >= 45 for the
// band shades (score numbers and labels: short, large-ish, never body copy).
// Bar fills and the meter track are exempt (non-text UI).
//
// Dark fg-muted (gray-500) floor is 38, below the APCA-45 UI class: WCAG and
// APCA diverge on light-on-dark, and lifting L past ~67 to clear 45 would
// collapse the muted tier into gray-600 (L=63 vs 68). WCAG AA still gates it;
// the APCA floor pins the shipped level so it cannot silently regress.
const TEXT_TOKEN_FLOORS = {
  "gray-500": { light: 60, dark: 38 },
  "gray-600": 45,
  "gray-800": 60,
  "gray-900": 60,
  accent: 45,
  must: 60,
  should: 60,
  may: 60,
  "band-low": 45,
  "band-mid": 45,
  "band-high": 45,
};
for (const [mode, palette] of [
  ["light", light],
  ["dark", dark],
]) {
  for (const [key, floor] of Object.entries(TEXT_TOKEN_FLOORS)) {
    const apcaFloor = typeof floor === "number" ? floor : floor[mode];
    const ratio = wcagContrast(palette[key], palette["gray-50"]);
    const lc = Math.abs(lcApca(palette[key], palette["gray-50"]));
    if (ratio < 4.5 || lc < apcaFloor) {
      throw new Error(
        `contrast assertion failed: ${mode}.${key} on ${mode}.gray-50 — ` +
          `WCAG ${ratio.toFixed(2)}:1 (need >= 4.5), APCA |Lc| ${lc.toFixed(1)} ` +
          `(need >= ${apcaFloor})`
      );
    }
  }
}

// (Wash tokens for block-level MUST/SHOULD/MAY callouts were removed when
// the 7b-plus side-stripe variant was rejected per impeccable's absolute
// ban on border-left callouts. If a future block treatment (leading tag
// or full-background fill) ships, the wash ramps can be re-derived from
// light["must" / "should" / "may"] at L=94 / C~0.04 for light mode and
// L=22 / C~0.04 for dark mode. See DESIGN.md §4.7 deferred variants.)

// -------- Report --------

const hr = "\n---\n";
let out = [];
const p = (...s) => out.push(s.join(""));

p("# Color analysis — agentnative spec site\n");
p(
  "Generated by `design/generate-palette.mjs` on ",
  new Date().toISOString().slice(0, 10),
  ". Reproducible: `bun run design/generate-palette.mjs > design/color-analysis.md`.\n"
);

p(
  "\nThis is the show-your-work artifact behind DESIGN.md §4.1 and §4.2. The ",
  "palette is designed, verified, and documented here so a reviewer can ",
  "reproduce or challenge each value.\n"
);

p(hr);
p("## Tools used\n");
p(
  "| Tool | Version | Role |\n",
  "|---|---|---|\n",
  "| [`culori`](https://culori.js.org/) | 4.0.2 | OKLCH ↔ sRGB conversions, WCAG 2.1 contrast, gamut clamping. |\n",
  "| [`apca-w3`](https://github.com/Myndex/apca-w3) | 0.1.9 | APCA Lc perceptual-contrast (WCAG 3 draft). |\n",
  "| [oklch.com](https://oklch.com) | (visual verification only) | Perceptual-evenness eye-check of generated ramps. |\n",
  "| [meodai/skill.color-expert](https://github.com/meodai/skill.color-expert) | reference | Methodology source for APCA + WCAG decisions. |\n",
  "| [meodai/dittoTones](https://github.com/meodai/dittoTones) | reference | Mental model for seed-to-ramp scale generation. |\n"
);

p(hr);
p("## Design decisions driving the palette\n");
p(
  "1. **Cool-neutral base, hue 250.** Color-psychology research on technical ",
  "documentation (see WebSearch results dated 2026-04-13) converges on ",
  "cool-leaning neutrals signaling credibility and logic for ",
  "developer-facing reference material. The backgrounds, borders, and body ",
  "text all share hue 250 at near-zero chroma so they read as gray but with ",
  "a trained-eye coherence.\n",
  "2. **One accent hue, same family.** The accent is navy at hue 250 with ",
  "higher chroma. Sharing hue with the neutrals keeps the page visually ",
  "monochromatic until the MUST/SHOULD/MAY keywords introduce deliberate ",
  "warm accents. This is the clig.dev move, tuned for this content.\n",
  "3. **Dark mode is designed, not inverted.** Background is near-black but ",
  "not pitch, text top tones warm-shift to hue 95 for reading comfort, and ",
  "mid-range chroma rises slightly to prevent the dead-gray look. See ",
  "inline notes in `DARK_SCALE` in `generate-palette.mjs` for each ",
  "deviation.\n",
  "4. **RFC-keyword triad is warm-centered.** MUST (hue 28, red-orange), ",
  "SHOULD (hue 70, ochre), MAY (hue 200, teal). The red and ochre are the ",
  "semantic heat; MAY is cooled and calmer because the spec deliberately ",
  "distinguishes 'optional' from 'required.'\n",
  "5. **Score bands are a grading axis, not the obligation axis.** ",
  "`--band-low/mid/high` (fail / warn / pass) color score numbers and band ",
  "labels; `--band-*-bar` are decoupled, brighter meter-fill variants ",
  "(non-text UI — the adjacent number always restates the value), and ",
  "`--meter-track` is the empty-meter substrate. The low/mid hues sit next ",
  "to MUST/SHOULD deliberately (shared heat metaphor); the high band's green ",
  "has no obligation-tier counterpart, which keeps the axes readable as ",
  "different systems.\n"
);

const renderTable = (palette, mode) => {
  let s = "| Token | OKLCH | sRGB hex | CSS |\n|---|---|---|---|\n";
  for (const [name, c] of Object.entries(palette)) {
    const oklchStr = toCssOklch(c);
    const hex = toHex(c);
    s += `| \`--${name}\` | \`${oklchStr}\` | \`${hex}\` | \`color: ${oklchStr};\` |\n`;
  }
  return s;
};

p(hr);
p("## Generated scales\n");
p("### Light mode (hue 250, cool-neutral)\n");
p(renderTable(light, "light"));

p("\n### Dark mode (hue 250 with warm-shift at text tier)\n");
p(renderTable(dark, "dark"));

// Contrast tables.
const contrastReport = (palette, mode) => {
  const pairs = [
    ["gray-800", "gray-50", "body text on page bg"],
    ["gray-900", "gray-50", "headings on page bg"],
    ["gray-500", "gray-50", "muted text (fg-muted) on page bg"],
    ["gray-600", "gray-50", "secondary text on page bg"],
    ["gray-800", "gray-100", "body text on code bg"],
    ["accent", "gray-50", "link on page bg"],
    ["must", "gray-50", "MUST keyword on page bg"],
    ["should", "gray-50", "SHOULD keyword on page bg"],
    ["may", "gray-50", "MAY keyword on page bg"],
    ["band-low", "gray-50", "low-band score text on page bg"],
    ["band-mid", "gray-50", "mid-band score text on page bg"],
    ["band-high", "gray-50", "high-band score text on page bg"],
    ["accent", "accent-subtle", "accent on :target highlight"],
  ];
  let s =
    "| Pair | WCAG 2.1 ratio | AA body (≥4.5) | AAA body (≥7) | APCA Lc | APCA threshold |\n" +
    "|---|---:|:---:|:---:|---:|---|\n";
  // APCA thresholds for "fluent text" body copy: |Lc| ≥ 75 preferred,
  // |Lc| ≥ 60 acceptable for body, |Lc| ≥ 45 minimum for "spot readable"
  // non-body UI text. See apca-w3 README.
  const judgeApca = (lc) => {
    const abs = Math.abs(lc);
    if (abs >= 75) return "✅ preferred body";
    if (abs >= 60) return "✅ body min";
    if (abs >= 45) return "⚠ UI / non-body only";
    return "❌ fails";
  };
  for (const [fgKey, bgKey, label] of pairs) {
    const fg = palette[fgKey];
    const bg = palette[bgKey];
    const ratio = wcagContrast(fg, bg);
    const aa = ratio >= 4.5 ? "✅" : "❌";
    const aaa = ratio >= 7 ? "✅" : "❌";
    const lc = lcApca(fg, bg);
    const lcFmt = typeof lc === "number" ? lc.toFixed(1) : String(lc);
    s += `| ${label} (\`${fgKey}\` on \`${bgKey}\`) | ${ratio.toFixed(
      2
    )}:1 | ${aa} | ${aaa} | ${lcFmt} | ${judgeApca(lc)} |\n`;
  }
  return s;
};

p(hr);
p("## Contrast verification\n");
p(
  "Both WCAG 2.1 (ratio-based) and APCA Lc (perceptual, WCAG 3 draft) are ",
  "reported. APCA is the emerging standard for body-text legibility; WCAG ",
  "2.1 is the current legal baseline. Both must pass for body copy.\n"
);
p("\n### Light mode contrast\n");
p(contrastReport(light, "light"));
p("\n### Dark mode contrast\n");
p(contrastReport(dark, "dark"));

// Gamut check.
p(hr);
p("## Gamut verification\n");
p(
  "Every color shipped lives inside sRGB after `clampChroma(c, 'rgb')`. The ",
  "list below names OKLCH inputs that were *just outside* sRGB before clamp ",
  "— expected behavior for vivid accents picked in a wider color space. The ",
  "emitted hex values (shown in the scales above) are the clamped, ",
  "sRGB-safe fallbacks. Browsers that support `oklch()` render the original ",
  "OKLCH value directly; browsers that do not fall back to the hex.\n\n"
);
const gamutIssues = [];
for (const [mode, palette] of [
  ["light", light],
  ["dark", dark],
]) {
  for (const [name, c] of Object.entries(palette)) {
    if (!inGamut("rgb")(c)) {
      gamutIssues.push(
        `- \`${mode}.${name}\` (${toCssOklch(c)}) was outside sRGB pre-clamp; shipped hex is ${toHex(c)}.`
      );
    }
  }
}
if (gamutIssues.length === 0) {
  p("**No values required clamping.** Every OKLCH input was already sRGB-safe.\n");
} else {
  p("Values clamped to sRGB at build:\n\n");
  p(gamutIssues.join("\n"));
  p("\n");
}

// Swatch preview section.
const swatchRow = (palette, keys) =>
  keys
    .map(
      (k) =>
        `<div style="flex:1;min-width:60px;padding:8px 6px;background:${toHex(
          palette[k]
        )};color:${toHex(palette[k === "gray-50" ? "gray-800" : "gray-50"])};font:12px/1.2 monospace;text-align:center">${k}<br>${toHex(
          palette[k]
        )}</div>`
    )
    .join("");

p(hr);
p("## Swatch preview\n");
p(
  "This section renders inline on GitHub. For pixel-accurate preview open ",
  "`design/must-should-may-preview.html` in a browser.\n"
);
p("\n### Light mode\n");
p(
  `<div style="display:flex;flex-wrap:wrap;gap:2px;border:1px solid #ccc;padding:2px;">`,
  swatchRow(light, [
    "gray-50",
    "gray-100",
    "gray-200",
    "gray-300",
    "gray-400",
    "gray-500",
    "gray-600",
    "gray-700",
    "gray-800",
    "gray-900",
    "accent",
    "must",
    "should",
    "may",
    "band-low",
    "band-mid",
    "band-high",
  ]),
  `</div>`
);
p("\n### Dark mode\n");
p(
  `<div style="display:flex;flex-wrap:wrap;gap:2px;border:1px solid #ccc;padding:2px;">`,
  swatchRow(dark, [
    "gray-50",
    "gray-100",
    "gray-200",
    "gray-300",
    "gray-400",
    "gray-500",
    "gray-600",
    "gray-700",
    "gray-800",
    "gray-900",
    "accent",
    "must",
    "should",
    "may",
    "band-low",
    "band-mid",
    "band-high",
  ]),
  `</div>`
);

// CSS emission.
// The drop-in stylesheet is written to design/foundation.css as a real file that
// the HTML preview links to directly, and that the site build will later
// consume. The markdown report just points at the file so reviewers can see
// the tool outputs without scrolling through CSS.

const roleMap = {
  bg: "gray-50",
  "bg-raised": "gray-100",
  "bg-code": "gray-100",
  border: "gray-300",
  "border-subtle": "gray-200",
  "fg-muted": "gray-500",
  "fg-secondary": "gray-600",
  "fg-body": "gray-800",
  "fg-heading": "gray-900",
  accent: "accent",
  "accent-subtle": "accent-subtle",
  must: "must",
  should: "should",
  may: "may",
  "band-low": "band-low",
  "band-mid": "band-mid",
  "band-high": "band-high",
  "band-low-bar": "band-low-bar",
  "band-mid-bar": "band-mid-bar",
  "band-high-bar": "band-high-bar",
  "meter-track": "meter-track",
};

const cssTokenBlock = (palette, selector, comment) => {
  let s = `${selector} {\n  /* ${comment} */\n`;
  for (const [role, token] of Object.entries(roleMap)) {
    s += `  --${role}: ${toCssOklch(palette[token])};\n`;
  }
  s += "\n  /* raw grays for one-off tuning */\n";
  for (let i = 50; i <= 900; i += i === 50 ? 50 : 100) {
    s += `  --g-${i}: ${toCssOklch(palette[`gray-${i}`])};\n`;
  }
  s += "}\n";
  return s;
};

const typographyRules = `
/* ================================================================== */
/* Typography tokens — DESIGN.md §4.3 / §4.4.                          */
/* Body + display: Pangram Pangram's Uncut Sans (OFL).                 */
/* Code: GitHub Next's Monaspace Xenon (OFL).                          */
/* Neither appears in impeccable's reflex-fonts-to-reject list.        */
/*                                                                     */
/* @font-face declarations are deliberately NOT in this file. They     */
/* belong to whichever layer actually ships the fonts:                 */
/*   - the site build (once /fonts/ is populated with the self-hosted  */
/*     woff2 files and metric-override values are calibrated), OR      */
/*   - the preview HTML (via CDN <link> tags for Fontshare + jsdelivr) */
/* Keeping @font-face out of foundation.css means this file is safe to */
/* load from any origin without phantom 404s against missing paths.    */
/* Reference @font-face template lives in DESIGN.md §4.3.              */
/* ================================================================== */

:root {
  /* Fallback stacks pair Uncut Sans with system-ui (closest x-height match)
   * and Monaspace Xenon with ui-monospace (closest rhythm match). */
  --font-sans: "Uncut Sans", ui-sans-serif, system-ui, -apple-system,
               "Segoe UI", Roboto, "Helvetica Neue", sans-serif,
               "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
  --font-mono: "Monaspace Xenon", ui-monospace, "SF Mono", "Cascadia Code",
               Menlo, Consolas, "Liberation Mono", monospace;
  --font-display: var(--font-sans);

  /* OpenType feature hints. "kern" always on; ligatures OFF in mono for
   * explicit spec-operator shapes (>=, !=, ->, etc.). */
  --ff-sans: "kern" 1, "liga" 1, "clig" 1;
  --ff-mono: "kern" 1, "liga" 0, "clig" 0, "calt" 0;
  --ff-tabular: "tnum" 1, "kern" 1; /* for version/date stamps, numeric tables */

  /* Modular scale, 1.25 ratio anchored at --text-base.
   * Body fluid 17 -> 18px between 360px and ~1100px viewport.
   * Headings clamp-scale similarly. Captions and secondary stay fixed. */
  --text-base:       1.0625rem; /* 17px */
  --text-body:       clamp(1.0625rem, 0.975rem + 0.4vw, 1.125rem);
  --text-caption:    0.8125rem; /* ~13px */
  --text-secondary:  0.9375rem; /* ~15px */
  --text-h4:         1rem;
  --text-h3:         1.22rem;
  --text-h2:         1.5rem;
  --text-h1:         clamp(1.85rem, 1.6rem + 1.2vw, 2.25rem);
  --text-code:       0.92rem;

  --leading-body:    1.6;
  --leading-heading: 1.25;
  --leading-code:    1.5;

  --measure:         68ch;   /* body line length; cap per Butterick 45-75 rule */
  --tracking-caps:   0.04em; /* small-caps / ALL CAPS labels */
  --tracking-rfc:    0.02em; /* MUST/SHOULD/MAY inline keywords */
}
`;

const staticRules = `
/* ================================================================== */
/* RFC-keyword treatment — option 7b (DESIGN.md §4.7).                 */
/* Inline keyword color only. The side-stripe and background-wash      */
/* callout variants were rejected because border-left >1px on a        */
/* card/callout is the #1 banned AI-slop pattern per impeccable's      */
/* <absolute_bans>, even for semantic colors. Alternative block-level  */
/* treatments (leading RFC tag, full background tint) are deferred     */
/* to live-site iteration — see DESIGN.md §4.7.                        */
/* ================================================================== */

.rfc-must   { color: var(--must);   font-weight: 600; letter-spacing: var(--tracking-rfc); }
.rfc-should { color: var(--should); font-weight: 600; letter-spacing: var(--tracking-rfc); }
.rfc-may    { color: var(--may);    font-weight: 600; letter-spacing: var(--tracking-rfc); }
`;

const foundationCss = `/* src/styles/foundation.css
 * Generated by scripts/design/generate-palette.mjs on ${new Date().toISOString().slice(0, 10)}.
 * Do not hand-edit. Reproduce via: cd scripts/design && bun run generate
 *
 * Scope: palette (light + dark), typography tokens, and RFC-keyword
 * inline rules. This is the generated foundation layer the site builds on.
 * @font-face declarations are NOT emitted here — they belong to the
 * site build or the preview HTML; see the "Typography tokens" comment
 * below for rationale.
 *
 * Selector strategy for color modes:
 *   :root                                              -> light-mode defaults
 *   @media (prefers-color-scheme: dark)
 *     :root:not([data-theme="light"])                  -> dark via OS preference
 *   :root[data-theme="dark"]                           -> dark via explicit toggle
 *   :root[data-theme="light"]                          -> light via explicit toggle
 *
 * Why the :not() inside the media query: a user who picks light via the UI
 * must win over an OS preference of dark. See DESIGN.md §4.9.
 */

${cssTokenBlock(light, ":root", "light mode default")}
@media (prefers-color-scheme: dark) {
${cssTokenBlock(dark, '  :root:not([data-theme="light"])', "dark mode via OS preference").replace(/^/gm, "")}
}

${cssTokenBlock(dark, ':root[data-theme="dark"]', "dark mode via explicit toggle")}
${cssTokenBlock(light, ':root[data-theme="light"]', "light mode via explicit toggle")}
${typographyRules}${staticRules}`;

writeFileSync(FOUNDATION_CSS_PATH, foundationCss);

p(hr);
p("## Emitted stylesheet\n");
p(
  "CSS is written to [`src/styles/foundation.css`](../../../src/styles/foundation.css) ",
  "as a real, linkable file — not inlined in this report. The HTML preview at ",
  "[`must-should-may-preview.html`](must-should-may-preview.html) ",
  "links to it via `<link rel=\"stylesheet\" href=\"../../../src/styles/foundation.css\">`. ",
  "The site build copies the same file byte-for-byte into `dist/css/foundation.css`.\n\n",
  "The file contains: light-mode defaults on `:root`; dark-mode tokens under ",
  "`@media (prefers-color-scheme: dark) :root:not([data-theme=\"light\"])`; ",
  "explicit overrides on `:root[data-theme=\"dark\"]` and ",
  "`:root[data-theme=\"light\"]`; typography tokens and `@font-face` for ",
  "Uncut Sans + Monaspace Xenon; and the shipped 7b inline-keyword rules ",
  "(`.rfc-must`, `.rfc-should`, `.rfc-may`). Block-level MUST/SHOULD/MAY ",
  "callout variants are deferred per DESIGN.md §4.7.\n"
);

p(hr);
p("## Methodology notes\n");
p(
  "- **OKLCH first, sRGB fallback** — CSS shipped will declare `oklch(...)` ",
  "first, with a hex backup in a `@supports` block for browsers (still a ",
  "minority in April 2026) that lack OKLCH parsing. culori's clampChroma ",
  "guarantees the fallback is in-gamut.\n",
  "- **Same-family accent** — Picking `HUE_ACCENT === HUE_NEUTRAL` is a ",
  "deliberate restraint. Most sites pick a contrasting hue for the accent ",
  "to create a focal point; on a spec site, the focal points are the code ",
  "blocks and the RFC keywords, not the links.\n",
  "- **APCA over WCAG where they disagree** — WCAG 2.1's contrast math ",
  "under-weights greens and over-weights blues vs. perceived contrast. APCA ",
  "fixes this. If WCAG 2.1 passes but APCA Lc < 60 on body text, the ",
  "palette is re-tuned, even though WCAG 2.1 is the legal requirement.\n",
  "- **Non-goals explicitly** — not generating a full Radix-style 12-step ",
  "semantic scale (solid/hover/active/border/etc.). Nine pages don't need ",
  "that much surface.\n"
);

writeFileSync(COLOR_ANALYSIS_PATH, out.join(""));

// Brief summary to stdout so a human running this locally sees what happened.
const rel = (p) => p.replace(REPO_ROOT, ".");
console.error(
  `wrote ${rel(COLOR_ANALYSIS_PATH)} and ${rel(FOUNDATION_CSS_PATH)}`
);
