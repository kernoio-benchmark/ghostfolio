// Turn Claude Code's `--output-format stream-json` into a readable Actions log.
// Usage: claude -p … --output-format stream-json --verbose | node stream-log.mjs <result.json>
// Prints assistant text and one line per tool call; writes the final `result`
// event (turns, duration, cost, is_error) to <result.json>. Exits 1 if the
// session ended in error.
import fs from 'node:fs';
import readline from 'node:readline';

const resultFile = process.argv[2];
let result = null;
const short = (s, n = 160) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    continue;
  }
  if (ev.type === 'assistant') {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'text' && block.text.trim())
        console.log(`\n🤖 ${block.text.trim()}\n`);
      if (block.type === 'tool_use') {
        const i = block.input ?? {};
        console.log(
          `  → ${block.name} ${short(i.command ?? i.file_path ?? i.pattern ?? i.description ?? JSON.stringify(i))}`
        );
      }
    }
  } else if (ev.type === 'result') {
    result = ev;
  }
}

if (!result) {
  console.error('::error::Claude Code produced no result event');
  process.exit(1);
}
const { result: finalText, ...facts } = result;
fs.writeFileSync(
  resultFile,
  JSON.stringify({ ...facts, final_text: finalText }, null, 2)
);
console.log(
  `\n— agent ${result.subtype}: ${result.num_turns} turns, ${Math.round((result.duration_ms ?? 0) / 1000)} s, $${Number(result.total_cost_usd ?? 0).toFixed(2)}`
);
process.exit(result.is_error ? 1 : 0);
