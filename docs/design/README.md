# docs/design/

Design artifacts for the agentnative spec site. Referenced from [`../DESIGN.md`](../DESIGN.md).

## Contents

| File                           | Role                                                                                         | Origin    |
| ------------------------------ | -------------------------------------------------------------------------------------------- | --------- |
| `color-analysis.md`            | Methodology report: culori + apca-w3 tool calls, palette tables, WCAG + APCA contrast, gamut log. | generated |
| `foundation.css`               | Drop-in stylesheet: palette + typography tokens + 7b inline-keyword rules. No `@font-face` (site-build concern — see docs/DESIGN.md §4.3). | generated |
| `must-should-may-preview.html` | Rendered preview of docs/DESIGN.md §4.3 typography and §4.7 keyword treatment; links `foundation.css`. | authored  |
| `README.md`                    | This file.                                                                                   | authored  |

The generator lives in [`../../scripts/design/`](../../scripts/design/) — generated outputs land here.

## Reproducing the generated files

```bash
cd scripts/design
bun install
bun run generate   # rewrites docs/design/color-analysis.md and docs/design/foundation.css
```

Or from the repo root:

```bash
bun run scripts/design/generate-palette.mjs
```

Open `must-should-may-preview.html` in any browser to see the shipped typography and keyword treatment rendered against
both color modes. The preview loads Uncut Sans from Fontshare and Monaspace Xenon from jsdelivr so the fonts render
without setting up `/fonts/` self-hosting first.

## Editing the foundation

All palette values and typography tokens live in `scripts/design/generate-palette.mjs`. Change the seed hue, a scale
step, or a type-scale token there, re-run `bun run generate`, and commit the script change and the updated outputs
together. `color-analysis.md` and `foundation.css` are generated files — do not hand-edit them. Production `@font-face`
declarations are **not** emitted by the generator; they belong to the site build so `foundation.css` stays safe to load
from any origin without phantom 404s against missing `/fonts/` paths.
