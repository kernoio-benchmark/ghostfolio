#!/usr/bin/env bash
# HAR stage: auth-unit-tests (kind: test) — auth-change line gate, never on verify.
# See .har/lines/auth-change/README.md. Logic: auth-unit-tests.mjs; stage contract
# (.har/STAGES.md) via .har/stages/lib/factory-line.mjs.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/auth-unit-tests.mjs" "$@"
