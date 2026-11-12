# .har — Agent Harness (Ghostfolio)

This directory is the **agent harness** for Ghostfolio. It lets AI coding agents
(Claude Code, Cursor, Codex, …) run the app in isolated slots, each with its own
git worktree, ports, PostgreSQL database and Redis database, plus a verification
pipeline.

Generated and maintained by [`har`](https://github.com/os-factory/har) (profile
`default`). Run `har env maintain` when the stack changes.

**The harness is how you run this project.** Need the app live (manual testing,
a browser session, screenshots)? `launch` a slot. Don't hand-roll
`docker compose -f docker/docker-compose.dev.yml up` or `npm run start:server`.
If a harness command fails, fix the harness or report it. Don't fall back to
ad-hoc commands.

## Stack at a glance

| Part | What | Runs |
|------|------|------|
| `apps/api` | NestJS API (Prisma, Bull queues, cache) | **Per slot**, PM2 process `…-api` (`nx run api:serve --watch`) |
| `apps/client` | Angular client (i18n, Material) | **Per slot**, PM2 process `…-client` (`nx run client:serve`) |
| `libs/common`, `libs/ui` | Shared libraries | Compiled into api/client |
| PostgreSQL 15 | Main data store | **Shared** container `db`, per-slot database `agent_<id>` |
| Redis 8 | Bull queues + cache | **Shared** container `redis`, per-slot logical DB `REDIS_DB=<id>` |

`HARNESS_PRIMARY_APP=ghostfolio`: the API and client are one product and change
together, so both run in each slot.

## What's in here

**Yours: the configuration surface** (edit freely; drift tracking records adaptations):

| File | Purpose |
|------|---------|
| `README.md` | This file: the harness reference |
| `harness.env` | Primary app, port bases, infra services + lanes, toolchain (`npm ci`), migrate command, post-hook policy |
| `stages.json` | Registered stages, verification order + tiers, `agentSlots.max = 3`, commit gate |
| `stages/api-health.sh` | Quick: `GET /api/v1/health` on the slot API |
| `stages/agent-usable.sh` | Full: demo sign-in → authenticated `/api/v1/user` → client `/en/` → client `/api` proxy |
| `stages/readiness.sh` | Stock `HARNESS_READINESS_CMD` runner. Registered but **not** in `verificationStages` (replaced by `agent-usable`) |
| `hooks/post-launch.sh` | Per-slot bootstrap: `npm run database:seed` + demo ADMIN user with a known security token |
| `env.template` | Per-slot env (expanded into `<work dir>/.env.agent.<id>`): ports, `DATABASE_URL`, Redis, secrets, Nx flags |
| `ecosystem.agent.template.cjs` | PM2 processes for the api and client. Also writes the per-slot Angular proxy config |
| `docker-compose.agent.yml` | Shared `db` (postgres:15-alpine) and `redis` (redis:8-alpine) |
| `STAGES.md` | Stage registry and script-contract guide |
| `justfile` | Optional shortcuts (requires `just`) |

**Generated state** (don't edit):

| File | Purpose |
|------|---------|
| `manifest.json` | Runtime version, profile, checksums. Managed by the har CLI |
| `state/infra.env` | Resolved shared infra host ports |
| `slots/agent-<id>.json` | Slot registry: work dir, branch, ports, preview URLs |
| `runs/` | Run history (see below) |
| `artifacts/` | Stage outputs (`artifacts/agent-usable/…`) |

## Quick start

```bash
har env launch 1          # worktree + npm ci + DB clone/migrate + PM2 + seed/demo user
har env verify 1          # quick: typecheck + api-health
har env verify 1 --full   # + unit tests, lint, format check, agent-usable smoke
har env agent 1 url       # resolved URLs for the slot
har env teardown 1        # or: har env complete 1 (after a passing full verify)
```

MCP equivalents: `har_launch_environment`, `har_run_verification` (`full: true`),
`har_teardown_environment` / `har_complete_environment`.

The first launch of a slot runs `npm ci` in the fresh worktree (several minutes)
and the first Angular build after that (1–3 min). The API health wait at launch
is 60 s, so a "Health check did not pass" warning on a cold start is normal.
`har env verify` re-checks it.

## Slot environment

| | |
|--|--|
| **Client (open this)** | `http://localhost:${FE_PORT}/en/` |
| **API** | `http://localhost:${API_PORT}/api/v1/…` (health: `/api/v1/health`) |
| **Bull Board** | `http://localhost:${FE_PORT}/admin/queues` (proxied to the API) |
| **Node inspector (API)** | `localhost:${DEBUG_PORT}` |
| **PostgreSQL** | `agent_<id>` on `localhost:${PGPORT}`, user `postgres` / `password` |
| **Redis** | `localhost:${REDIS_PORT}`, password `password`, DB `${REDIS_DB}` (= agent id) |
| **Work dir** | Fresh worktree per launch. See the launch output or `.har/slots/agent-<id>.json` |

All values come from `<work dir>/.env.agent.<id>`. Get resolved URLs with
`har env agent <id> url`.

**Never edit the main checkout.** Launch first, then make all file edits under
the work dir. The API (`--watch`) and client dev server rebuild on save. Use
`har env agent <id> restart` if a change doesn't take, for example after editing
`prisma/schema.prisma` (also re-run `npx prisma generate` in the work dir).

```bash
har env agent <id> status
har env agent <id> logs api        # or: logs client
har env agent <id> health
har env agent <id> psql            # psql into agent_<id>
har env agent <id> reset-db        # re-clone agent_<id> from the (empty) template
```

After `reset-db`, apply the schema and bootstrap again from the work dir:
`npm run database:migrate`, then re-run the launch hook with
`har env launch <id> --resume`, or restart the slot.

### Agent-friendly choices (vs. upstream `DEVELOPMENT.md`)

| Upstream dev setup | In a slot | Why |
|--------------------|-----------|-----|
| `.env` copied from `.env.dev` | `.env.agent.<id>` generated from `env.template` | Per-slot ports/DBs; no hand edits |
| `docker/docker-compose.dev.yml` (postgres + redis on 5432/6379) | Shared `har-ghostfolio-db-1` / `-redis-1` | One infra for all slots |
| `npm run database:setup` (`db push` + seed) | `prisma migrate deploy` (launch) + seed (post-launch hook) | Migrations are the source of truth; same as production start |
| "Get Started" creates the first (ADMIN) user | Demo ADMIN user pre-created with a known security token | Agents can sign in immediately |
| Client on `https://localhost:4200` (self-signed cert), `--hmr -o` | `http://localhost:${FE_PORT}`, `--ssl=false --hmr=false`, no auto-open | No cert warnings for browsers/curl, no HMR overlays, no stray windows |
| `proxy.conf.json` → API `:3333` | Generated `node_modules/.cache/har/proxy.agent-<id>.json` → slot API | Per-slot API port; gitignored location |
| Cron jobs enabled | `ENABLE_FEATURE_CRON=false` | No market-data fetches from every slot; trigger gathering from Admin Control if needed |
| Nx daemon / Nx Cloud | `NX_DAEMON=false`, `NX_NO_CLOUD=true` | No per-worktree daemons, no network calls |

Skipped entirely: Storybook (`npm run start:storybook`) and `npm run build:production`.
Run them by hand in the work dir if a change needs them.

## Readiness: what "agent usable" means here

| Layer | What it means | Where it's encoded |
|-------|---------------|--------------------|
| Infra ready | `db` and `redis` containers up; `template_ghostfolio` exists (empty, on purpose) | `har env setup-infra` (run by launch), `docker-compose.agent.yml` |
| Slot data ready | `agent_<id>` cloned and migrated (`prisma migrate deploy`); Redis DB `<id>` selected; tags seeded; demo user created | launch (`HARNESS_DB_MIGRATE_CMD`), `hooks/post-launch.sh` |
| Process ready | PM2 `api` + `client` online; `GET /api/v1/health` = 200 (checks DB **and** Redis) | launch health wait, `api-health` stage |
| Agent usable | Demo admin signs in through the API; JWT works on `/api/v1/user`; client serves `/en/` and proxies `/api` | `agent-usable` stage (`verify --full`) |

**Credentials:** Ghostfolio has no passwords; anonymous users sign in with a
*security token*. Every slot has an ADMIN user (id `00000000-0000-4000-8000-000000000001`):

- **Security token:** `har-demo-security-token`
- **UI:** open `http://localhost:${FE_PORT}/en/` → **Sign in** → paste the token.
- **API:** `curl -X POST http://localhost:${API_PORT}/api/v1/auth/anonymous -H 'Content-Type: application/json' -d '{"accessToken":"har-demo-security-token"}'`
  returns `{"authToken": "<JWT>"}`. Send it as `Authorization: Bearer <JWT>`.

Why the template DB is empty: `setup-infra` runs migrate/seed from the main
checkout, which has no `node_modules`, and Prisma there would read the
developer's own `.env`. The migrate command is guarded (`printenv DATABASE_URL || exit 0`)
so it only runs inside a slot. Migrating a fresh clone takes a few seconds.

## Verification contract

| Mode | Command | Stages (in order) |
|------|---------|-------------------|
| Quick | `har env verify <id>` | `typecheck` (`tsc --noEmit` for `apps/api` + `apps/client`), `api-health` |
| Full | `har env verify <id> --full` | quick stages + `unit-tests` (`npm run test`), `lint` (`npm run lint -- --quiet`), `format-check` (`npm run format:check`), `agent-usable` |

Full verify mirrors CI (`.github/workflows/build-code.yml`) except
`npm run build:production`, which is too heavy for the loop. Run it by hand in
the work dir for build-sensitive changes (Angular i18n, assets, webpack config).
`npm run test` uses `npx dotenv-cli -e .env.example`, so the first run downloads
`dotenv-cli`.

## Definition of done

- [ ] `har env verify <id> --full` returns `"status": "pass"`
- [ ] The change works in the running slot (sign in with the demo token and exercise it in the UI or API), not only health-green
- [ ] New behavior has Jest coverage (`*.spec.ts` next to the code in `apps/api`, `apps/client`, `libs/*`)
- [ ] User-facing strings use Angular i18n (`$localize` / `i18n` attributes); run `npm run extract-locales` when adding them
- [ ] Changes committed **in the session worktree** with a clear message
- [ ] The user got the preview URLs (`har env agent <id> url`)
- [ ] Present the session handoff (summary, branch, preview URLs) and **wait for the user** before `complete`, push, or PR

### Session handoff

After full verify and commit, stop and propose next steps. Never autonomously
run `complete`, `teardown`, `git push`, or open a PR. **Default recommendation:**
when `gh` or GitHub MCP is available, push, open a PR, then `har env complete <id>`.
Offer complete-only as an alternative. Prefer `complete` over bare `teardown`
when the work succeeded.

## Project commands

Run these inside the slot work dir. `node_modules/.bin` is on `PATH` via
`.env.agent.<id>`.

```bash
npm run test                    # all Jest suites (Nx run-many)
npm run test:api                # API only (also: test:common, test:ui)
npx dotenv-cli -e .env.example -- nx test api --test-file <name>.spec.ts
npm run lint                    # ESLint for all projects
npm run format:check            # Prettier check   (npm run format to fix)
npm run database:migrate        # prisma migrate deploy against DATABASE_URL
npm run prisma -- migrate dev --name <change>   # new migration (slot DB)
npm run database:seed           # prisma/seed.mts
npm run extract-locales         # update apps/client/src/locales/*.xlf
npm run build:production        # full production build (heavy; not in verify)
```

## Port & shared services

### Port allocation

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Client (Angular dev server) | Per slot | `HARNESS_FE_BASE_PORT + AGENT_ID × HARNESS_PORT_STEP` | Scan `STEP` increments in the slot lane |
| API (NestJS) | Per slot | `HARNESS_API_BASE_PORT + AGENT_ID × HARNESS_PORT_STEP` | Same |
| Node inspector (API) | Per slot | `9200 + AGENT_ID × HARNESS_PORT_STEP` | Same |
| PostgreSQL | Per machine | `db` lane in `HARNESS_INFRA_PORT_LANES` | Scans the lane range; persisted in `.har/state/infra.env` |
| Redis | Per machine | `redis` lane default in `HARNESS_INFRA_PORT_LANES` | **Not scanned** (not a runtime built-in lane). If the port is busy, change the lane default **and** `REDIS_PORT` in `env.template` together |

Bases are in `harness.env` (client `HARNESS_FE_BASE_PORT`, API
`HARNESS_API_BASE_PORT`, step `HARNESS_PORT_STEP`). Resolved ports may differ
from the formula when something else holds a port. Always read them from
`.env.agent.<id>`, `har env agent <id> url` or `.har/slots/agent-<id>.json`.

| Slot | Client | API | Inspector |
|------|--------|-----|-----------|
| 1 | `HARNESS_FE_BASE_PORT + 10` | `HARNESS_API_BASE_PORT + 10` | `9210` |
| 2 | `HARNESS_FE_BASE_PORT + 20` | `HARNESS_API_BASE_PORT + 20` | `9220` |
| 3 | `HARNESS_FE_BASE_PORT + 30` | `HARNESS_API_BASE_PORT + 30` | `9230` |

`agentSlots.max` is 3: each slot runs a webpack watcher and an Angular dev
server (about 3–4 GB RAM together). Raise it in `stages.json` only on a big
machine, then run `har env maintain --finalize`. Slot ports don't overlap
Mission Control (`har control up`).

### Shared vs per-slot

| Resource | Model | Configuration |
|----------|-------|---------------|
| PostgreSQL | One container; per-slot DB `agent_<id>` cloned from `template_ghostfolio`, then migrated | `HARNESS_INFRA_SERVICES="db redis"`, `HARNESS_TEMPLATE_DB`, `HARNESS_DB_MIGRATE_CMD` |
| Redis | One container; per-slot logical DB `REDIS_DB=<id>` (16 DBs available) | `env.template` |
| API + client | One PM2 ecosystem per slot (isolated ports) | `ecosystem.agent.template.cjs` |
| Git worktree | One per session (`~/worktrees/<base>-<sha4>-har-agent-<id>-<rand4>`) | `HARNESS_USE_WORKTREE=true` |

There are no internal supporting services, so there's no `ecosystem.shared.config.cjs`.

### Do not

- Hardcode ports in app code, tests or docs. Read `.env.agent.<id>` / `har env agent <id> url`
- Run raw `docker compose` for harness infra. Use `har env setup-infra` / `har env launch`
- Point a slot at `docker/docker-compose.dev.yml` services or your personal `.env`
- Use another slot's database, Redis DB number, or PM2 processes

## Run history

Every entry point (`har env …`, MCP) writes the same run records to
`.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json` in the **main
checkout**. With worktree slots, code runs in the worktree but run JSON stays
in the main checkout's `.har/runs/`; each record includes `workDir`. CLI and
MCP are the only entry points, and their evidence records are identical.

## Do not

- Hand-roll docker/dev-server startup. `launch` is how you run the app
- Work around a failing harness command with ad-hoc setup. Fix the harness or report it
- Edit `.env.agent.<id>`, `ecosystem.agent.<id>.config.cjs` or the generated proxy file by hand
- Run `verify` before `launch`
- Edit the main checkout. All edits go under the session work dir

## Maintaining this harness

When the stack changes (new service, env var, test command):

```bash
har env maintain     # validate + print a maintenance prompt
har env doctor       # contract check
```

Customize only through the contract: config (`harness.env`), stages
(`stages.json` + `stages/`), hooks (`hooks/`), plugins (`plugins/`). Keep this
README in sync. When the app reads a new required env var
(`apps/api/src/services/configuration/configuration.service.ts`), add it to
`env.template`.

## Session lifecycle

Every `launch` starts a **fresh session**: a new git worktree from the **main
checkout's current HEAD**, on a branch of the same name, recorded in
`.har/slots/agent-<id>.json`. Switch the main checkout to the intended base
before launch.

- Occupied slots block a new launch: `har env complete <id>` (or `teardown <id>`), then launch again.
- When every slot is occupied, don't free one on your own. Run `har env status`
  and give the user a per-slot summary: branch, work unit, what it achieves,
  last verify, and whether its commits are merged, pushed or unpushed. Recommend
  which to close (merged or abandoned work first, never one with unpushed
  commits). Free it only after approval.
- `teardown` removes the worktree and drops `agent_<id>` but **keeps the branch** (`--delete-branch` to drop it).
- Failed launch: `har env launch <id> --resume` (or `har env recover <id>`).
- `har env complete <id>` reuses the last matching passing full validation, then tears down. Pass `--verify` if the tree changed.
- `--no-worktree` runs the slot from the repo root instead (single-agent mode).
