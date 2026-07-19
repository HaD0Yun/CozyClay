#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${OMB_DEMO_PROJECT_DIR:?OMB_DEMO_PROJECT_DIR is required}"
cd "$OMB_DEMO_PROJECT_DIR"

NODE_EXECUTABLE="${OMB_NODE_EXECUTABLE:-}"
if [[ -z "$NODE_EXECUTABLE" ]]; then
  NODE_EXECUTABLE="$(command -v node || true)"
fi
if [[ -z "$NODE_EXECUTABLE" || ! -x "$NODE_EXECUTABLE" ]]; then
  echo "node not found; set OMB_NODE_EXECUTABLE to an executable" >&2
  exit 1
fi

if (( $# == 0 )); then
  ARGS=(--provider openai-codex --model "${OMB_MODEL:-gpt-5.6-sol}")
else
  ARGS=("$@")
fi

PROVIDER=""
for ((i = 0; i < ${#ARGS[@]}; i++)); do
  if [[ "${ARGS[$i]}" == "--provider" && $((i + 1)) -lt ${#ARGS[@]} ]]; then
    PROVIDER="${ARGS[$((i + 1))]}"
  fi
done

if [[ "$PROVIDER" == "openai-codex" && -z "${OPENAI_CODEX_ACCESS_TOKEN:-}" ]]; then
  AUTH_DB="${HOME}/.gjc/agent/agent.db"
  if [[ ! -f "$AUTH_DB" ]]; then
    echo "Codex auth store not found at $AUTH_DB; run gjc /login first" >&2
    exit 1
  fi
  if ! OPENAI_CODEX_ACCESS_TOKEN="$(AUTH_DB="$AUTH_DB" python3 - <<'PY'
import base64
import json
import os
import sqlite3
import sys
import time

try:
    with sqlite3.connect(os.environ["AUTH_DB"]) as connection:
        row = connection.execute(
            "SELECT data FROM auth_credentials WHERE provider = ?", ("openai-codex",)
        ).fetchone()
    if not row:
        raise RuntimeError("no openai-codex credential; run gjc /login first")
    access = json.loads(row[0]).get("access")
    if not access:
        raise RuntimeError("openai-codex credential has no access token; run gjc /login first")
    segment = access.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
    remaining = claims.get("exp", 0) - time.time()
    if remaining < 600:
        raise RuntimeError("Codex access token is expired or expires within 10 minutes; refresh it with gjc")
except (IndexError, KeyError, ValueError, json.JSONDecodeError, sqlite3.Error, RuntimeError) as error:
    print(f"Cannot load Codex credentials: {error}", file=sys.stderr)
    sys.exit(1)
print(access)
PY
)"; then
    exit 1
  fi
  export OPENAI_CODEX_ACCESS_TOKEN
  echo "Codex access token loaded from the gjc auth store"
fi

if [[ "$PROVIDER" == "anthropic" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  read -r -s -p "Anthropic OAuth token (sk-ant-oat...): " ANTHROPIC_API_KEY
  echo
  if [[ "$ANTHROPIC_API_KEY" != sk-ant-oat* ]]; then
    echo "A valid sk-ant-oat Anthropic OAuth token is required" >&2
    exit 1
  fi
  export ANTHROPIC_API_KEY
fi

exec "$NODE_EXECUTABLE" --import "$REPO_ROOT/node_modules/tsx/dist/loader.mjs" \
  "$REPO_ROOT/apps/omb-tui/src/main.ts" "${ARGS[@]}"
