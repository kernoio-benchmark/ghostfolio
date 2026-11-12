#!/usr/bin/env bash
# Fail when prisma/schema.prisma has changes not captured by a migration
# Custom HAR stage: prisma-drift (kind: test)
#
# Stage script contract (full reference: .har/STAGES.md):
#   - stdout: a single JSON result object (status, stageId, agent_id, ...)
#   - stderr: human-readable progress
#   - $1: agent slot id; extra args may follow
#   - artifacts: write reports/screenshots/logs under .har/artifacts/prisma-drift/
#   - exit code: the real status (0 = pass)
#
# Usage: ./.har/stages/prisma-drift.sh <agent-id> [extra args...]
set -euo pipefail

# 1.0 stage surface: the runner exports WORK_DIR, ENV_FILE, AGENT_ID and
# HAR_HARNESS_DIR, with harness.env and the slot env file already sourced —
# agent-slot.sh is retired (1.0 migration).
HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"

AGENT_ID="${1:-${AGENT_ID:?Usage: prisma-drift.sh <agent-id> [extra args...]}}"
now_ms() { node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null || echo 0; }

# JSON-escape step output; truncate to 50 lines in node (avoids SIGPIPE under pipefail).
escape_step_output() {
  printf '%s' "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const s=d.trim().split('\n').slice(0,50).join('\n');process.stdout.write(JSON.stringify(s))})" 2>/dev/null || echo '""'
}

# `har env verify` exports ENV_FILE/WORK_DIR; `har env run-stage` and direct
# invocation do not, so resolve them from the slot registry (as agent-usable.sh does).
if [ -z "${ENV_FILE:-}" ]; then
  REGISTRY="$HARNESS_DIR/slots/agent-${AGENT_ID}.json"
  [ -f "$REGISTRY" ] && WORK_DIR="${WORK_DIR:-$(node -e 'process.stdout.write(require(process.argv[1]).workDir || "")' "$REGISTRY")}"
  if [ -n "${WORK_DIR:-}" ] && [ -f "$WORK_DIR/.env.agent.${AGENT_ID}" ]; then
    ENV_FILE="$WORK_DIR/.env.agent.${AGENT_ID}"
    set -a; . "$ENV_FILE"; set +a
  fi
fi
ENV_FILE="${ENV_FILE:?No slot env for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
WORK_DIR="${WORK_DIR:?No slot work dir for agent ${AGENT_ID} — run har env launch ${AGENT_ID} first}"
ARTIFACTS_DIR="$HARNESS_DIR/artifacts/prisma-drift"
mkdir -p "$ARTIFACTS_DIR"

echo "==> [prisma-drift agent-${AGENT_ID}] running in ${WORK_DIR}" >&2
START=$(now_ms)

# ── Check: schema.prisma ⇄ migrations (via the slot DB) ─────────────────────
# The slot DB is built only from prisma/migrations (`migrate deploy` at launch).
# 1. `migrate status`: every migration in the work dir is applied to agent_<id>
#    (otherwise the diff below would report false drift).
# 2. `migrate diff` DB → schema.prisma: anything left over is a schema change
#    with no migration (upstream devs use `db push`, so this is easy to miss).
# Both commands are read-only. On drift, the SQL to put in a new migration is
# written to $ARTIFACTS_DIR/missing-migration.sql.
PRISMA="npx --no-install prisma"
rm -f "$ARTIFACTS_DIR/missing-migration.sql"
set +e
OUTPUT=$(
  cd "$WORK_DIR" || exit 1
  STATUS_OUT=$($PRISMA migrate status 2>&1)
  if [ $? -ne 0 ]; then
    echo "Slot DB is not in sync with prisma/migrations:"
    echo "$STATUS_OUT" | grep -v '^Loaded Prisma config' | sed '/^$/d' | tail -15
    echo "Hint: apply them with 'npm run database:migrate' in the work dir, then re-verify."
    exit 1
  fi
  DIFF_OUT=$($PRISMA migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code 2>&1)
  rc=$?
  case $rc in
    0) echo "prisma/schema.prisma matches prisma/migrations (no drift)."; exit 0 ;;
    2)
      $PRISMA migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script \
        2>/dev/null | grep -v '^Loaded Prisma config' > "$ARTIFACTS_DIR/missing-migration.sql"
      echo "Schema drift: prisma/schema.prisma has changes no migration creates:"
      echo "$DIFF_OUT" | grep -v '^Loaded Prisma config' | sed '/^$/d'
      echo "Fix: npm run prisma -- migrate dev --name <change>   (SQL preview: .har/artifacts/prisma-drift/missing-migration.sql)"
      exit 2 ;;
    *) echo "prisma migrate diff failed:"; echo "$DIFF_OUT"; exit 1 ;;
  esac
)
EXIT_CODE=$?
set -e
echo "$OUTPUT" | tee "$ARTIFACTS_DIR/result.log" >&2

END=$(now_ms)
STATUS="fail"
[ "$EXIT_CODE" = "0" ] && STATUS="pass"
OUTPUT_JSON=$(escape_step_output "$OUTPUT")

node -e "process.stdout.write(JSON.stringify({
  status: '$STATUS',
  stageId: 'prisma-drift',
  kind: 'test',
  agent_id: $AGENT_ID,
  total_ms: $(( END - START )),
  output: $OUTPUT_JSON
}, null, 2) + '\n');"

exit "$EXIT_CODE"
