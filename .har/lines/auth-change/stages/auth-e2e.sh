#!/usr/bin/env bash
# HAR stage: auth-e2e (kind: test) — auth-change line gate, never on verify.
# See .har/lines/auth-change/README.md. Logic: auth-e2e.mjs; stage contract
# (.har/STAGES.md) via .har/stages/lib/factory-line.mjs.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/auth-e2e.mjs" "$@"
