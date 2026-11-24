// Which factory lines does the work dir's diff (vs merge-base main) trigger?
// Same routing as the factory-line-router verify stage, so the workflow can
// run exactly the gates the router will demand.
// Usage: node triggered-lines.mjs <workDir>  → JSON [{line, finalStation, reasons}]
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workDir = path.resolve(process.argv[2] ?? '.');
const lib = await import(
  pathToFileURL(path.join(workDir, '.har/stages/lib/factory-line.mjs')).href
);

const diff = lib.diffContext(workDir);
const out = lib
  .loadLines(workDir)
  .map((line) => ({
    line: line.id,
    finalStation: line.program.stations.at(-1).id,
    reasons: lib.lineReasons(line, diff)
  }))
  .filter((r) => r.reasons.length > 0);
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
