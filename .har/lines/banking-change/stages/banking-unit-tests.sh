#!/usr/bin/env bash
# HAR stage: banking-unit-tests (kind: test) — banking-change line gate, never on verify.
# See .har/lines/banking-change/README.md. Logic: banking-unit-tests.mjs; stage contract
# (.har/STAGES.md) via .har/stages/lib/factory-line.mjs.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/banking-unit-tests.mjs" "$@"
