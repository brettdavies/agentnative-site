#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "google-genai>=0.6.0",
#   "Pillow>=10.0",
# ]
# ///
"""
Generate the og-image.png social card for agentnative.dev.

Invoked by (and mirrors the brief in) DESIGN.md §4.13. Gemini 3 Pro's
image model does the rendering; this script drives it, resizes the
result to the canonical 1200x630 OG size, and writes PNG.

Run:  GEMINI_API_KEY=... uv run scripts/og/generate.py
"""

from __future__ import annotations

import io
import os
import sys
from pathlib import Path

from google import genai
from google.genai import types
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
OUTPUT = REPO_ROOT / "og-image.png"
OG_W, OG_H = 1200, 630

PROMPT = """\
Generate a 1200x630 social card (OG/Twitter summary_large_image) for a
technical specification website named agentnative.dev. Placeholder quality
is fine; prioritize legible text and clean composition over decoration.

COMPOSITION
- Canvas: 1200x630, dark mode.
- Background: solid warm-near-black, hex #060a0e (no gradient, no texture,
  no noise, no dither, no photographic element).
- One subtle raised rectangle anchored bottom-right, roughly 480x220px,
  filled with #0d1218. No border, no shadow, no radius flourish. Just a
  slightly-lighter-than-bg rectangle.

TYPOGRAPHY (all text left-aligned)
- Hero line (line 1), vertically centered in the left 60% of the canvas,
  starting about 80px from the left edge:
  Text: "agent-native CLI standard"
  Size: ~72pt, weight 600 (semibold), color warm off-white #f3f2ed.
  Font: humanist or neo-grotesque sans. Uncut Sans if available;
  otherwise Inter or Manrope at similar weight. Never a display/
  decorative face.
- Subtitle line (line 2), one baseline-and-a-half below the hero:
  Text: "seven principles for CLIs agents can operate"
  Size: ~36pt, weight 400 (regular), color muted cool gray #9199a2.
  Same font family as hero.
- Bottom-left corner (~60px from left, ~50px from bottom):
  Text: "v0.1 · 2026-04-14"  (the separator is a single middot U+00B7,
  not a hyphen or em-dash; the hyphens inside the date are normal
  U+002D hyphens)
  Size: ~20pt, color #9199a2, letter-spacing slightly open, tabular
  figures if the font supports them.
- Bottom-right rectangle: a stylized llms.txt excerpt in a slab/mono
  font at ~18pt, left-aligned inside the rectangle with ~24px padding.
  Exactly eight lines, one per line:
      # agent-native CLI spec
      p1-non-interactive-by-default
      p2-structured-parseable-output
      p3-progressive-help-discovery
      p4-fail-fast-actionable-errors
      p5-safe-retries-mutation-boundaries
      p6-composable-predictable-command-structure
      p7-bounded-high-signal-responses
  Color: #9199a2 for the first line (#-comment), #b8bec5 for the seven
  principle-id lines. Line-height ~1.35. Font: Monaspace Xenon if
  available; otherwise JetBrains Mono or Fira Code. No ligatures.

EXPLICIT ANTI-REQUIREMENTS (reject if the model drifts — these patterns
must NOT appear):
- No purple-to-blue gradients.
- No neon glow, text shadow, or halation on any glyph.
- No cyan accent anywhere.
- No emoji or icon.
- No marketing language ("Learn more", "Get started", "Introducing").
- No decorative squiggles, particles, sparkles, stars, circuit-board
  motifs, geometric background patterns, or "tech" flourishes.
- No 3D rendering, fake perspective, depth-of-field, lens flare, or
  motion blur.
- No watermark beyond Gemini's default SynthID.

QUALITY BAR
- Text rendering must be crisp and glyph-correct. Double-check the
  hyphen in "agent-native" is a hyphen (U+002D), not an en-dash or
  em-dash.
- Contrast: hero must read comfortably against the background (APCA Lc
  ≥ 60 target); the muted gray text must clear Lc ≈ 45.
- Raised rectangle has clean edges, no anti-aliasing fringe.

The feel to target is "a print publication's colophon page, set in a
single restrained family" — not a marketing banner, not a product
landing, not a conference card.
"""


def main() -> int:
    if not os.environ.get("GEMINI_API_KEY"):
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        return 1

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    # 16:9 is the nearest supported aspect ratio to 1200x630 (1.905:1).
    # 2K gives us enough pixels to down-sample cleanly to 1200x630.
    print(f"calling gemini-3-pro-image-preview at 2K, 16:9 …", file=sys.stderr)
    resp = client.models.generate_content(
        model="gemini-3-pro-image-preview",
        contents=[PROMPT],
        config=types.GenerateContentConfig(
            response_modalities=["TEXT", "IMAGE"],
            image_config=types.ImageConfig(
                aspect_ratio="16:9",
                image_size="2K",
            ),
        ),
    )

    image_bytes: bytes | None = None
    for part in resp.parts:
        if part.text:
            # The model sometimes returns a short prose description
            # alongside the image. Log it for the record.
            print(f"[gemini note] {part.text.strip()}", file=sys.stderr)
        elif part.inline_data:
            image_bytes = part.inline_data.data

    if image_bytes is None:
        print("ERROR: no image returned by Gemini", file=sys.stderr)
        return 2

    # Gemini returns JPEG. Load, resize to canonical OG dimensions, save PNG.
    img = Image.open(io.BytesIO(image_bytes))
    print(f"received {img.size[0]}x{img.size[1]} {img.format}", file=sys.stderr)

    # Letterbox-safe resize: if the generator came back at a slightly
    # different aspect ratio than 1200:630 (which 16:9 is NOT exactly —
    # 16:9 is 1.778, OG is 1.905), center-crop to the OG ratio first,
    # then resize. This avoids squashing glyphs.
    src_w, src_h = img.size
    target_ratio = OG_W / OG_H  # 1.9048
    src_ratio = src_w / src_h
    if src_ratio > target_ratio:
        # source is wider than target; crop horizontally
        new_w = int(src_h * target_ratio)
        off_x = (src_w - new_w) // 2
        img = img.crop((off_x, 0, off_x + new_w, src_h))
    elif src_ratio < target_ratio:
        # source is taller than target; crop vertically
        new_h = int(src_w / target_ratio)
        off_y = (src_h - new_h) // 2
        img = img.crop((0, off_y, src_w, off_y + new_h))

    img = img.resize((OG_W, OG_H), Image.LANCZOS)

    # The OG card has a tiny visual palette (dark bg, raised panel, two
    # text colors, two code-block colors, edges). The rest of the RGB
    # space is just antialiasing gradient. Quantize to 128 colors with
    # Pillow's median-cut variant (method=2 → MAXCOVERAGE), which preserves
    # rare but important pixels like the anti-aliased glyph edges.
    # Typically 10x+ size reduction with no visible loss.
    quantized = img.convert("RGB").quantize(colors=128, method=2, dither=Image.FLOYDSTEINBERG)
    quantized.save(OUTPUT, format="PNG", optimize=True, compress_level=9)

    size_kb = OUTPUT.stat().st_size / 1024
    print(
        f"wrote {OUTPUT.relative_to(REPO_ROOT)}  "
        f"({OG_W}x{OG_H}, {size_kb:.0f} KB, 128-color palette)",
        file=sys.stderr,
    )
    if size_kb > 200:
        print(
            f"NOTE: file size {size_kb:.0f} KB > 200 KB target — "
            f"install pngquant or oxipng for a further pass, or drop "
            f"colors= below 128.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
