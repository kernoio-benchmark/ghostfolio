# prisma-drift (local HAR plugin)

Registers the `prisma-drift` stage (tier `full`). It fails verification when
`prisma/schema.prisma` contains changes that no migration in `prisma/migrations/`
creates.

**Why:** upstream Ghostfolio's dev loop uses `npm run database:push` (`prisma db push`),
which changes the DB without writing a migration. Production (and every HAR slot)
builds the schema with `prisma migrate deploy`, so a forgotten migration passes
typecheck, Jest (which mocks Prisma) and CI, then breaks at deploy time.

**How (read-only, ~2 s):**

1. `prisma migrate status`: every migration in the work dir is applied to `agent_<id>`.
   If one isn't, the stage fails and tells you to run `npm run database:migrate`.
2. `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`:
   whatever is left is drift. The stage fails, lists the changes and writes the SQL
   to `.har/artifacts/prisma-drift/missing-migration.sql`.

**Fix drift:** `npm run prisma -- migrate dev --name <change>` in the work dir.

## Layout

| File | Purpose |
| --- | --- |
| `template.manifest.json` | What the plugin installs and which stages it registers |
| `stages/prisma-drift.sh` | The stage script (HAR stage contract — see `.har/STAGES.md`) |
| `README.md` | This file — document what the stage checks and why |

## Develop

1. Implement the `TODO` block in `stages/prisma-drift.sh`.
2. Install (or reinstall after changes) into the harness:

   ```bash
   har env add-plugin prisma-drift --force
   ```

   This copies the files listed in `template.manifest.json` into place and
   registers the plugin's stages in `.har/stages.json` — exactly like a
   bundled, npm, or git plugin.

3. Run it against a live slot:

   ```bash
   ./.har/stages/prisma-drift.sh 1
   ```

For a simple one-liner check you may not need a plugin at all — register a
command stage directly in `.har/stages.json` (see `.har/STAGES.md`).

## Publish (optional)

The format is identical across all plugin sources — publishing requires zero
format changes:

- **npm**: add a `package.json` next to `template.manifest.json`, then
  `npm publish`. Consumers run `har env add-plugin @your-scope/prisma-drift`.
- **git**: push this directory (manifest at the repo root, or under
  `plugins/prisma-drift/`). Consumers run
  `har env add-plugin github:your-org/your-repo`.
