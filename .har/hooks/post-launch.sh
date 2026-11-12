#!/usr/bin/env bash
# post-launch — per-slot data bootstrap for Ghostfolio (idempotent).
#
# Runs after the slot DB was cloned + migrated and PM2 started the app.
#   1. `npm run database:seed`  → prisma/seed.mts (system tags), as upstream
#      `npm run database:setup` does.
#   2. Demo ADMIN user with a known security token, so agents can sign in
#      without clicking through "Get Started" (upstream: first signup = ADMIN).
#
# Contract (HAR_HOOK_CONTRACT=1): AGENT_ID, WORK_DIR, ENV_FILE, HAR_HARNESS_DIR.
set -euo pipefail

: "${WORK_DIR:?WORK_DIR not set — run via har env launch <id>}"
: "${ENV_FILE:?ENV_FILE not set — run via har env launch <id>}"

cd "$WORK_DIR"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Documented in .har/README.md ("Agent usable"). Not a real secret: it only
# unlocks a throwaway local slot database.
DEMO_SECURITY_TOKEN="har-demo-security-token"
DEMO_USER_ID="00000000-0000-4000-8000-000000000001"
DEMO_ACCOUNT_ID="00000000-0000-4000-8000-000000000002"

echo "==> [agent-${AGENT_ID}] post-launch: seeding database (prisma/seed.mts)..."
npm run --silent database:seed

HASHED_TOKEN="$(
  DEMO_SECURITY_TOKEN="$DEMO_SECURITY_TOKEN" node -e '
    const { createHmac } = require("node:crypto");
    // Same as UserService.createAccessToken(): HMAC-SHA512(ACCESS_TOKEN_SALT, token)
    process.stdout.write(
      createHmac("sha512", process.env.ACCESS_TOKEN_SALT)
        .update(process.env.DEMO_SECURITY_TOKEN)
        .digest("hex")
    );'
)"

SQL=$(cat <<SQL
INSERT INTO "User" ("id", "accessToken", "provider", "role", "updatedAt")
VALUES ('${DEMO_USER_ID}', '${HASHED_TOKEN}', 'ANONYMOUS', 'ADMIN', now())
ON CONFLICT ("id") DO UPDATE SET "accessToken" = EXCLUDED."accessToken", "role" = 'ADMIN';

INSERT INTO "Settings" ("userId", "settings", "updatedAt")
VALUES ('${DEMO_USER_ID}', '{"currency": "USD"}', now())
ON CONFLICT ("userId") DO NOTHING;

INSERT INTO "Account" ("id", "userId", "currency", "name", "updatedAt")
VALUES ('${DEMO_ACCOUNT_ID}', '${DEMO_USER_ID}', 'USD', 'My Account', now())
ON CONFLICT ("id", "userId") DO NOTHING;
SQL
)

echo "==> [agent-${AGENT_ID}] post-launch: ensuring demo admin user..."
if command -v psql >/dev/null 2>&1; then
  printf '%s\n' "$SQL" | psql -v ON_ERROR_STOP=1 -q "postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}"
else
  # Same fallback as the HAR runtime: psql inside the shared db container.
  printf '%s\n' "$SQL" | docker exec -i -e PGPASSWORD="$PGPASSWORD" \
    "har-${HARNESS_PROJECT_NAME:-ghostfolio}-db-1" \
    psql -v ON_ERROR_STOP=1 -q -U "$PGUSER" -d "$PGDATABASE"
fi

echo "==> [agent-${AGENT_ID}] post-launch: demo admin ready (security token: ${DEMO_SECURITY_TOKEN})"
