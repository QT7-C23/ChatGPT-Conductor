import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { transition } from '../scripts/router.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const json = path => JSON.parse(read(path));
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const path = resolve(dir, e.name);
    return e.isDirectory() ? files(path) : [path];
  });
}
test('CLI executes ready route and returns machine-readable state', () => {
  const out = spawnSync(process.execPath, ['scripts/cli.mjs', 'route', 'examples/route-request.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const route = JSON.parse(out.stdout);
  assert.equal(route.surface, 'WORK'); assert.equal(route.snapshot.state, 'READY_TO_EXECUTE');
});
test('CLI validates both packets and fails on invalid command', () => {
  const out = spawnSync(process.execPath, ['scripts/cli.mjs', 'check', 'examples/project-state.json', 'examples/execution-packet.json', 'examples/result-packet.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr); assert.equal(JSON.parse(out.stdout).valid, true);
  const bad = spawnSync(process.execPath, ['scripts/cli.mjs', 'publish'], { cwd: root, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Usage/);
  const invalid = spawnSync(process.execPath, ['scripts/cli.mjs', 'check', 'examples/project-state.json', 'examples/execution-packet.json', 'tests/fixtures/invalid-result.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /result/);
  const review = spawnSync(process.execPath, ['scripts/cli.mjs', 'check', 'examples/project-state.json', 'examples/execution-packet.json', 'examples/result-packet.json', 'examples/review.json'], { cwd: root, encoding: 'utf8' });
  assert.equal(review.status, 0, review.stderr);
});
test('full lifecycle carries returned snapshots through completion', () => {
  const r = json('examples/route-request.json');
  r.preflight = json('examples/preflight.json');
  for (const [event, expected] of [['prepare', 'READY_TO_EXECUTE'], ['start', 'EXECUTE'], ['submit', 'REVIEW'], ['accept', 'COMPLETE']]) {
    r.event = event;
    if (event === 'submit') r.result = json('examples/result-packet.json');
    if (event === 'accept') r.review = json('examples/review.json');
    const out = transition(r);
    assert.equal(out.snapshot.state, expected);
    assert.equal(out.snapshot.revision, r.snapshot.revision + 1);
    r.snapshot = out.snapshot;
  }
});
test('all local Markdown references resolve within delivered skill', () => {
  for (const path of files(root).filter(p => p.endsWith('.md'))) {
    const content = readFileSync(path, 'utf8');
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^https?:\/\//.test(match[1])) continue;
      const target = resolve(dirname(path), match[1].split('#')[0]);
      assert.ok(!relative(root, target).startsWith('..' + sep), path + ': reference escapes skill');
      assert.ok(existsSync(target), path + ': missing ' + match[1]);
    }
  }
});
test('entrypoint is discoverable and uses only supported metadata', () => {
  const entry = read('SKILL.md');
  assert.match(entry, /^---\r?\nname: project-orchestrator\r?\ndescription: [^\r\n]+/);
  assert.equal(entry.split('\n').length < 500, true);
  assert.match(read('agents/openai.yaml'), /\$project-orchestrator/);
});
test('router has no storage or execution dependency', () => {
  const imports = [...read('scripts/router.mjs').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.deepEqual(new Set(imports), new Set(['node:util', './contracts.mjs']));
  assert.doesNotMatch(read('scripts/contracts.mjs'), /from ['"]\.\/router/);
});
test('CI and hook share the same verification entrypoint', () => {
  for (const path of ['.github/workflows/verify.yml', '.githooks/pre-commit']) {
    assert.ok(read(path).includes('node scripts/verify.mjs'), path);
  }
  assert.equal(json('package.json').scripts.verify, 'node scripts/verify.mjs');
});
test('CLI side-effect exits nonzero for production deploy; decisions preserves unchanged locks', () => {
  const tempParent = resolve(tmpdir());
  const dir = mkdtempSync(resolve(tempParent, 'project-orchestrator-'));
  const store = (name, value) => { const p = resolve(dir, name); writeFileSync(p, JSON.stringify(value)); return p; };
  const run = args => spawnSync(process.execPath, ['scripts/cli.mjs', ...args], { cwd: root, encoding: 'utf8' });
  try {
    const r = json('examples/route-request.json');
    r.snapshot = transition(r).snapshot; r.event = 'start'; r.preflight = json('examples/preflight.json');
    const executing = store('state.json', transition(r).snapshot);
    const packet = store('packet.json', r.packet);
    const denied = run(['side-effect', executing, packet, store('deploy.json', { action: 'deploy', target: 'production' })]);
    assert.equal(denied.status, 1); assert.deepEqual(JSON.parse(denied.stdout), { allowed: false, status: 'require_escalation' });
    const allowed = run(['side-effect', executing, packet, store('write.json', { action: 'local_files_write', target: 'summary.md' })]);
    assert.equal(allowed.status, 0, allowed.stderr); assert.equal(JSON.parse(allowed.stdout).allowed, true);
    const plan = json('examples/project-state.json');
    const change = { locked_decisions: plan.locked_decisions, open_decisions: [], source_kind: 'user_instruction', approval_ref: '本测试中的明确授权' };
    const changed = run(['decisions', store('plan.json', plan), store('change.json', change)]);
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).decision_version, plan.decision_version);
    assert.equal(JSON.parse(changed.stdout).revision, plan.revision + 1);
  } finally {
    assert.equal(dirname(resolve(dir)), tempParent);
    assert.ok(relative(tempParent, dir).startsWith('project-orchestrator-'));
    rmSync(dir, { recursive: true, force: true });
  }
});
test('CLI migration and explicit replan are read-only and blocked migration exits nonzero', () => {
  const run = args => spawnSync(process.execPath, ['scripts/cli.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const before = read('examples/migration-request.json');
  const migrated = run(['migrate', 'examples/migration-request.json']);
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(JSON.parse(migrated.stdout).snapshot.state, 'PLAN');
  assert.equal(read('examples/migration-request.json'), before);
  const blocked = run(['migrate', 'tests/fixtures/invalid-result.json']);
  assert.equal(blocked.status, 1); assert.equal(JSON.parse(blocked.stdout).status, 'blocked');
  assert.equal(Object.hasOwn(JSON.parse(blocked.stdout), 'snapshot'), false);
  const replanned = run(['route', 'examples/replan-request.json']);
  assert.equal(replanned.status, 0, replanned.stderr);
  const out = JSON.parse(replanned.stdout);
  assert.equal(out.snapshot.state, 'PLAN'); assert.equal(out.snapshot.plan_approvals.length, 1);
  assert.equal(out.snapshot.active_packet.packet_revision, 1, 'approval does not publish the proposed packet');
});
test('migration boundary imports only contract helpers and pure comparisons', () => {
  const imports = [...read('scripts/migration.mjs').matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.deepEqual(new Set(imports), new Set(['node:util', './contracts.mjs']));
  assert.doesNotMatch(read('scripts/contracts.mjs'), /from ['"]\.\/(router|migration)/);
});
