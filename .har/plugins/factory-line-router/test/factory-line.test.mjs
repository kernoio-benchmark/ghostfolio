// Self-test of the pure helpers in stages/lib/factory-line.mjs.
// Run: node --test .har/plugins/factory-line-router/test/
// (Stage behaviour end to end is proven by mutation runs, see .har/lines/README.md.)

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  cumulativeStages,
  globToRegExp,
  lineReasons,
  matchesAny,
  parseRouteSnapshot,
  routeToRequest,
  signJwt
} from '../stages/lib/factory-line.mjs';

test('globToRegExp: ** spans directories, * stays in one segment', () => {
  assert.ok(globToRegExp('apps/api/src/guards/**').test('apps/api/src/guards/a/b.ts'));
  assert.ok(globToRegExp('apps/**/*.spec.ts').test('apps/x.spec.ts'));
  assert.ok(globToRegExp('apps/**/*.spec.ts').test('apps/a/b/x.spec.ts'));
  assert.ok(!globToRegExp('libs/common/src/lib/dtos/*account*.ts').test('libs/common/src/lib/dtos/sub/account.ts'));
  assert.ok(globToRegExp('apps/api/src/helper/account.helper*').test('apps/api/src/helper/account.helper.spec.ts'));
  assert.ok(!matchesAny('apps/api/src/guardsX/a.ts', ['apps/api/src/guards/**']));
});

test('cumulativeStages: a stage is required from its station on (ratchet)', () => {
  const program = {
    stations: [{ id: 'S1' }, { id: 'S2' }, { id: 'S3' }],
    gate: { stages: [{ id: 'a', fromStation: 'S1' }, { id: 'b', fromStation: 'S2' }, { id: 'c', fromStation: 'S3' }] }
  };
  assert.deepEqual(cumulativeStages(program, 'S1'), ['a']);
  assert.deepEqual(cumulativeStages(program, 'S2'), ['a', 'b']);
  assert.deepEqual(cumulativeStages(program, 'S3'), ['a', 'b', 'c']);
});

test('lineReasons: paths (minus ignore), Prisma models and migrations trigger a line', () => {
  const line = { triggers: { paths: ['apps/api/src/guards/**'], ignore: ['**/*.scss'], prismaModels: ['User'] } };
  const none = lineReasons(line, { files: ['README.md', 'apps/api/src/guards/x.scss'], models: [], migrationTables: new Map() });
  assert.deepEqual(none, []);
  const hit = lineReasons(line, {
    files: ['apps/api/src/guards/scope.guard.ts'],
    models: ['User'],
    migrationTables: new Map([['User', new Set(['prisma/migrations/1/migration.sql'])]])
  });
  assert.equal(hit.length, 3);
});

test('parseRouteSnapshot + routeToRequest map inventory keys to slot URLs', () => {
  const snap =
    '// Jest Snapshot v1\n\nexports[`AppModule should keep the security of each route 1`] = `\n{\n  "GET /accounts/:id": {\n    "guards": [\n      "AuthGuard(\'jwt\')",\n    ],\n  },\n  "GET /x (version 2)": {\n    "guards": [],\n  },\n}\n`;\n';
  const routes = parseRouteSnapshot(snap);
  assert.deepEqual(Object.keys(routes), ['GET /accounts/:id', 'GET /x (version 2)']);
  assert.equal(routeToRequest('GET /accounts/:id', 'http://h/api', 'U').url, 'http://h/api/v1/accounts/U');
  assert.equal(routeToRequest('GET /x (version 2)', 'http://h/api', 'U').url, 'http://h/api/v2/x');
  assert.equal(routeToRequest('GET /y (version neutral)', 'http://h/api', 'U').url, 'http://h/api/y');
});

test('signJwt: HS256 signature verifies; alg none has an empty signature', () => {
  const t = signJwt({ id: 'u' }, 's3cret');
  const [h, p, s] = t.split('.');
  assert.equal(createHmac('sha256', 's3cret').update(`${h}.${p}`).digest('base64url'), s);
  assert.ok(signJwt({ id: 'u' }, null).endsWith('.'));
  assert.equal(JSON.parse(Buffer.from(signJwt({}, null).split('.')[0], 'base64url')).alg, 'none');
});
