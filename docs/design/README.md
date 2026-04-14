# docs/design/

Design artifacts for the agentnative spec site. Referenced from [`../../DESIGN.md`](../../DESIGN.md).

## Contents

| File                           | Role                                                                              | Origin    |
| ------------------------------ | --------------------------------------------------------------------------------- | --------- |
| `color-analysis.md`            | Methodology report: tool calls, palette tables, WCAG + APCA contrast, gamut log.  | generated |
| `tokens.css`                   | Drop-in stylesheet consumed by the preview and (later) the site build.            | generated |
| `must-should-may-preview.html` | Rendered preview of DESIGN.md §4.7 keyword treatments; links `tokens.css`.        | authored  |
| `README.md`                    | This file.                                                                        | authored  |

The generator lives in [`../../scripts/design/`](../../scripts/design/) — generated outputs land here.

## Reproducing the generated files

```bash
cd scripts/design
bun install
bun run generate   # -> rewrites docs/design/color-analysis.md and docs/design/tokens.css
```

Or from the repo root:

```bash
bun run scripts/design/generate-palette.mjs
```

Open `must-should-may-preview.html` in any browser to see the keyword treatments live against both color modes.

## Editing the palette

All palette values live in `scripts/design/generate-palette.mjs`. Change the seed or a scale step, re-run the generator,
and commit the script change and the updated outputs together. `color-analysis.md` and `tokens.css` are generated files
— do not hand-edit them.
