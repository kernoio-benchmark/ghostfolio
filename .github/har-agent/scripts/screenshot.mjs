// Screenshot the pages the agent listed, signed in as the slot's demo admin.
// Usage: node screenshot.mjs <workDir> <agentId> <outDir>
// Reads <workDir>/.har/artifacts/issue-agent/pages.json (the agent writes it).
// Always captures "home" as a baseline that proves the slot app was up.
// Env: PLAYWRIGHT_DIR is a directory whose node_modules contains playwright.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [workDir, agentId, outDir] = process.argv.slice(2);
const require = createRequire(
  path.join(process.env.PLAYWRIGHT_DIR ?? process.cwd(), 'package.json')
);
const { chromium } = require('playwright');

const env = Object.fromEntries(
  fs
    .readFileSync(path.join(workDir, `.env.agent.${agentId}`), 'utf8')
    .split('\n')
    .map((l) =>
      l.replace(/^export\s+/, '').match(/^([A-Z0-9_]+)=["']?(.*?)["']?$/)
    )
    .filter(Boolean)
    .map((m) => [m[1], m[2]])
);
const fe = `http://localhost:${env.FE_PORT}`;
const api = `http://localhost:${env.API_PORT}`;

let pages = [];
const pagesFile = path.join(workDir, '.har/artifacts/issue-agent/pages.json');
try {
  pages = JSON.parse(fs.readFileSync(pagesFile, 'utf8'));
  if (!Array.isArray(pages)) throw new Error('pages.json must be an array');
} catch (e) {
  console.error(`pages.json: ${e.message} (screenshotting home only)`);
  pages = [];
}
pages = [
  {
    name: 'home',
    path: '/en/home',
    note: 'baseline: signed in on the slot app'
  },
  ...pages
]
  .filter((p) => p && typeof p.path === 'string' && p.path.startsWith('/'))
  .slice(0, 8);

const res = await fetch(`${api}/api/v1/auth/anonymous`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ accessToken: 'har-demo-security-token' })
});
if (!res.ok) throw new Error(`sign-in failed: HTTP ${res.status}`);
const { authToken } = await res.json();

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1
});
// Ghostfolio's TokenStorageService reads `auth-token` from session/local storage.
await context.addInitScript(
  (token) => window.localStorage.setItem('auth-token', token),
  authToken
);

const shots = [];
const used = new Set();
for (const p of pages) {
  let name =
    String(p.name || 'page')
      .replace(/[^a-z0-9-]+/gi, '-')
      .slice(0, 40) || 'page';
  while (used.has(name)) name += '-x';
  used.add(name);
  const file = `${String(shots.length + 1).padStart(2, '0')}-${name}.png`;
  const page = await context.newPage();
  const consoleErrors = [];
  page.on(
    'console',
    (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300))
  );
  const entry = { name, path: p.path, note: p.note ?? '', file, ok: false };
  try {
    const r = await page.goto(`${fe}${p.path}`, {
      waitUntil: 'networkidle',
      timeout: 90_000
    });
    entry.status = r?.status();
    if (p.waitFor) await page.waitForSelector(p.waitFor, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, file), fullPage: true });
    entry.ok = true;
  } catch (e) {
    entry.error = e.message.split('\n')[0];
    try {
      await page.screenshot({ path: path.join(outDir, file), fullPage: true });
    } catch {}
  }
  entry.consoleErrors = consoleErrors.slice(0, 5);
  shots.push(entry);
  console.error(
    `${entry.ok ? '✓' : '✗'} ${p.path} → ${file}${entry.error ? ` (${entry.error})` : ''}`
  );
  await page.close();
}
await browser.close();
fs.writeFileSync(
  path.join(outDir, 'screenshots.json'),
  JSON.stringify(shots, null, 2)
);
