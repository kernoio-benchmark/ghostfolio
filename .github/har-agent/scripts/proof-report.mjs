// Build the PR body (and a verdict) from the HAR evidence the workflow collected.
// Usage: node proof-report.mjs <proofDir>
// Reads <proofDir>/{meta,verify,triggered,line-status,agent-result}.json,
// lines/*.json, summary.md, screenshots/screenshots.json.
// Writes <proofDir>/pr-body.md, <proofDir>/verdict.json and prints the verdict.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2]);
const read = (f, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch {
    return fallback;
  }
};
const text = (f) => {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8').trim();
  } catch {
    return '';
  }
};
const ms = (n) =>
  n == null
    ? ''
    : n >= 60_000
      ? `${(n / 60_000).toFixed(1)} min`
      : `${(n / 1000).toFixed(1)} s`;
const icon = (ok) => (ok ? '✅' : '❌');

const meta = read('meta.json', {});
const verify = read('verify.json');
const triggered = read('triggered.json', []);
const lineStatus = read('line-status.json', []);
const agent = read('agent-result.json', {});
const shots = read('screenshots/screenshots.json', []);
const gates = triggered.map((t) => ({
  ...t,
  gate: read(`lines/${t.line}.json`)
}));
const validation = meta.validation ?? null;

const verifyPass = verify?.status === 'pass';
const linesPass = gates.every((g) => g.gate?.pass === true);
const boundToCommit =
  validation?.status === 'pass' &&
  validation?.full === true &&
  validation?.treeHash === meta.tree;
const ok = verifyPass && linesPass && boundToCommit;

const L = [];
L.push(`Closes #${meta.issue.number}`);
L.push('');
L.push(
  `Opened by the [HAR issue agent](${meta.runUrl}) for issue #${meta.issue.number}: **${meta.issue.title}**. ` +
    `Claude Code (\`${meta.model}\`) made the change in HAR slot ${meta.agentId}. The workflow then checked the commit itself.`
);
L.push('');
L.push(
  ok
    ? "> [!NOTE]\n> **HAR verdict: green.** `har env verify --full` passed on exactly this commit's tree, and so did every factory line the diff triggered."
    : '> [!WARNING]\n> **HAR verdict: red.** This PR is a draft. Read the failing checks below before you review the code.'
);
L.push('');

const summary = text('summary.md');
L.push('## What the agent did');
L.push('');
L.push(summary || '_The agent wrote no `summary.md`._');
L.push('');

L.push('## Proof 1: full HAR verification');
L.push('');
L.push('| Stage | Result | Time |');
L.push('|---|---|---|');
for (const s of verify?.stages ?? []) {
  L.push(
    `| \`${s.name}\` | ${icon(s.pass)}${s.skipped ? ' skipped' : ''} | ${ms(s.ms)} |`
  );
}
if (!verify) L.push('| `har env verify --full` | ❌ produced no result | |');
L.push('');
L.push(
  `- Verified tree \`${meta.tree}\` = PR head \`${meta.headSha?.slice(0, 12)}\`'s tree: ${icon(boundToCommit)} ` +
    (validation
      ? `(HAR validation \`${validation.validationId}\`, run \`${validation.runId}\`, full=${validation.full}, status=${validation.status})`
      : '(no HAR validation record for this tree)')
);
for (const s of (verify?.stages ?? []).filter((x) => !x.pass)) {
  const out = s.output ?? s.excerpt ?? s.error ?? s.stderr ?? s.stdout;
  if (!out) continue;
  const body = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  L.push('');
  L.push(
    `<details><summary>❌ <code>${s.name}</code> output</summary>\n\n\`\`\`text\n${body.slice(-3000)}\n\`\`\`\n</details>`
  );
}
L.push('');

L.push('## Proof 2: factory lines');
L.push('');
if (gates.length === 0) {
  L.push(
    'The diff touches no factory-line territory (auth or banking), so `factory-line-router` passed without a gate.'
  );
} else {
  L.push('| Line | Why it triggered | Gate | Stages |');
  L.push('|---|---|---|---|');
  for (const g of gates) {
    const why =
      g.reasons.slice(0, 4).join('<br>') +
      (g.reasons.length > 4 ? `<br>… ${g.reasons.length - 4} more` : '');
    const stages = (g.gate?.stages ?? [])
      .map((s) => `${s.status === 'pass' ? '✅' : '❌'} \`${s.stageId}\``)
      .join('<br>');
    L.push(
      `| \`${g.line}\` | ${why} | ${icon(g.gate?.pass)} ${g.finalStation} (cumulative) | ${stages || 'no result'} |`
    );
  }
}
if (lineStatus.length) {
  L.push('');
  L.push('<details><summary><code>har line status</code></summary>\n');
  for (const l of lineStatus) {
    const stations = (l.stations ?? [])
      .map((s) => `${s.green ? '🟢' : '⚪'} ${s.id}`)
      .join(' → ');
    L.push(`- \`${l.lineId}\`: ${stations}`);
  }
  L.push('</details>');
}
L.push('');

L.push('## Proof 3: the change in the running app');
L.push('');
if (!shots.length) {
  L.push('_No screenshots were captured._');
} else {
  L.push(
    `Captured with Playwright from HAR slot ${meta.agentId}, signed in as the slot's demo admin.`
  );
  for (const s of shots) {
    L.push('');
    L.push(
      `**\`${s.path}\`**${s.note ? `: ${s.note}` : ''}${s.ok ? '' : ` ⚠️ ${s.error ?? 'capture failed'}`}`
    );
    L.push('');
    L.push(
      `<img src="${meta.proofsUrl}/screenshots/${s.file}" width="900" alt="${s.name}">`
    );
  }
}
L.push('');

L.push('## Run facts');
L.push('');
L.push('| | |');
L.push('|---|---|');
L.push(`| Workflow run | ${meta.runUrl} |`);
L.push(`| Base | \`main\` @ \`${meta.baseSha?.slice(0, 12)}\` |`);
L.push(`| Diff | ${meta.diffstat || 'n/a'} |`);
L.push(
  `| Agent | Claude Code \`${meta.model}\`, ${agent.num_turns ?? '?'} turns, ${ms(agent.duration_ms)}${agent.total_cost_usd != null ? `, $${Number(agent.total_cost_usd).toFixed(2)}` : ''} |`
);
L.push(
  `| Evidence | the \`har-evidence\` artifact on the run (\`.har/runs\`, \`.har/validations\`, stage reports, agent transcript) and [proof files](${meta.proofsTreeUrl}) |`
);
L.push('');
L.push(
  "No CI executes on this PR. The bot opened it with `GITHUB_TOKEN`, so GitHub holds `pull_request` workflows at *action required* and doesn't run them. HAR verification above is the gate."
);
L.push('');
L.push('🤖 Generated with [Claude Code](https://claude.com/claude-code)');

fs.writeFileSync(path.join(dir, 'pr-body.md'), `${L.join('\n')}\n`);
const verdict = {
  ok,
  verifyPass,
  linesPass,
  boundToCommit,
  triggered: triggered.map((t) => t.line)
};
fs.writeFileSync(
  path.join(dir, 'verdict.json'),
  JSON.stringify(verdict, null, 2)
);
process.stdout.write(`${JSON.stringify(verdict)}\n`);
