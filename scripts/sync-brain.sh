#!/usr/bin/env bash
# Copies the current brain from the Vibe Distribution repo into this app.
# The brain is built there (build_brain.py → inject_brain.py → validate.py); it is never edited here.
set -euo pipefail
SRC="${1:-$(dirname "$0")/../../vibe-distribution/brain/brain.json}"
DST="$(dirname "$0")/../server/brain/brain.json"
if [ ! -f "$SRC" ]; then echo "brain not found at $SRC" >&2; exit 1; fi
cp "$SRC" "$DST"
node -e "const b=require(process.argv[1]); console.log('brain', b.version, '→', process.argv[1])" "$DST"
