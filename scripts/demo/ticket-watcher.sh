#!/bin/bash
# Interim tmux scraper; the ticket-handoff story will replace this helper.
set -euo pipefail

if (( $# != 1 )); then
  echo "usage: $0 TMUX_PANE" >&2
  exit 2
fi
PANE="$1"
ATTACH_FILE="${OMB_ATTACH_FILE:-/tmp/omb-live-attach.json}"

for ((i = 0; i < 3600; i++)); do
  CONTENT="$(tmux capture-pane -t "$PANE" -p 2>/dev/null || true)"
  LINE=""
  while IFS= read -r candidate; do
    [[ "$candidate" =~ Blender\ attach:\ runtime=([^[:space:]]+)\ ticket=([^[:space:]]+) ]] || continue
    LINE="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
  done <<< "$CONTENT"
  if [[ -n "$LINE" ]]; then
    RUNTIME="${LINE%% *}"
    TICKET="${LINE#* }"
    RUNTIME="$RUNTIME" TICKET="$TICKET" ATTACH_FILE="$ATTACH_FILE" python3 - <<'PY'
import json
import os
from pathlib import Path

Path(os.environ["ATTACH_FILE"]).write_text(
    json.dumps({"runtime_directory": os.environ["RUNTIME"], "ticket": os.environ["TICKET"]}) + "\n",
    encoding="utf-8",
)
PY
    echo "ticket delivered"
    exit 0
  fi
  sleep 0.5
done

echo "watcher timeout" >&2
exit 1
