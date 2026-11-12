#!/usr/bin/env bash
# agent-usable — Layer 4 readiness for Ghostfolio (tier: full).
#
# Proves a real agent workflow works in the slot, not just liveness:
#   1. API: sign in with the demo security token (POST /api/v1/auth/anonymous)
#   2. API: authenticated GET /api/v1/user returns the ADMIN demo user
#   3. Client: the Angular dev server serves /en/ and proxies /api to this slot
#
# Runner contract: WORK_DIR, ENV_FILE, AGENT_ID, HAR_HARNESS_DIR exported,
# harness.env + slot env already sourced. Progress → stderr, JSON → stdout.
set -euo pipefail

AGENT_ID="${1:-${AGENT_ID:?Usage: agent-usable.sh <agent-id> (run via har env verify)}}"
HAR_HARNESS_DIR="${HAR_HARNESS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# `har env verify` exports ENV_FILE/WORK_DIR with the slot env sourced;
# `har env run-stage` may not — resolve them from the slot registry then.
if [ -z "${ENV_FILE:-}" ]; then
  REGISTRY="$HAR_HARNESS_DIR/slots/agent-${AGENT_ID}.json"
  [ -f "$REGISTRY" ] && WORK_DIR="${WORK_DIR:-$(node -e 'process.stdout.write(require(process.argv[1]).workDir || "")' "$REGISTRY")}"
  if [ -n "${WORK_DIR:-}" ] && [ -f "$WORK_DIR/.env.agent.${AGENT_ID}" ]; then
    ENV_FILE="$WORK_DIR/.env.agent.${AGENT_ID}"
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  fi
fi
: "${ENV_FILE:?ENV_FILE not set — launch the slot first: har env launch ${AGENT_ID}}"
: "${WORK_DIR:?WORK_DIR not set — launch the slot first: har env launch ${AGENT_ID}}"
: "${API_PORT:?API_PORT missing from ${ENV_FILE}}"
: "${FE_PORT:?FE_PORT missing from ${ENV_FILE}}"
cd "$WORK_DIR"

STAGE_ID="agent-usable"
DEMO_SECURITY_TOKEN="har-demo-security-token"
API="http://localhost:${API_PORT}"
FE="http://localhost:${FE_PORT}"
ARTIFACT_DIR="${HAR_HARNESS_DIR:-.har}/artifacts/${STAGE_ID}"
mkdir -p "$ARTIFACT_DIR"
START_MS=$(date +%s%3N)

result() { # status message
  local status="$1" message="$2"
  printf '{"status":"%s","stageId":"%s","agent_id":%s,"total_ms":%s,"message":%s}\n' \
    "$status" "$STAGE_ID" "$AGENT_ID" "$(( $(date +%s%3N) - START_MS ))" \
    "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$message")"
}
fail() { echo "  ✗ $1" >&2; result fail "$1"; exit 1; }

echo "  → API sign-in with demo security token" >&2
LOGIN=$(curl -sS -m 20 -X POST "$API/api/v1/auth/anonymous" \
  -H 'Content-Type: application/json' \
  -d "{\"accessToken\":\"${DEMO_SECURITY_TOKEN}\"}") || fail "API not reachable at $API"
AUTH_TOKEN=$(printf '%s' "$LOGIN" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try { process.stdout.write(JSON.parse(s).authToken || ""); } catch {}
  });')
[ -n "$AUTH_TOKEN" ] || fail "demo sign-in failed (response: ${LOGIN:0:200}) — did .har/hooks/post-launch.sh run?"

echo "  → API authenticated GET /api/v1/user" >&2
USER_JSON=$(curl -sS -m 30 -f "$API/api/v1/user" -H "Authorization: Bearer ${AUTH_TOKEN}") \
  || fail "GET /api/v1/user failed with the demo JWT"
printf '%s' "$USER_JSON" > "$ARTIFACT_DIR/user.agent-${AGENT_ID}.json"
# /api/v1/user exposes no role; ADMIN shows up as the accessAdminControl permission.
printf '%s' "$USER_JSON" | grep -q '"accessAdminControl"' || fail "demo user lacks accessAdminControl (not ADMIN)"

echo "  → Client serves /en/ (Angular dev server)" >&2
# The first Angular build can take a few minutes after launch — wait for it.
for _ in $(seq 1 60); do
  if curl -sf -m 10 "$FE/en/" -o "$ARTIFACT_DIR/index.agent-${AGENT_ID}.html"; then break; fi
  sleep 5
done
grep -q '<gf-root' "$ARTIFACT_DIR/index.agent-${AGENT_ID}.html" 2>/dev/null \
  || fail "client did not serve the app shell at $FE/en/ (check: har env agent ${AGENT_ID} logs client)"

echo "  → Client proxies /api to this slot's API" >&2
curl -sf -m 20 "$FE/api/v1/health" >/dev/null || fail "client dev-server proxy to $API is broken"

echo "  ✓ agent usable: sign in at $FE/en/ with security token '${DEMO_SECURITY_TOKEN}'" >&2
result pass "demo admin can sign in; client $FE/en/ serves and proxies to $API"
