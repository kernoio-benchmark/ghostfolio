// auth-e2e — auth-change line, station S3: attack the live slot API.
//
// Every negative probe has a positive control, so a pass means "rejected"
// and not "the probe was broken":
//   - JWT forgery matrix on GET /v1/user (wrong secret, alg none, expired,
//     tampered payload, unknown user) vs a self-signed valid token → 200
//   - security-token sign-in (wrong token 403) and token rotation (old token
//     dead, new token works)
//   - route sweep: every route the inventory says is behind AuthGuard('jwt')
//     or AuthGuard('api-key') rejects anonymous and forged callers
//   - impersonation and cross-user isolation: user B can't impersonate or read
//     user A without an access grant
// Test users/accounts it creates are deleted at the end.

import fs from 'node:fs';
import path from 'node:path';

import {
  PROBE_UUID,
  ROUTE_SNAPSHOT,
  assert,
  http,
  parseRouteSnapshot,
  routeToRequest,
  runLineStage,
  signIn,
  signJwt
} from './lib/factory-line.mjs';

const DEMO_TOKEN = 'har-demo-security-token';
const now = () => Math.floor(Date.now() / 1000);

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

await runLineStage('auth-e2e', { lineId: 'auth-change', title: 'S3 attack the live slot' }, async (ctx, check) => {
  const api = ctx.apiBase;
  const secret = ctx.slotEnv.JWT_SECRET_KEY;
  const cleanup = [];
  let adminToken;
  let adminId;

  await check('slot API healthy and demo admin can sign in', async () => {
    const h = await http('GET', `${api}/v1/health`);
    assert(h.status === 200, `GET /v1/health → ${h.status}`);
    adminToken = await signIn(api, DEMO_TOKEN);
    const me = await http('GET', `${api}/v1/user`, { token: adminToken });
    assert(me.status === 200 && me.json?.id, `GET /v1/user with a fresh JWT → ${me.status}`);
    adminId = me.json.id;
    return `admin ${adminId}`;
  });
  if (!adminToken) return;

  await check('JWT forgery matrix on GET /v1/user', async () => {
    assert(secret, 'JWT_SECRET_KEY missing from the slot env');
    const valid = { id: adminId, iat: now() - 10, exp: now() + 600 };
    const control = await http('GET', `${api}/v1/user`, { token: signJwt(valid, secret) });
    assert(control.status === 200, `positive control (self-signed with the slot secret) → ${control.status}; probe is broken`);

    const [h, p] = adminToken.split('.');
    const tampered = JSON.parse(Buffer.from(p, 'base64url'));
    tampered.id = PROBE_UUID;
    const cases = [
      ['no Authorization header', null, null],
      ['garbage bearer', 'not-a-jwt', null],
      ['signed with a wrong secret', signJwt(valid, `${secret}-wrong`), null],
      ['alg "none" (unsigned)', signJwt(valid, null), null],
      ['expired (exp in the past, right secret)', signJwt({ ...valid, iat: now() - 7200, exp: now() - 3600 }, secret), null],
      ['payload tampered, signature kept', `${h}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${adminToken.split('.')[2]}`, null],
      ['valid signature, unknown user', signJwt({ ...valid, id: PROBE_UUID }, secret), null]
    ];
    const lines = [];
    for (const [name, token] of cases) {
      const r = await http('GET', `${api}/v1/user`, token ? { token } : {});
      lines.push(`${r.status}  ${name}`);
      assert(r.status >= 400, `${name} was ACCEPTED (HTTP ${r.status})`);
      assert(!r.json?.id, `${name} leaked a user object`);
    }
    return `control 200\n${lines.join('\n')}`;
  });

  await check('security-token sign-in rejects wrong / empty tokens', async () => {
    const wrong = await http('POST', `${api}/v1/auth/anonymous`, { body: { accessToken: 'definitely-wrong' } });
    assert(wrong.status === 403, `wrong security token → ${wrong.status} (expected 403)`);
    assert(!wrong.json?.authToken, 'wrong security token returned an authToken');
    const empty = await http('POST', `${api}/v1/auth/anonymous`, { body: {} });
    assert(empty.status >= 400 && empty.status < 500, `empty body → ${empty.status}`);
    return `wrong → 403, empty → ${empty.status}`;
  });

  // Inventory-driven sweep: every authenticated route, as anonymous and forged.
  const routes = parseRouteSnapshot(fs.readFileSync(path.join(ctx.workDir, ROUTE_SNAPSHOT), 'utf8'));
  const jwtRoutes = Object.entries(routes).filter(([, v]) => (v.guards ?? []).includes("AuthGuard('jwt')"));
  const keyRoutes = Object.entries(routes).filter(([, v]) => (v.guards ?? []).includes("AuthGuard('api-key')"));
  const sweep = async (entries, opts, label) => {
    const results = await pool(entries, 8, async ([key]) => {
      const req = routeToRequest(key, api, PROBE_UUID);
      const r = await http(req.method, req.url, { ...opts, body: req.method === 'GET' ? undefined : {} });
      return { key, status: r.status };
    });
    fs.writeFileSync(
      path.join(ctx.artifactsDir, `sweep-${label}-agent-${ctx.agentId}.json`),
      JSON.stringify(results, null, 2)
    );
    const open = results.filter((r) => r.status !== 401 && r.status !== 403);
    if (open.length) {
      throw new Error(`${open.length}/${results.length} route(s) did not reject the caller:\n${open.map((r) => `  ${r.status}  ${r.key}`).join('\n')}`);
    }
    const by = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    return `${results.length} routes rejected · ${JSON.stringify(by)}`;
  };

  await check(`route sweep: ${jwtRoutes.length} JWT routes reject anonymous callers`, () => sweep(jwtRoutes, {}, 'jwt-anonymous'));
  await check(`route sweep: ${jwtRoutes.length} JWT routes reject a wrong-secret token`, () =>
    sweep(jwtRoutes, { token: signJwt({ id: adminId, iat: now(), exp: now() + 600 }, `${secret}-wrong`) }, 'jwt-forged')
  );
  await check(`route sweep: ${keyRoutes.length} API-key routes reject missing / bogus keys`, async () => {
    const a = await sweep(keyRoutes, {}, 'apikey-missing');
    const b = await sweep(keyRoutes, { headers: { Authorization: 'Api-Key bogus-key-0000' } }, 'apikey-bogus');
    return `${a}\n${b}`;
  });

  // Second, unprivileged user for rotation / isolation probes.
  let userB;
  await check('security-token rotation kills the old token', async () => {
    const signup = await http('POST', `${api}/v1/user`, { body: {} });
    assert(signup.status === 201, `signup → ${signup.status} ${signup.text.slice(0, 200)}`);
    userB = { accessToken: signup.json.accessToken, token: signup.json.authToken };
    const me = await http('GET', `${api}/v1/user`, { token: userB.token });
    userB.id = me.json?.id;
    cleanup.push(() => http('DELETE', `${api}/v1/user/${userB.id}`, { token: adminToken }));

    const bad = await http('POST', `${api}/v1/user/access-token`, { token: userB.token, body: { accessToken: 'wrong' } });
    assert(bad.status >= 400, `rotation with a wrong current token → ${bad.status} (accepted!)`);
    const rot = await http('POST', `${api}/v1/user/access-token`, { token: userB.token, body: { accessToken: userB.accessToken } });
    assert(rot.status === 201 && rot.json?.accessToken, `rotation → ${rot.status}`);
    const oldSignIn = await http('POST', `${api}/v1/auth/anonymous`, { body: { accessToken: userB.accessToken } });
    assert(oldSignIn.status === 403, `old security token still signs in (HTTP ${oldSignIn.status})`);
    const newSignIn = await http('POST', `${api}/v1/auth/anonymous`, { body: { accessToken: rot.json.accessToken } });
    assert(newSignIn.status === 201, `new security token cannot sign in (HTTP ${newSignIn.status})`);
    return `wrong current → ${bad.status}, rotate → 201, old → 403, new → 201`;
  });

  await check('impersonation and reads cannot cross users without a grant', async () => {
    assert(userB?.token, 'user B unavailable (previous check failed)');
    const marker = `har-auth-e2e-${Date.now()}`;
    const acct = await http('POST', `${api}/v1/accounts`, {
      token: adminToken,
      body: { name: marker, currency: 'USD', balance: 4242, platformId: null }
    });
    assert(acct.status === 201, `admin create account → ${acct.status}`);
    cleanup.push(() => http('DELETE', `${api}/v1/accounts/${acct.json.id}`, { token: adminToken }));

    const own = await http('GET', `${api}/v1/accounts`, { token: adminToken });
    assert(own.text.includes(marker), 'positive control: admin cannot see own account');

    const imp = await http('GET', `${api}/v1/accounts`, { token: userB.token, headers: { 'Impersonation-Id': adminId } });
    assert(!imp.text.includes(marker), `user B impersonated admin without a grant (HTTP ${imp.status})`);
    const direct = await http('GET', `${api}/v1/accounts/${acct.json.id}`, { token: userB.token });
    assert(!direct.text.includes(marker) && !direct.text.includes('4242'), `user B read admin's account by id (HTTP ${direct.status})`);
    const adminList = await http('GET', `${api}/v1/admin/user`, { token: userB.token });
    assert(adminList.status === 403, `user B reached admin user list (HTTP ${adminList.status})`);
    return `impersonate → ${imp.status}, read-by-id → ${direct.status} (no data), admin API → 403`;
  });

  await check('cleanup of probe users and accounts', async () => {
    const codes = [];
    for (const fn of cleanup.reverse()) codes.push((await fn()).status);
    assert(codes.every((c) => c < 300), `cleanup returned ${codes.join(', ')}`);
    return codes.join(', ') || 'nothing to clean';
  });
});
