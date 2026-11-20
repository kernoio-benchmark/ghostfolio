// banking-contract — banking-change line, station S1 (static).
//
// The ledger contract a banking change must keep:
//   1. Route policy: every account / balance / transfer route is behind JWT +
//      permission + impersonation + scope guards, mutations need a permission
//      and are blocked during impersonation, reads redact values; platform
//      routes are behind JWT + permission.
//   2. Schema invariants (prisma/schema.prisma): balances are per-user, unique
//      per account per day, cascade with their account; accounts are keyed by
//      (id, userId); platforms are unique by URL.
//   3. Migration safety: no applied migration is edited; no new migration
//      destroys banking data (DROP / TRUNCATE / DELETE / type change) unless
//      acknowledged in ledger-acks.json.

import fs from 'node:fs';
import path from 'node:path';

import {
  ROUTE_SNAPSHOT,
  diffContext,
  fileAtBase,
  parseRouteSnapshot,
  readJson,
  runLineStage
} from './lib/factory-line.mjs';

const BANKING_TABLES = ['Account', 'AccountBalance', 'Platform', 'TagsOnAccounts'];
const ACCOUNT_ROUTE = / \/(account|accounts|account-balance)(\/|$| )/;
const PLATFORM_ROUTE = / \/(platform|platforms)(\/|$| )/;

export function routePolicyViolations(routes) {
  const out = [];
  for (const [key, r] of Object.entries(routes)) {
    const guards = r.guards ?? [];
    const mutating = !key.startsWith('GET ');
    const need = (g) => guards.includes(g) || out.push(`${key}: missing ${g}`);
    if (ACCOUNT_ROUTE.test(key)) {
      ["AuthGuard('jwt')", 'HasPermissionGuard', 'ImpersonationGuard', 'ScopeGuard'].forEach(need);
      if (!(r.scopes ?? []).length) out.push(`${key}: no OAuth scope`);
      if (mutating && !r.permission) out.push(`${key}: mutation without @HasPermission`);
      if (mutating && r.allowDuringImpersonation) out.push(`${key}: mutation allowed during impersonation`);
      if (!mutating && !(r.interceptors ?? []).includes('RedactValuesInResponseInterceptor')) {
        out.push(`${key}: read without RedactValuesInResponseInterceptor`);
      }
    } else if (PLATFORM_ROUTE.test(key)) {
      ["AuthGuard('jwt')", 'HasPermissionGuard'].forEach(need);
      if (!r.permission) out.push(`${key}: no @HasPermission`);
    }
  }
  return out;
}

function model(schema, name) {
  return new RegExp(`^model ${name}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema)?.[1] ?? '';
}

/** [id, description, predicate(schema)] — the ledger invariants. */
export const SCHEMA_INVARIANTS = [
  ['Account.composite-key', 'Account is keyed by (id, userId)', (s) => /@@id\(\[id,\s*userId\]\)/.test(model(s, 'Account'))],
  ['Account.owned', 'Account.userId is required and cascades with its User', (s) =>
    /^\s*userId\s+String\s*$/m.test(model(s, 'Account')) && /user\s+User\s+@relation\([^)]*onDelete:\s*Cascade/.test(model(s, 'Account'))],
  ['AccountBalance.owned', 'AccountBalance belongs to (accountId, userId) and cascades with its Account', (s) =>
    /account\s+Account\s+@relation\(fields:\s*\[accountId,\s*userId\][^)]*onDelete:\s*Cascade[^)]*references:\s*\[id,\s*userId\]/.test(model(s, 'AccountBalance'))],
  ['AccountBalance.one-per-day', 'At most one balance per account, user and date', (s) =>
    /@@unique\(\[accountId,\s*userId,\s*date\]\)/.test(model(s, 'AccountBalance'))],
  ['AccountBalance.value-required', 'AccountBalance.value is a required number', (s) =>
    /^\s*value\s+(Float|Decimal)\s*$/m.test(model(s, 'AccountBalance'))],
  ['Platform.unique-url', 'Platform.url is unique', (s) => /^\s*url\s+String\s+@unique/m.test(model(s, 'Platform'))]
];

const DESTRUCTIVE = [
  [/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"(\w+)"/gi, 'DROP TABLE'],
  [/ALTER\s+TABLE\s+"(\w+)"[^;]*DROP\s+COLUMN/gi, 'DROP COLUMN'],
  [/ALTER\s+TABLE\s+"(\w+)"[^;]*ALTER\s+COLUMN\s+"\w+"\s+(?:SET\s+DATA\s+)?TYPE/gi, 'ALTER COLUMN TYPE'],
  [/TRUNCATE\s+(?:TABLE\s+)?"(\w+)"/gi, 'TRUNCATE'],
  [/DELETE\s+FROM\s+"(\w+)"/gi, 'DELETE FROM'],
  [/UPDATE\s+"(\w+)"\s+SET/gi, 'UPDATE (data rewrite)']
];

await runLineStage('banking-contract', { lineId: 'banking-change', title: 'S1 ledger contract' }, async (ctx, check) => {
  const { workDir } = ctx;
  const diff = diffContext(workDir);
  const acks = readJson(path.join(workDir, '.har/lines/banking-change/ledger-acks.json'), { acks: [] }).acks;
  const acked = (subject, change) => acks.some((a) => a.subject === subject && a.change === change && a.reason);

  await check('banking route policy (route security inventory)', async () => {
    const routes = parseRouteSnapshot(fs.readFileSync(path.join(workDir, ROUTE_SNAPSHOT), 'utf8'));
    const banking = Object.keys(routes).filter((k) => ACCOUNT_ROUTE.test(k) || PLATFORM_ROUTE.test(k));
    if (banking.length === 0) throw new Error('no banking route found in the inventory: the snapshot or the patterns moved');
    const v = routePolicyViolations(routes);
    if (v.length) throw new Error(`${v.length} policy violation(s):\n${v.map((x) => `  - ${x}`).join('\n')}`);
    return `${banking.length} banking routes comply`;
  });

  await check('ledger schema invariants (prisma/schema.prisma)', async () => {
    const schema = fs.readFileSync(path.join(workDir, 'prisma/schema.prisma'), 'utf8');
    const broken = SCHEMA_INVARIANTS.filter(([id, , ok]) => !ok(schema) && !acked(id, 'violated'));
    const lines = SCHEMA_INVARIANTS.map(([id, what, ok]) => `${ok(schema) ? 'ok  ' : acked(id, 'violated') ? 'ACK ' : 'FAIL'} ${id} — ${what}`);
    if (broken.length) {
      throw new Error(
        `${lines.join('\n')}\n\nIf intended, add to .har/lines/banking-change/ledger-acks.json:\n` +
          broken.map(([id]) => `  {"subject": "${id}", "change": "violated", "reason": "…"}`).join(',\n')
      );
    }
    return lines.join('\n');
  });

  await check('banking migrations: applied ones untouched, new ones non-destructive', async () => {
    const migrations = diff.files.filter((f) => /^prisma\/migrations\/.+\/migration\.sql$/.test(f));
    const problems = [];
    const notes = [];
    for (const f of migrations) {
      const abs = path.join(workDir, f);
      const existedAtBase = fileAtBase(workDir, diff.baseSha, f) !== null;
      if (!fs.existsSync(abs)) {
        problems.push({ subject: f, change: 'applied migration deleted' });
        continue;
      }
      const sql = fs.readFileSync(abs, 'utf8');
      const tables = BANKING_TABLES.filter((t) => sql.includes(`"${t}"`));
      if (!tables.length) continue;
      if (existedAtBase) {
        problems.push({ subject: f, change: 'applied migration edited' });
        continue;
      }
      notes.push(`${f}: touches ${tables.join(', ')}`);
      for (const [re, what] of DESTRUCTIVE) {
        for (const m of sql.matchAll(re)) {
          if (BANKING_TABLES.includes(m[1])) problems.push({ subject: f, change: `${what} on "${m[1]}"` });
        }
      }
    }
    const open = problems.filter((p) => !acked(p.subject, p.change));
    const list = problems.map((p) => `${acked(p.subject, p.change) ? 'ACKED' : 'OPEN '} ${p.subject}: ${p.change}`);
    if (open.length) {
      throw new Error(
        `${list.join('\n')}\n\nBanking data must never be destroyed silently. If intended, add to .har/lines/banking-change/ledger-acks.json:\n` +
          open.map((p) => `  {"subject": ${JSON.stringify(p.subject)}, "change": ${JSON.stringify(p.change)}, "reason": "…"}`).join(',\n')
      );
    }
    return [...notes, ...list].join('\n') || `no banking migration in the diff (${migrations.length} migration(s) checked)`;
  });
});
