#!/usr/bin/env bash
# Route the diff to the factory lines it touches; require their gate green for the exact tree
# HAR stage: factory-line-router (kind: test) — factory lines, see .har/lines/README.md
#
# Stage contract (.har/STAGES.md) is implemented by stages/lib/factory-line.mjs:
# stdout = one JSON result, stderr = progress, $1 = agent slot id,
# artifacts under .har/artifacts/factory-line-router/, exit code = real status.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/factory-line-router.mjs" "$@"
