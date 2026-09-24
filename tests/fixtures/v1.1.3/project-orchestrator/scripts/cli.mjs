import { readFileSync } from 'node:fs';
import { transition } from './router.mjs';
import { migrateSnapshot } from './migration.mjs';
import { validateExecution, validateResult, validateReview, checkSideEffect, applyDecisionUpdate } from './contracts.mjs';

const load = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
try {
  const [command, ...paths] = process.argv.slice(2);
  let output;
  if (command === 'route' && paths.length === 1) output = transition(load(paths[0]));
  else if (command === 'migrate' && paths.length === 1) {
    output = migrateSnapshot(load(paths[0]));
    if (output.status === 'blocked') process.exitCode = 1;
  }
  else if (command === 'check' && [2, 3, 4].includes(paths.length)) {
    const [snapshot, packet, result, review] = paths.map(load);
    validateExecution(packet, snapshot);
    if (paths.length >= 3) validateResult(result, packet);
    if (paths.length === 4) validateReview(review, packet, result);
    output = { valid: true, note: '结构与决策一致性通过；就绪条件用 route 检查，事实由审核者验证。' };
  } else if (command === 'side-effect' && paths.length === 3) {
    const [snapshot, packet, effect] = paths.map(load);
    output = checkSideEffect(packet, snapshot, effect);
    if (!output.allowed) process.exitCode = 1;
  } else if (command === 'decisions' && paths.length === 2) {
    output = applyDecisionUpdate(load(paths[0]), load(paths[1]));
  } else throw new Error('Usage: node scripts/cli.mjs route request.json | migrate migration-request.json | check state.json execution.json [result.json [review.json]] | side-effect state.json execution.json effect.json | decisions state.json change.json');
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
