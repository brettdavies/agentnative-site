#!/usr/bin/env bash
# Subset fonts to the Unicode ranges actually used on anc.dev.
# Requires: pyftsubset (from fonttools[woff] — `uv tool install 'fonttools[woff]'`)
#
# Source (full) fonts live in public/fonts/full/.
# Subsetted outputs overwrite public/fonts/*.woff2 (the files the site serves).
#
# Unicode coverage:
#   U+0000-00FF   Basic Latin + Latin-1 Supplement (§ · ×)
#   U+0100-017F   Latin Extended-A
#   U+2000-206F   General Punctuation (– — …)
#   U+2190-21FF   Arrows (→)
#   U+2200-22FF   Mathematical Operators (∞ etc — future-proofing)

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

UNICODES="U+0000-00FF,U+0100-017F,U+2000-206F,U+2190-21FF,U+2200-22FF"
SRC=public/fonts/full
OUT=public/fonts

for font in uncut-sans-variable monaspace-xenon-variable; do
  if [[ ! -f "$SRC/${font}.woff2" ]]; then
    echo "ERROR: source font missing: $SRC/${font}.woff2" >&2
    exit 1
  fi
  pyftsubset "$SRC/${font}.woff2" \
    --output-file="$OUT/${font}.woff2" \
    --flavor=woff2 \
    --unicodes="$UNICODES" \
    --layout-features='*' \
    --no-hinting \
    --desubroutinize
  echo "  ${font}.woff2: $(wc -c < "$OUT/${font}.woff2") bytes"
done

echo "Done. Total: $(wc -c "$OUT"/*.woff2 | tail -1 | awk '{print $1}') bytes"
