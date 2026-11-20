# banking-change: banking change line

A HAR factory line for any change that touches cash accounts, account
balances, balance transfers or platforms (banks/brokers). The territory is in
[`triggers.json`](triggers.json). The overview and schema are in
[`../README.md`](../README.md).

| Station | Gate stage (cumulative) | Kind | Typical time |
|---|---|---|---|
| S1 Ledger contract | `banking-contract` | static: banking route policy, Prisma ledger invariants, migration safety | < 1 s |
| S2 Unit-prove the banking territory | + `banking-unit-tests` | Jest `--ci` over every banking spec; tests ship with the change | ~15 s |
| S3 Prove the ledger live | + `banking-e2e` | live: exact conservation, invalid transfers untouched, one balance per day, IDOR isolation, cascade | ~1–2 s |

```bash
har line gate S3 --line banking-change --agent <id>
cat .har/artifacts/banking-e2e/report-agent-<id>.md
```

- **Program:** [`line.json`](line.json) (`gate.cumulative: true`, `handoff.autonomousShip: false`)
- **Reviewed exceptions:** destructive migrations and invariant changes go in [`ledger-acks.json`](ledger-acks.json).
- `banking-e2e` stays in USD. Slots have no exchange-rate data, so cross-currency transfers fall back to 1:1 and conservation can't be asserted there.
- Edited a stage? Run `har line add banking-change --force`.
