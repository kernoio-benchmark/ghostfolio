// factory-line-router — the one factory-line check that sits on `verify --full`.
//
// Lines never join verificationStages (HAR contract), so nothing would force an
// agent to run them. This stage closes that gap:
//   1. diff the work dir against the merge base (HAR_LINE_BASE, default main),
//   2. map changed paths / Prisma models / migrations to the lines whose
//      .har/lines/<id>/triggers.json claims them,
//   3. for every triggered line, require that each gate stage of its final
//      station has a PASS stamp for the *current tree fingerprint*.
// Untriggered change → pass (zero cost). Triggered but stale/red gate → fail
// with the exact `har line gate` command to run.

import fs from 'node:fs';
import path from 'node:path';

import {
  cumulativeStages,
  diffContext,
  lineReasons,
  loadLines,
  log,
  readStamp,
  runLineStage,
  treeFingerprint
} from './lib/factory-line.mjs';

await runLineStage(
  'factory-line-router',
  { lineId: '*', title: 'route the diff to factory lines' },
  async (ctx, check) => {
    const diff = diffContext(ctx.workDir);
    const lines = loadLines(ctx.workDir);
    const tree = treeFingerprint(ctx.workDir);
    log(`  base ${diff.base} @ ${diff.baseSha.slice(0, 10)} · ${diff.files.length} changed file(s) · ${lines.length} line(s)`);

    const routing = lines.map((line) => {
      const finalStation = line.program.stations.at(-1).id;
      return {
        line: line.id,
        finalStation,
        reasons: lineReasons(line, diff),
        required: cumulativeStages(line.program, finalStation)
      };
    });
    fs.writeFileSync(
      path.join(ctx.artifactsDir, `routing-agent-${ctx.agentId}.json`),
      JSON.stringify({ base: diff.base, baseSha: diff.baseSha, tree, files: diff.files, models: diff.models, routing }, null, 2)
    );

    await check('lines are discoverable', async () => {
      if (lines.length === 0) throw new Error('no .har/lines/*/triggers.json found in the work dir');
      return lines.map((l) => l.id).join(', ');
    });

    for (const r of routing) {
      if (r.reasons.length === 0) {
        await check(`${r.line}: not triggered`, async () => 'no changed path, Prisma model or migration in its territory');
        continue;
      }
      await check(`${r.line}: triggered → gate ${r.finalStation} green for this exact tree`, async () => {
        const problems = [];
        for (const stageId of r.required) {
          const stamp = readStamp(ctx.workDir, ctx.agentId, stageId);
          if (!stamp) problems.push(`${stageId}: never run in agent ${ctx.agentId}`);
          else if (stamp.status !== 'pass') problems.push(`${stageId}: last run ${stamp.status} (${stamp.finishedAt})`);
          else if (stamp.tree !== tree) problems.push(`${stageId}: passed for tree ${stamp.tree.slice(0, 10)}, but the tree is now ${tree.slice(0, 10)} (stale)`);
        }
        const why = r.reasons.slice(0, 15).map((x) => `  - ${x}`).join('\n') +
          (r.reasons.length > 15 ? `\n  - … ${r.reasons.length - 15} more` : '');
        if (problems.length) {
          throw new Error(
            `This change touches the ${r.line} territory:\n${why}\n` +
              `Gate ${r.finalStation} is not green for the tree being verified:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
              `Run: har line gate ${r.finalStation} --line ${r.line} --agent ${ctx.agentId}   (then re-verify)`
          );
        }
        return `triggered by:\n${why}\nall of ${r.required.join(', ')} passed for tree ${tree.slice(0, 10)}`;
      });
    }
  }
);
