#!/usr/bin/env bash
set -euo pipefail

# The generic runtime supplies the prompt on stdin. Consume it so the fixture
# behaves like a normal foreground CLI, then write the canonical small result.
while IFS= read -r _line; do :; done
mkdir -p "$(dirname "$DEVTEAM_OUTPUT_FILE")"
printf '## Status\nDONE\n\nFake runner completed successfully.\n' > "$DEVTEAM_OUTPUT_FILE"
