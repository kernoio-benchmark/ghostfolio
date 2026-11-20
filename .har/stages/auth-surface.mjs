// auth-surface — auth-change line, station S1 (static; no live app needed).
//
// Questions this gate asks of every auth change:
//   1. Does the route security inventory still hold? (app.module.spec in Jest
//      CI mode: unauthenticated routes == PUBLIC_ROUTES, snapshot unchanged
//      unless committed)
//   2. Did any route get WEAKER than on the merge base? (lost guard, lost
//      permission/scope, became public, newly allowed during impersonation,
//      lost value redaction) → must be acknowledged in security-acks.json
//   3. Did any role GAIN a permission? (privilege escalation) → same ledger
//   4. Does the diff add a known-dangerous auth pattern? (alg none, ignored
//      expiry, hard-coded secret, token in URL, decode-without-verify,
//      logging credentials, Math.random tokens)

import fs from 'node:fs';
import path from 'node:path';

import {
  ROUTE_SNAPSHOT,
  diffContext,
  fileAtBase,
  git,
  parseRouteSnapshot,
  readJson,
  runJest,
  runLineStage
} from './lib/factory-line.mjs';

const SECURITY_GUARDS = [
  "AuthGuard('jwt')",
  "AuthGuard('api-key')",
  'HasPermissionGuard',
  'ImpersonationGuard',
  'ImpersonationWriteGuard',
  'ScopeGuard'
];
const AUTH_GUARDS = ["AuthGuard('jwt')", "AuthGuard('api-key')"];

/** Every way a route can become less protected than it was. */
export function routeWeakenings(before, after) {
  const out = [];
  for (const [route, now] of Object.entries(after)) {
    const was = before[route];
    const authed = (now.guards ?? []).some((g) => AUTH_GUARDS.includes(g));
    if (!was) {
      if (!authed) out.push({ subject: route, change: 'new route without authentication' });
      continue;
    }
    for (const g of SECURITY_GUARDS) {
      if ((was.guards ?? []).includes(g) && !(now.guards ?? []).includes(g)) {
        out.push({ subject: route, change: `lost guard ${g}` });
      }
    }
    if (was.permission && was.permission !== now.permission) {
      out.push({ subject: route, change: `permission ${was.permission} → ${now.permission ?? 'none'}` });
    }
    for (const s of was.scopes ?? []) {
      if (!(now.scopes ?? []).includes(s)) out.push({ subject: route, change: `lost scope ${s}` });
    }
    if (!was.allowDuringImpersonation && now.allowDuringImpersonation) {
      out.push({ subject: route, change: 'now allowed during impersonation' });
    }
    if (
      (was.interceptors ?? []).includes('RedactValuesInResponseInterceptor') &&
      !(now.interceptors ?? []).includes('RedactValuesInResponseInterceptor')
    ) {
      out.push({ subject: route, change: 'lost RedactValuesInResponseInterceptor' });
    }
  }
  return out;
}

/** Role → permissions from libs/common/src/lib/permissions.ts getPermissions(). */
export function rolePermissions(source) {
  const roles = {};
  const body = /export function getPermissions[\s\S]*?switch[\s\S]*?\{([\s\S]*?)\n {2}\}\n\}/.exec(
    (source ?? '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  )?.[1];
  if (!body) return roles;
  for (const m of body.matchAll(/case '(\w+)':([\s\S]*?)(?=case '|default:|$)/g)) {
    roles[m[1]] = [...m[2].matchAll(/permissions\.(\w+)/g)].map((x) => x[1]);
  }
  return roles;
}

const DANGEROUS = [
  [/ignoreExpiration\s*:\s*true/, 'JWT expiry ignored (ignoreExpiration: true)'],
  [/algorithms\s*:\s*\[[^\]]*['"]none['"]/i, "JWT alg 'none' accepted"],
  [/secretOrKey\s*:\s*['"`]/, 'hard-coded JWT secret (secretOrKey literal)'],
  [/fromUrlQueryParameter|fromUrlQueryParam/, 'token read from URL query string'],
  [/\bjwt\.decode\(|jwtService\.decode\(/, 'JWT decoded without verification'],
  [/(console\.(log|info|debug)|[Ll]ogger\.(log|debug|verbose|warn|error))\([^)]*\b(accessToken|authToken|password|secret|apiKey|hashedKey)\b/, 'credential written to logs'],
  [/Math\.random\(\)/, 'Math.random() in auth code (not a CSPRNG)'],
  [/skipIf\s*:\s*\(\)\s*=>\s*true/, 'rate limiting unconditionally disabled']
];

await runLineStage('auth-surface', { lineId: 'auth-change', title: 'S1 auth surface' }, async (ctx, check) => {
  const { workDir } = ctx;
  const diff = diffContext(workDir);
  const acks = readJson(path.join(workDir, '.har/lines/auth-change/security-acks.json'), { acks: [] }).acks;
  const isAcked = (w) => acks.some((a) => a.subject === w.subject && a.change === w.change && a.reason);
  const ackReport = (items) => {
    const open = items.filter((w) => !isAcked(w));
    const lines = items.map((w) => `${isAcked(w) ? 'ACKED ' : 'OPEN  '} ${w.subject}: ${w.change}`);
    if (open.length) {
      throw new Error(
        `${open.length} unacknowledged weakening(s) vs ${diff.base}:\n${lines.join('\n')}\n\n` +
          'If intended, add each to .har/lines/auth-change/security-acks.json as\n' +
          open.map((w) => `  {"subject": ${JSON.stringify(w.subject)}, "change": ${JSON.stringify(w.change)}, "reason": "…"}`).join(',\n')
      );
    }
    return items.length ? lines.join('\n') : 'none';
  };

  await check('route security inventory (app.module.spec, Jest --ci)', async () => {
    const [r] = runJest(workDir, ['apps/api/src/app/app.module.spec.ts'], ctx.artifactsDir);
    if (r.code !== 0) {
      const failed = r.summary?.failedSuites?.map((s) => s.message).join('\n') || r.tail;
      throw new Error(`app.module.spec failed — a route's security changed without the snapshot/PUBLIC_ROUTES being updated:\n${failed}`);
    }
    return `${r.summary?.passedTests ?? '?'} tests passed`;
  });

  await check('no route weaker than on the merge base', async () => {
    const before = parseRouteSnapshot(fileAtBase(workDir, diff.baseSha, ROUTE_SNAPSHOT));
    const after = parseRouteSnapshot(fs.readFileSync(path.join(workDir, ROUTE_SNAPSHOT), 'utf8'));
    fs.writeFileSync(path.join(ctx.artifactsDir, `routes-agent-${ctx.agentId}.json`), JSON.stringify(after, null, 2));
    const added = Object.keys(after).filter((k) => !before[k]);
    const removed = Object.keys(before).filter((k) => !after[k]);
    const detail = ackReport(routeWeakenings(before, after));
    return `${Object.keys(after).length} routes · +${added.length} / -${removed.length}\nweakenings: ${detail}`;
  });

  await check('no role gained a permission (privilege escalation)', async () => {
    const file = 'libs/common/src/lib/permissions.ts';
    const before = rolePermissions(fileAtBase(workDir, diff.baseSha, file));
    const after = rolePermissions(fs.readFileSync(path.join(workDir, file), 'utf8'));
    if (Object.keys(after).length === 0) throw new Error(`could not parse getPermissions() in ${file}`);
    const gains = [];
    for (const [role, perms] of Object.entries(after)) {
      for (const p of perms) if (!(before[role] ?? []).includes(p)) gains.push({ subject: role, change: `gained permission ${p}` });
    }
    return `roles: ${Object.keys(after).join(', ')}\nescalations: ${ackReport(gains)}`;
  });

  await check('no dangerous auth pattern added by the diff', async () => {
    const patch = git(workDir, ['diff', '-U0', diff.baseSha, '--', 'apps/api/src', 'libs/common/src', ':(exclude)*.spec.ts']);
    const untracked = git(workDir, ['ls-files', '--others', '--exclude-standard', '--', 'apps/api/src', 'libs/common/src'])
      .split('\n')
      .filter((f) => f && !f.endsWith('.spec.ts'));
    const added = [];
    let file = '';
    for (const line of patch.split('\n')) {
      if (line.startsWith('+++ ')) file = line.slice(6);
      else if (line.startsWith('+') && !line.startsWith('+++')) added.push([file, line.slice(1)]);
    }
    for (const f of untracked) {
      for (const l of fs.readFileSync(path.join(workDir, f), 'utf8').split('\n')) added.push([f, l]);
    }
    const hits = [];
    for (const [f, l] of added) {
      if (/har-ack:/.test(l)) continue;
      for (const [re, what] of DANGEROUS) {
        if (re.test(l) && (what !== 'Math.random() in auth code (not a CSPRNG)' || /auth|token|key|session|access/i.test(f))) {
          hits.push(`${f}: ${what}\n    ${l.trim()}`);
        }
      }
    }
    if (hits.length) {
      throw new Error(`${hits.length} dangerous pattern(s) added (mark an intended line with "// har-ack: <reason>"):\n${hits.join('\n')}`);
    }
    return `${added.length} added line(s) scanned`;
  });
});
