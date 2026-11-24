// Shared runtime for the factory-line stages of this repository.
//
// Installed to .har/stages/lib/ by the factory-line-router plugin. Every line
// stage (auth-change, banking-change) and the router import it, so the stage
// contract (.har/STAGES.md) is implemented once:
//   - stdout: ONE normalized JSON result object; stderr: progress
//   - $1: agent slot id (falls back to $AGENT_ID)
//   - artifacts under .har/artifacts/<stage-id>/
//   - exit code = real status (0 = pass)
//
// On top of the contract each line stage writes a *gate stamp*: the exact
// working-tree fingerprint it ran against. The router (verify --full) uses the
// stamps to require a green line gate for the tree being verified, not for some
// earlier tree.
//
// Node built-ins only: the main checkout has no node_modules.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Slot context ─────────────────────────────────────────────────────────────

function parseEnvFile(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

/**
 * Resolves the slot the stage runs for. `har env verify` / `har line gate`
 * export WORK_DIR + ENV_FILE; direct invocation (`./.har/stages/x.sh 3`) does
 * not, so fall back to the slot registry like the other stages here do.
 */
export function slotContext(stageId) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const harnessDir =
    process.env.HAR_HARNESS_DIR || path.resolve(here, '..', '..');
  const agentId = process.argv[2] || process.env.AGENT_ID;
  if (!agentId) fatal(stageId, `Usage: ${stageId}.sh <agent-id>`);

  // `har env verify` exports WORK_DIR/ENV_FILE; `har line gate` and
  // `har env run-stage` do not, and when run from a session worktree their
  // HAR_HARNESS_DIR is the worktree's .har/ (no slots/ registry). Resolve in
  // order: exported env → registry next to this harness → registry in the main
  // checkout → the current git work tree if it holds .env.agent.<id>.
  let workDir = process.env.WORK_DIR;
  let envFile = process.env.ENV_FILE;
  if (!workDir || !envFile) {
    const registries = [path.join(harnessDir, 'slots', `agent-${agentId}.json`)];
    const main = mainCheckout(process.cwd());
    if (main) registries.push(path.join(main, '.har', 'slots', `agent-${agentId}.json`));
    const registry = registries.find((r) => fs.existsSync(r));
    if (registry) {
      workDir ||= JSON.parse(fs.readFileSync(registry, 'utf8')).workDir;
    } else {
      try {
        const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
        if (fs.existsSync(path.join(top, `.env.agent.${agentId}`))) workDir ||= top;
      } catch {
        // not in a git work tree
      }
    }
    if (workDir) envFile ||= path.join(workDir, `.env.agent.${agentId}`);
  }
  if (!workDir || !envFile || !fs.existsSync(envFile)) {
    fatal(
      stageId,
      `No slot env for agent ${agentId}: run har env launch ${agentId} first`,
      agentId
    );
  }
  const slotEnv = parseEnvFile(envFile);
  const artifactsDir = path.join(harnessDir, 'artifacts', stageId);
  fs.mkdirSync(artifactsDir, { recursive: true });
  return {
    agentId: Number(agentId),
    artifactsDir,
    envFile,
    harnessDir,
    slotEnv,
    stageId,
    workDir,
    apiBase: `http://localhost:${slotEnv.API_PORT}/api`
  };
}

function fatal(stageId, message, agentId = null) {
  process.stderr.write(`${message}\n`);
  process.stdout.write(
    JSON.stringify(
      { status: 'fail', stageId, kind: 'test', agent_id: agentId, error: message },
      null,
      2
    ) + '\n'
  );
  process.exit(1);
}

export const log = (msg) => process.stderr.write(`${msg}\n`);

// ── Git: diff scope and tree fingerprint ─────────────────────────────────────

export function git(workDir, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: workDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  }).trim();
}

/** The ref a change is compared against: HAR_LINE_BASE, else `main`. */
export function mergeBase(workDir) {
  const base = process.env.HAR_LINE_BASE || 'main';
  try {
    return { base, sha: git(workDir, ['merge-base', 'HEAD', base]) };
  } catch {
    return { base, sha: git(workDir, ['rev-parse', 'HEAD']) };
  }
}

/** Files changed vs the merge base: committed + staged + unstaged + untracked. */
export function changedFiles(workDir, baseSha) {
  const tracked = git(workDir, ['diff', '--name-only', baseSha]);
  const untracked = git(workDir, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')])]
    .filter(Boolean)
    .sort();
}

/**
 * Content hash of the working tree exactly as the stage sees it (tracked +
 * untracked, minus .gitignore), via a throwaway index. Equal fingerprints mean
 * the same code, independent of commits.
 */
export function treeFingerprint(workDir) {
  const tmpIndex = path.join(os.tmpdir(), `har-line-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    git(workDir, ['read-tree', 'HEAD'], { env });
    git(workDir, ['add', '-A', '.'], { env });
    return git(workDir, ['write-tree'], { env });
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

export function fileAtBase(workDir, baseSha, file) {
  try {
    return git(workDir, ['show', `${baseSha}:${file}`]);
  } catch {
    return null;
  }
}

// ── Lines, triggers and territory ────────────────────────────────────────────

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (file, globs) =>
  globs.some((g) => globToRegExp(g).test(file));

/** Every line program installed in the work dir, with its triggers.json. */
export function loadLines(workDir) {
  const root = path.join(workDir, '.har', 'lines');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(root, d.name);
      const programFile = path.join(dir, 'line.json');
      const triggerFile = path.join(dir, 'triggers.json');
      if (!fs.existsSync(programFile) || !fs.existsSync(triggerFile)) return null;
      return {
        dir,
        id: d.name,
        program: JSON.parse(fs.readFileSync(programFile, 'utf8')),
        triggers: JSON.parse(fs.readFileSync(triggerFile, 'utf8'))
      };
    })
    .filter(Boolean);
}

export function loadLine(workDir, lineId) {
  const line = loadLines(workDir).find((l) => l.id === lineId);
  if (!line) throw new Error(`line ${lineId} has no .har/lines/${lineId}/triggers.json`);
  return line;
}

/** Stage ids required at a station: the cumulative ratchet (fromStation ≤ station). */
export function cumulativeStages(program, stationId) {
  const order = new Map(program.stations.map((s, i) => [s.id, i]));
  const at = order.get(stationId);
  return program.gate.stages
    .filter((s) => order.get(s.fromStation) <= at)
    .map((s) => s.id);
}

function prismaModels(schema) {
  const models = new Map();
  for (const m of (schema ?? '').matchAll(/^(model|enum)\s+(\w+)\s*\{[\s\S]*?^\}/gm)) {
    models.set(m[2], m[0].replace(/\s+/g, ' '));
  }
  return models;
}

/** Prisma models/enums whose definition differs between the base and the tree. */
export function changedPrismaModels(workDir, baseSha) {
  const before = prismaModels(fileAtBase(workDir, baseSha, 'prisma/schema.prisma'));
  const nowFile = path.join(workDir, 'prisma/schema.prisma');
  const after = prismaModels(fs.existsSync(nowFile) ? fs.readFileSync(nowFile, 'utf8') : '');
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n));
}

/** Tables ("Model") referenced by migration SQL files added/changed in the diff. */
export function tablesInChangedMigrations(workDir, files) {
  const tables = new Map();
  for (const f of files.filter((f) => /^prisma\/migrations\/.+\.sql$/.test(f))) {
    const abs = path.join(workDir, f);
    if (!fs.existsSync(abs)) continue;
    for (const m of fs.readFileSync(abs, 'utf8').matchAll(/"([A-Z]\w*)"/g)) {
      if (!tables.has(m[1])) tables.set(m[1], new Set());
      tables.get(m[1]).add(f);
    }
  }
  return tables;
}

/**
 * Why a line is triggered by the change: matching paths, changed Prisma models,
 * and migrations touching its tables. Empty list = line not triggered.
 */
export function lineReasons(line, ctx) {
  const t = line.triggers;
  const reasons = [];
  const ignore = t.ignore ?? [];
  for (const f of ctx.files) {
    if (matchesAny(f, t.paths ?? []) && !matchesAny(f, ignore)) reasons.push(`path ${f}`);
  }
  for (const m of ctx.models) {
    if ((t.prismaModels ?? []).includes(m)) reasons.push(`prisma model ${m}`);
  }
  for (const [table, files] of ctx.migrationTables) {
    if ((t.prismaModels ?? []).includes(table)) {
      reasons.push(`migration on "${table}" (${[...files].join(', ')})`);
    }
  }
  return [...new Set(reasons)];
}

export function diffContext(workDir) {
  const { base, sha } = mergeBase(workDir);
  const files = changedFiles(workDir, sha);
  return {
    base,
    baseSha: sha,
    files,
    migrationTables: tablesInChangedMigrations(workDir, files),
    models: changedPrismaModels(workDir, sha)
  };
}

// ── Gate stamps ──────────────────────────────────────────────────────────────

/** The main checkout (parent of the shared .git dir) of any work tree. */
export function mainCheckout(dir) {
  try {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return path.dirname(common);
  } catch {
    return null;
  }
}

// Stamps always live in the MAIN checkout's .har/artifacts, whichever entry
// point ran the stage (line gate from the worktree, verify from the main
// checkout, MCP, …), so the gate and the router always see the same stamps.
const stampFile = (workDir, agentId, stageId) =>
  path.join(mainCheckout(workDir) ?? workDir, '.har', 'artifacts', 'factory-line-stamps', `agent-${agentId}`, `${stageId}.json`);

export function writeStamp(ctx, data) {
  const file = stampFile(ctx.workDir, ctx.agentId, ctx.stageId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function readStamp(workDir, agentId, stageId) {
  const file = stampFile(workDir, agentId, stageId);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// ── Route security inventory (apps/api app.module.spec snapshot) ─────────────

export const ROUTE_SNAPSHOT = 'apps/api/src/app/__snapshots__/app.module.spec.ts.snap';

/** Parses the Jest snapshot `AppModule should keep the security of each route`. */
export function parseRouteSnapshot(text) {
  if (!text) return {};
  const m = /exports\[`AppModule should keep the security of each route 1`\] = `\n([\s\S]*?)\n`;/.exec(
    text
  );
  if (!m) throw new Error('route security snapshot not found');
  return JSON.parse(m[1].replace(/,(\s*[}\]])/g, '$1'));
}

/** "GET /accounts/:id (version 2)" → { method, path, url } against /api. */
export function routeToRequest(key, apiBase, paramValue) {
  const m = /^(\w+) (\S+)(?: \(version ([^)]+)\))?$/.exec(key);
  const [, method, routePath, version = '1'] = m;
  const concrete = routePath.replace(/:\w+/g, paramValue);
  const prefix = version === 'neutral' ? '' : `/v${version.split(',')[0].trim()}`;
  return { method, path: routePath, url: `${apiBase}${prefix}${concrete}` };
}

// ── HTTP + JWT helpers for live probes ───────────────────────────────────────

export async function http(method, url, { token, headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text };
}

const b64url = (v) =>
  Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** HS256 JWT, or alg "none" when secret is null. */
export function signJwt(payload, secret, alg = 'HS256') {
  const head = `${b64url({ alg: secret === null ? 'none' : alg, typ: 'JWT' })}.${b64url(payload)}`;
  if (secret === null) return `${head}.`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

export async function signIn(apiBase, accessToken) {
  const r = await http('POST', `${apiBase}/v1/auth/anonymous`, { body: { accessToken } });
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`sign-in failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }
  return r.json.authToken;
}

// ── Jest ─────────────────────────────────────────────────────────────────────

function jestConfigFor(workDir, file) {
  let dir = path.dirname(path.join(workDir, file));
  while (dir.startsWith(workDir) && dir !== workDir) {
    const cfg = path.join(dir, 'jest.config.ts');
    if (fs.existsSync(cfg)) return path.relative(workDir, cfg);
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Runs spec files grouped by Jest project, in CI mode (snapshots are never
 * written: an outdated snapshot fails instead of being silently updated).
 * Env comes from .env.example, as `npm run test` does.
 */
export function runJest(workDir, specFiles, artifactsDir) {
  const groups = new Map();
  for (const f of specFiles) {
    const cfg = jestConfigFor(workDir, f);
    if (!cfg) continue;
    if (!groups.has(cfg)) groups.set(cfg, []);
    groups.get(cfg).push(f);
  }
  const exampleEnv = fs.existsSync(path.join(workDir, '.env.example'))
    ? parseEnvFile(path.join(workDir, '.env.example'))
    : {};
  const results = [];
  for (const [cfg, files] of groups) {
    const reportFile = path.join(artifactsDir, `jest-${path.basename(path.dirname(cfg))}.json`);
    log(`  jest ${cfg}: ${files.length} spec file(s)`);
    const r = spawnSync(
      path.join(workDir, 'node_modules/.bin/jest'),
      ['--config', cfg, '--ci', '--silent', '--json', `--outputFile=${reportFile}`, '--runTestsByPath', ...files],
      {
        cwd: workDir,
        encoding: 'utf8',
        env: { ...exampleEnv, ...process.env, NX_DAEMON: 'false' },
        maxBuffer: 64 * 1024 * 1024
      }
    );
    let summary = null;
    if (fs.existsSync(reportFile)) {
      const j = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
      summary = {
        failedTests: j.numFailedTests,
        passedTests: j.numPassedTests,
        failedSuites: j.testResults
          .filter((s) => s.status !== 'passed')
          .map((s) => ({
            file: path.relative(workDir, s.name),
            message: (s.message || '').split('\n').slice(0, 25).join('\n')
          }))
      };
    }
    results.push({
      config: cfg,
      files,
      code: r.status,
      summary,
      tail: (r.stderr || '').split('\n').slice(-30).join('\n')
    });
  }
  return results;
}

// ── Stage runner ─────────────────────────────────────────────────────────────

/**
 * Runs named checks, writes report.md + result.json artifacts and the gate
 * stamp, prints the normalized result and exits with the real status.
 *
 * `body(ctx, check)`: `await check(name, async () => detail)`; a check fails
 * when its function throws (Error.message = why).
 */
export async function runLineStage(stageId, { lineId, title }, body) {
  const ctx = slotContext(stageId);
  const started = Date.now();
  const checks = [];
  log(`==> [${stageId} agent-${ctx.agentId}] ${title} (line ${lineId}) in ${ctx.workDir}`);

  const tree = treeFingerprint(ctx.workDir);
  const head = git(ctx.workDir, ['rev-parse', 'HEAD']);

  const check = async (name, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, pass: true, ms: Date.now() - t0, detail: detail ?? '' });
      log(`  ✓ ${name}`);
    } catch (error) {
      checks.push({ name, pass: false, ms: Date.now() - t0, detail: error.message });
      log(`  ✗ ${name}\n${error.message.replace(/^/gm, '      ')}`);
    }
  };

  try {
    await body(ctx, check);
  } catch (error) {
    checks.push({ name: 'stage crashed', pass: false, ms: 0, detail: error.stack || String(error) });
    log(`  ✗ stage crashed: ${error.stack || error}`);
  }

  const pass = checks.length > 0 && checks.every((c) => c.pass);
  const status = pass ? 'pass' : 'fail';
  const finishedAt = new Date().toISOString();

  const report = [
    `# ${stageId} — ${status.toUpperCase()}`,
    '',
    `- line: \`${lineId}\` · agent ${ctx.agentId} · ${finishedAt}`,
    `- HEAD \`${head}\` · tree fingerprint \`${tree}\``,
    '',
    '| | check | ms |',
    '|---|---|---|',
    ...checks.map((c) => `| ${c.pass ? '✅' : '❌'} | ${c.name} | ${c.ms} |`),
    '',
    ...checks.filter((c) => c.detail).flatMap((c) => [`## ${c.pass ? '✅' : '❌'} ${c.name}`, '', '```', String(c.detail), '```', ''])
  ].join('\n');
  fs.writeFileSync(path.join(ctx.artifactsDir, `report-agent-${ctx.agentId}.md`), report);
  const result = {
    status,
    stageId,
    kind: 'test',
    agent_id: ctx.agentId,
    line: lineId,
    total_ms: Date.now() - started,
    head,
    tree,
    checks: checks.map(({ name, pass, ms }) => ({ name, pass, ms })),
    failures: checks.filter((c) => !c.pass).map(({ name, detail }) => ({ name, detail: String(detail).slice(0, 2000) })),
    report: path.relative(path.dirname(ctx.harnessDir), path.join(ctx.artifactsDir, `report-agent-${ctx.agentId}.md`))
  };
  fs.writeFileSync(path.join(ctx.artifactsDir, `result-agent-${ctx.agentId}.json`), JSON.stringify(result, null, 2));
  writeStamp(ctx, { stageId, line: lineId, status, tree, head, workDir: ctx.workDir, finishedAt });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(pass ? 0 : 1);
}

/** Tracked + untracked (non-ignored) files of the work dir. */
export function listFiles(workDir) {
  return git(workDir, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter((f) => f && fs.existsSync(path.join(workDir, f)));
}

/**
 * Station "unit-prove" shared by every line:
 *   - every spec in the line's territory (triggers.specs + specs under
 *     triggers.paths) passes, in Jest CI mode;
 *   - tests ship with the change: when the diff touches production source in
 *     the territory, it also adds or changes at least one spec there.
 */
export async function unitProveStage(stageId, lineId) {
  await runLineStage(stageId, { lineId, title: 'S2 unit-prove the territory' }, async (ctx, check) => {
    const { workDir } = ctx;
    const line = loadLine(workDir, lineId);
    const t = line.triggers;
    const diff = diffContext(workDir);
    const isSpec = (f) => /\.spec\.ts$/.test(f);
    const inTerritory = (f) => matchesAny(f, t.paths ?? []) && !matchesAny(f, t.ignore ?? []);
    const specs = listFiles(workDir).filter(
      (f) => isSpec(f) && (matchesAny(f, t.specs ?? []) || inTerritory(f))
    );

    await check(`tests ship with the change`, async () => {
      const source = diff.files.filter(
        (f) => inTerritory(f) && !isSpec(f) && /\.(ts|mjs)$/.test(f) && !f.startsWith('.har/') && !f.endsWith('.snap')
      );
      const specChanges = diff.files.filter((f) => isSpec(f) && (inTerritory(f) || matchesAny(f, t.specs ?? [])));
      if (source.length && !specChanges.length) {
        throw new Error(
          `The diff changes ${source.length} ${lineId} source file(s) but no spec in the territory:\n` +
            source.map((f) => `  - ${f}`).join('\n') +
            `\nAdd or extend a *.spec.ts next to the code (see triggers.json "specs").`
        );
      }
      return source.length ? `source: ${source.join(', ')}\nspecs: ${specChanges.join(', ')}` : 'no territory source changed';
    });

    await check(`${specs.length} territory spec file(s) pass (Jest --ci)`, async () => {
      if (!specs.length) throw new Error('no spec found in the territory: triggers.json "specs" is stale');
      const results = runJest(workDir, specs, ctx.artifactsDir);
      const failed = results.filter((r) => r.code !== 0);
      const passedTests = results.reduce((n, r) => n + (r.summary?.passedTests ?? 0), 0);
      if (failed.length) {
        throw new Error(
          failed
            .map((r) => `${r.config}:\n` + (r.summary?.failedSuites?.map((s) => `  ${s.file}\n${s.message}`).join('\n') || r.tail))
            .join('\n')
        );
      }
      return `${passedTests} tests passed in:\n${specs.map((f) => `  - ${f}`).join('\n')}`;
    });
  });
}

export const PROBE_UUID = '00000000-0000-4000-8000-00000000dead';

export function assert(cond, message) {
  if (!cond) throw new Error(message);
}

export function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
