# factory-line-router (local HAR plugin)

The only factory-line check on `har env verify --full`. HAR line stages never
join `verificationStages`, so this plugin makes them mandatory where they
matter:

1. Diff the slot work dir against `merge-base(HEAD, main)` (`HAR_LINE_BASE`
   overrides). The diff covers committed, staged, unstaged and untracked
   changes, plus changed Prisma models and the tables touched by changed
   migrations.
2. Match that diff against every `.har/lines/<id>/triggers.json`.
3. For each triggered line, require a **pass stamp for the current tree
   fingerprint** from every gate stage of the line's final station.

An untriggered change passes at no extra cost. A triggered line with a stale
or red gate fails, and the error names the command to run:
`har line gate S3 --line <id> --agent <slot>`.

The plugin also ships `stages/lib/factory-line.mjs`, the shared runtime of all
line stages. It covers the stage contract, slot resolution, diff and
territory, tree fingerprint, stamps, the route-inventory parser, Jest, and the
HTTP/JWT helpers. It uses Node built-ins only.

| File | Installed to |
|---|---|
| `stages/factory-line-router.sh` + `.mjs` | `.har/stages/` |
| `stages/lib/factory-line.mjs` | `.har/stages/lib/` |
| `test/factory-line.test.mjs` | not installed. Run with `node --test .har/plugins/factory-line-router/test/*.test.mjs` |

After editing, re-apply with `har env add-plugin factory-line-router --force`.
See [`../../lines/README.md`](../../lines/README.md) for the full picture.
