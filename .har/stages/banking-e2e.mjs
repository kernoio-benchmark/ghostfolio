// banking-e2e — banking-change line, station S3: prove the ledger on the live slot.
//
// Against the slot API with throwaway accounts (deleted at the end):
//   - transfers conserve money exactly (incl. 0.1-step decimal drift)
//   - overdraw / zero / negative / non-numeric / self / unknown transfers are
//     rejected AND leave both balances untouched
//   - balance history: one entry per account per day (upsert), no future date
//   - cross-user isolation (IDOR): a second user cannot read, move, edit,
//     delete or append to someone else's account or balances
//   - deleting an account cascades its balances

import {
  PROBE_UUID,
  assert,
  http,
  runLineStage,
  signIn
} from './lib/factory-line.mjs';

const DEMO_TOKEN = 'har-demo-security-token';
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

await runLineStage('banking-e2e', { lineId: 'banking-change', title: 'S3 prove the ledger live' }, async (ctx, check) => {
  const api = `${ctx.apiBase}/v1`;
  const cleanup = [];
  let admin;
  let A;
  let B;

  const balanceOf = async (id, token = admin) => {
    const r = await http('GET', `${api}/accounts/${id}`, { token });
    assert(r.status === 200 && r.json, `GET /accounts/${id} → ${r.status}`);
    return r.json.balance;
  };
  const createAccount = async (token, name, balance, currency = 'USD') => {
    const r = await http('POST', `${api}/accounts`, { token, body: { name, currency, balance, platformId: null } });
    assert(r.status === 201, `create account ${name} → ${r.status} ${r.text.slice(0, 200)}`);
    cleanup.push(() => http('DELETE', `${api}/accounts/${r.json.id}`, { token }));
    return r.json.id;
  };
  const transfer = (token, accountIdFrom, accountIdTo, balance) =>
    http('POST', `${api}/accounts/transfer-balance`, { token, body: { accountIdFrom, accountIdTo, balance } });
  const unchanged = async (before, label) => {
    const [a, b] = [await balanceOf(A), await balanceOf(B)];
    assert(a === before[0] && b === before[1], `${label} changed balances: A ${before[0]}→${a}, B ${before[1]}→${b}`);
  };

  await check('setup: demo admin with two USD cash accounts', async () => {
    admin = await signIn(ctx.apiBase, DEMO_TOKEN);
    const tag = `har-banking-e2e-${Date.now()}`;
    A = await createAccount(admin, `${tag}-A`, 1000);
    B = await createAccount(admin, `${tag}-B`, 0);
    assert((await balanceOf(A)) === 1000 && (await balanceOf(B)) === 0, 'initial balances not stored');
    return `A=${A} (1000 USD), B=${B} (0 USD)`;
  });
  if (!A || !B) return;

  await check('transfer conserves money exactly (incl. 3 × 0.1)', async () => {
    let r = await transfer(admin, A, B, 250.1);
    assert(r.status === 201, `transfer 250.1 → ${r.status} ${r.text.slice(0, 200)}`);
    for (let i = 0; i < 3; i++) {
      r = await transfer(admin, A, B, 0.1);
      assert(r.status === 201, `transfer 0.1 #${i + 1} → ${r.status}`);
    }
    const [a, b] = [await balanceOf(A), await balanceOf(B)];
    assert(a === 749.6, `A = ${a}, expected exactly 749.6`);
    assert(b === 250.4, `B = ${b}, expected exactly 250.4 (decimal drift?)`);
    assert(a + b === 1000, `A + B = ${a + b}: money created or destroyed`);
    return `A=${a}, B=${b}, total=${a + b}`;
  });

  await check('invalid transfers are rejected and leave balances untouched', async () => {
    const before = [await balanceOf(A), await balanceOf(B)];
    const cases = [
      ['overdraw (more than the balance)', A, B, 1_000_000, [400]],
      ['zero amount', A, B, 0, [400]],
      ['negative amount (reverse pull)', A, B, -50, [400]],
      ['non-numeric amount', A, B, 'abc', [400]],
      ['same account', A, A, 1, [400]],
      ['unknown source account', PROBE_UUID, B, 1, [404]],
      ['unknown target account', A, PROBE_UUID, 1, [404]]
    ];
    const lines = [];
    for (const [name, from, to, amount, expected] of cases) {
      const r = await transfer(admin, from, to, amount);
      lines.push(`${r.status}  ${name}`);
      assert(expected.includes(r.status), `${name} → HTTP ${r.status} (expected ${expected.join('/')})`);
      await unchanged(before, name);
    }
    return lines.join('\n');
  });

  await check('balance history: one entry per day (upsert), no future dates', async () => {
    const date = day(-1);
    for (const balance of [500, 600]) {
      const r = await http('POST', `${api}/accounts/${A}/balances`, { token: admin, body: { balance, date } });
      assert(r.status === 201, `POST balance ${balance} @ ${date} → ${r.status} ${r.text.slice(0, 200)}`);
    }
    const hist = await http('GET', `${api}/accounts/${A}/balances`, { token: admin });
    const sameDay = (hist.json?.balances ?? []).filter((x) => String(x.date).startsWith(date));
    assert(sameDay.length === 1, `${sameDay.length} entries for ${date} (expected 1: upsert per day)`);
    assert(sameDay[0].value === 600, `entry for ${date} = ${sameDay[0].value}, expected the latest write (600)`);
    const future = await http('POST', `${api}/accounts/${A}/balances`, { token: admin, body: { balance: 1, date: day(+3) } });
    assert(future.status === 400, `future-dated balance → ${future.status} (expected 400)`);
    return `${date}: 1 entry = 600; future date → 400`;
  });

  await check('cross-user isolation (IDOR): user B cannot touch user A’s ledger', async () => {
    const signup = await http('POST', `${api}/user`, { body: {} });
    assert(signup.status === 201, `signup → ${signup.status}`);
    const other = signup.json.authToken;
    const otherId = (await http('GET', `${api}/user`, { token: other })).json?.id;
    cleanup.unshift(() => http('DELETE', `${api}/user/${otherId}`, { token: admin }));
    const C = await createAccount(other, 'other-user-cash', 10);

    const before = [await balanceOf(A), await balanceOf(B)];
    const hist = await http('GET', `${api}/accounts/${A}/balances`, { token: admin });
    const balanceId = hist.json.balances[0].id;
    const nameBefore = (await http('GET', `${api}/accounts/${A}`, { token: admin })).json.name;

    const attempts = [
      ['read account', 'GET', `/accounts/${A}`],
      ['read balances', 'GET', `/accounts/${A}/balances`],
      ['pull money A → own account', 'POST', '/accounts/transfer-balance', { accountIdFrom: A, accountIdTo: C, balance: 1 }],
      ['push into A from own account', 'POST', '/accounts/transfer-balance', { accountIdFrom: C, accountIdTo: A, balance: 1 }],
      ['rename account', 'PUT', `/accounts/${A}`, { id: A, name: 'pwned', currency: 'USD', platformId: null }],
      ['append balance', 'POST', `/accounts/${A}/balances`, { balance: 1, date: day(-2) }],
      ['append balance (legacy route)', 'POST', '/account-balance', { accountId: A, balance: 1, date: day(-2) }],
      ['delete balance entry', 'DELETE', `/account-balance/${balanceId}`],
      ['delete account', 'DELETE', `/accounts/${A}`]
    ];
    const lines = [];
    for (const [name, method, p, body] of attempts) {
      const r = await http(method, `${api}${p}`, { token: other, body });
      lines.push(`${r.status}  ${name}`);
      if (method === 'GET') {
        assert(!r.text.includes(A) && !(r.json?.balances ?? []).length, `${name}: leaked data (HTTP ${r.status})`);
      } else {
        assert(r.status >= 400, `${name}: ACCEPTED (HTTP ${r.status})`);
      }
    }
    await unchanged(before, 'cross-user attempts');
    const after = await http('GET', `${api}/accounts/${A}`, { token: admin });
    assert(after.json?.name === nameBefore, `account renamed to ${after.json?.name}`);
    const histAfter = await http('GET', `${api}/accounts/${A}/balances`, { token: admin });
    assert(histAfter.json.balances.some((x) => x.id === balanceId), 'balance entry deleted by another user');
    assert((await balanceOf(C, other)) === 10, 'other user’s own account balance changed');
    return lines.join('\n');
  });

  await check('deleting an account cascades its balances', async () => {
    const tmp = await createAccount(admin, 'har-banking-e2e-cascade', 77);
    await http('POST', `${api}/accounts/${tmp}/balances`, { token: admin, body: { balance: 70, date: day(-1) } });
    const del = await http('DELETE', `${api}/accounts/${tmp}`, { token: admin });
    assert(del.status === 200, `delete → ${del.status}`);
    const hist = await http('GET', `${api}/accounts/${tmp}/balances`, { token: admin });
    assert(!(hist.json?.balances ?? []).length, `${hist.json?.balances?.length} orphan balance(s) left`);
    const list = await http('GET', `${api}/accounts`, { token: admin });
    assert(!list.text.includes(tmp), 'deleted account still listed');
    return 'account gone, 0 balances left';
  });

  await check('cleanup of probe accounts and users', async () => {
    const codes = [];
    for (const fn of cleanup.reverse()) codes.push((await fn()).status);
    return codes.join(', ');
  });
});
