# Agent Environment

This repository uses a **`.har/` harness** for isolated agent development.

<!-- har:agent-environment:start -->
## HAR / agent environment

This repository uses a `.har/` harness. It is **how you run and verify this
project** — launch a slot for live apps, browsers and screenshots; never
hand-roll docker or dev-server startup. If a harness command fails, fix the
harness or report it; do not fall back to ad-hoc commands.

1. **Launch first** — `har_launch_environment` / `har env launch <id>`. Make ALL
   edits under the returned **work dir**, never the main checkout. Bind tracker
   work with `--work-id` / `--work-url` when the task names an issue.
2. **Verify before done** — `har_run_verification` (`full: true`) /
   `har env verify <id> --full`. Commit in the session worktree.
3. **Stop at handoff** — report summary, session branch and preview URLs, then
   wait. Never autonomously `complete`, `teardown`, push, or open a PR.
4. **All slots taken?** Occupied slots always block a launch, and you never free
   one yourself. Run `har env status`, then show the user every slot — branch,
   work unit, what it achieves, last verify, and whether its commits are merged,
   pushed or unpushed — and recommend which to close: merged or abandoned work
   with nothing left to do first; never one with unpushed commits. On approval:
   `complete` / `teardown <id>`, then launch.

Customize the harness only through `harness.env`, `stages.json` + `.har/stages/`,
`.har/hooks/` and `.har/plugins/` — there is no generated `.har/*.sh` entry-point
surface.

Full detail — slot environment, readiness, definition of done, project commands,
commit gate: [`.har/README.md`](.har/README.md) and [`.har/stages.json`](.har/stages.json).
<!-- har:agent-environment:end -->

## Project-specific notes

- **Stack:** Ghostfolio, an Nx monorepo. `apps/api` (NestJS + Prisma 7, Bull/Redis)
  and `apps/client` (Angular) run per slot. PostgreSQL 15 + Redis 8 are shared
  harness infra (per-slot DB `agent_<id>`, Redis DB `<id>`). Node `>=22`, npm.
- **Open the app:** `http://localhost:${FE_PORT}/en/` (plain HTTP in slots).
  API under `/api/v1`. Never hardcode ports: use `har env agent <id> url`.
- **Credentials:** every slot has an ADMIN user. Sign in with security token
  `har-demo-security-token` (UI: **Sign in**; API: `POST /api/v1/auth/anonymous`
  with `{"accessToken": "har-demo-security-token"}` → Bearer JWT).
- **Definition of done:** `har env verify <id> --full` passes (typecheck,
  api-health, Jest, ESLint, Prettier, agent-usable smoke). Changes are exercised
  in the running slot, have `*.spec.ts` coverage, user-facing strings use
  Angular i18n, and the work is committed in the session worktree.
- **Schema changes:** edit `prisma/schema.prisma`, create a migration with
  `npm run prisma -- migrate dev --name <change>` in the work dir, then
  `har env agent <id> restart`.
- Details: [`.har/README.md`](.har/README.md). Upstream human setup: `DEVELOPMENT.md`.

### Run history

Every entry point (`har env …`, MCP) writes the same run records to
`.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json`. With worktrees, code
runs in the worktree but run JSON lives in the main checkout's `.har/runs/`.
CLI and MCP are the only entry points, and their evidence records are identical.
