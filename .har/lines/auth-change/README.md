# auth-change: authentication change line

A HAR factory line for any change that touches authentication, sessions,
guards, API keys, permissions, scopes or impersonation. The territory is in
[`triggers.json`](triggers.json). The overview and schema are in
[`../README.md`](../README.md).

| Station | Gate stage (cumulative) | Kind | Typical time |
|---|---|---|---|
| S1 Map the auth surface | `auth-surface` | static: route inventory spec, weakening vs merge base, role escalation, dangerous-pattern scan | ~10–30 s |
| S2 Unit-prove the auth territory | + `auth-unit-tests` | Jest `--ci` over every auth spec; tests ship with the change | ~25 s |
| S3 Attack the live slot | + `auth-e2e` | live probes on the slot API: JWT forgery, token rotation, 120 + 7 route sweep, impersonation isolation | ~1–2 s |

```bash
har line gate S3 --line auth-change --agent <id>
cat .har/artifacts/auth-surface/report-agent-<id>.md
```

- **Program:** [`line.json`](line.json) (`gate.cumulative: true`, `handoff.autonomousShip: false`)
- **Reviewed weakenings:** [`security-acks.json`](security-acks.json). The S1 report prints the entry to add.
- **Intended suppressions** of the dangerous-pattern scan: put `// har-ack: <reason>` on the line.
- `auth-e2e` creates a throwaway user and account in `agent_<id>` and deletes them at the end.
- Edited a stage? Run `har line add auth-change --force` to re-copy it into `.har/stages/`.
