# design/

Design artifacts for the agentnative spec site. Referenced from [`../DESIGN.md`](../DESIGN.md). **Not site code** —
nothing in this directory ships with the built site. The generated `tokens.css` will be copied into the site build
later; the build will consume it, but the file is authored here.

## Contents

| File                              | Role                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `generate-palette.mjs`            | Source of truth. Generates `color-analysis.md` + `tokens.css`. Hand-edit here.    |
| `color-analysis.md`               | Methodology report: tool calls, palette tables, WCAG + APCA contrast, gamut log. |
| `tokens.css`                      | Drop-in stylesheet consumed by the preview and (later) the site build.            |
| `must-should-may-preview.html`    | Rendered preview of §4.7 keyword treatments; links `tokens.css`.                  |
| `package.json` / `bun.lock`       | Locked deps (`culori`, `apca-w3`). Required for reproducing the generation.       |

## Reproducing

```bash
cd design
bun install
bun run generate   # -> rewrites color-analysis.md and tokens.css
```

Open `must-should-may-preview.html` in any browser to see the keyword treatments live against both color modes.

## Editing the palette

All palette values live in `generate-palette.mjs`. Change the seed or a scale step, re-run `bun run generate`, and
commit both the script change and the updated outputs together. `color-analysis.md` and `tokens.css` are generated files
— do not hand-edit them.
