#!/usr/bin/env bash
# HAR stage: banking-contract (kind: test) — banking-change line gate, never on verify.
# See .har/lines/banking-change/README.md. Logic: banking-contract.mjs; stage contract
# (.har/STAGES.md) via .har/stages/lib/factory-line.mjs.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/banking-contract.mjs" "$@"
