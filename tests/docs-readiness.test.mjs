import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { recommendRouting, resolveRoutingCandidates, compactRecommendation } from '../scripts/adaptive-router.mjs';
import { resolveResourcePolicy, decideResourceRouting } from '../scripts/resource-policy.mjs';
import { loadRegistry, registryDigest, validateRuntimeOverlay } from '../scripts/model-capability-registry.mjs';
import { chooseWorkshop, advanceDiscovery, createProductBrief } from '../scripts/workshop.mjs';
import { passiveShadowRecord } from '../scripts/routing-eval.mjs';
import { planDelivery, inspectDelivery } from '../scripts/delivery-manifest.mjs';
import { packetIdentity, resultDigest, validateSnapshot, checkSideEffect } from '../scripts/contracts.mjs';
import { transition } from '../scripts/router.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));
const now = '2026-09-28T12:00:00.000Z';
const before = '2026-09-28T11:00:00.000Z';
const after = '2026-09-28T13:00:00.000Z';
const baseline = json('contracts/model-capabilities.v1.json');
const profile = { reasoning_complexity: 'HIGH', context_load: 'LOW', ambiguity: 'LOW',
  failure_cost: 'LOW', verifiability: 'HIGH', change_surface: 'LOW', prior_evidence: 'HIGH' };
const recommend = ({ packet = null, digest = null, frontier = false } = {}) => recommendRouting({
  binding: packet ? { kind: 'packet', project_id: packet.project_id, task_id: packet.task_id,
    packet_id: packet.packet_id, packet_revision: packet.packet_revision, decision_version: packet.decision_version,
    executor: packet.executor, lifecycle: packet.lifecycle, packet_sha256: packetIdentity(packet).content_sha256 } :
    { kind: 'draft', project_id: 'synthetic-project', input_digest: resultDigest('input') },
  basis: { scope_digest: resultDigest('scope'), task_digest: resultDigest('task'),
    runtime_capability_digest: null, registry_evidence_digest: digest, policy_digest: null },
  profile: frontier ? { ...profile, context_load: 'HIGH', ambiguity: 'HIGH',
    verifiability: 'LOW', change_surface: 'HIGH' } : profile,
  checkpoint: 'pre_execution', frontier_evidence_refs: frontier ? ['synthetic/capability-evidence'] : [],
});
const local = () => ({ contract: 'ModelCapabilityRegistryV1', version: 1,
  registry_version: 'synthetic-1', snapshot_id: 'synthetic-snapshot', entries: [{
    id: 'synthetic.option', provider_family: 'synthetic-provider', host_family: 'synthetic-host',
    provider_facts: { tier: 'STRONG', reasoning_support: 'supported', capabilities: [],
      evidence_refs: ['synthetic/provider'], verified_at: before, valid_until: after, confidence: 'HIGH' },
    eval_evidence: [],
  }] });
const registry = () => { const selected = local(); return loadRegistry({ baseline, local: selected,
  selected: 'local', expected_local_digest: registryDigest(selected) }); };
const observation = (changes = {}) => ({ id: 'synthetic.option', available: true, selectable: true,
  reasoning_control: true, switching_support: true,
  quota: { readable: 'unknown', remaining: null, unit: null }, source_ref: 'synthetic/host-read',
  observed_at: before, valid_until: after, ...changes });
const overlay = (changes = {}) => ({ contract: 'ModelRuntimeOverlayV1', version: 1,
  host_session: 'synthetic-session', observations: [observation(changes)] });
const resolve = (loaded, live = null) => resolveRoutingCandidates({ recommendation: recommend({ digest: loaded.digest }),
  registry: loaded, now, overlay: live, host_session: live ? 'synthetic-session' : null });
const runtime = (changes = {}) => ({ current_tier: 'FAST', current_reasoning: 'LOW',
  tier_availability: { FAST: 'unknown', BALANCED: 'unknown', STRONG: 'available', FRONTIER: 'available' },
  switch_supported: true, reasoning_adjustable: true, auto_route_authorized: false, ...changes });
const autoPolicy = () => resolveResourcePolicy({ project_override: { contract: 'ResourcePolicyV1', version: 1,
  auto_escalate_model: true, reserve_frontier: false } });

test('M10: natural-language user guide includes five examples and preserves validation limits', () => {
  const guide = read('README.md').split('## 先用起来')[1].split('不安装也能')[0];
  for (const term of ['AUTO', 'FORCE', 'BYPASS', 'Product Brief', 'PRD', 'Capability Need', 'Execution Risk',
    'FAST / BALANCED / STRONG / FRONTIER', 'reasoning-first', 'Failure Attribution',
    'economy', 'balanced', 'quality_first', 'VALIDATION REQUIRED', 'runtime truth',
    '默认隐藏', 'unknown', '不是后台 AI monitor', 'UI visibility', 'MCP 不是使用前提',
    '不是实际模型收益', 'release lineage']) assert.ok(guide.includes(term), term);
  const examples = guide.split('### 五个短例子')[1].split('### 本分支验证边界')[0];
  assert.equal(examples.split('\n').filter(line => line.startsWith('| “')).length, 5);
  assert.ok(examples.includes('§61'));
});

test('M10: Skill, Workshop and README share natural help and do not promise slash registration', () => {
  for (const path of ['README.md', 'SKILL.md', 'references/workshop.md']) {
    const text = read(path);
    assert.ok(text.includes('告诉我 Conductor 可用功能/帮助'), path);
    assert.ok(text.includes('/workshop'), path);
    assert.ok(text.includes('语义快捷') || text.includes('semantic shortcut'), path);
    assert.match(text, /当前未实现为命令|不要把历史候选[^\r\n]+宣称为已实现命令|not implemented commands/, path);
    assert.ok(text.includes('不保证') || text.includes('not an implemented slash parser'), path);
  }
  for (const path of ['README.md', 'SKILL.md', 'references/contracts.md', 'references/workflow.md',
    'references/adaptive-router.md', 'references/resource-policy.md', 'references/model-capability-registry.md',
    'references/state-backend.md', 'docs/design/README.md']) assert.ok(read(path).includes('mcp-readiness.md'), path);
  const boundary = read('references/mcp-readiness.md');
  assert.ok(boundary.includes('暂不计算 M4 动作许可'));
  assert.ok(boundary.includes('独立 Product/Architecture Review'));
  assert.ok(boundary.includes('零新增生产代码'));
});

test('M10: existing CLI rejects unimplemented chat/help commands and keeps valid routing', () => {
  for (const args of [['/workshop'], ['/conductor', 'help'], ['help'], ['/router', 'explain']]) {
    const out = spawnSync(process.execPath, ['scripts/cli.mjs', ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(out.status, 1, args.join(' '));
    assert.match(out.stderr, /Usage:/);
    assert.equal(out.stdout, '');
  }
  const out = spawnSync(process.execPath, ['scripts/cli.mjs', 'route', 'examples/route-request.json'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).snapshot.state, 'READY_TO_EXECUTE');
});

test('M11: absent adapter/MCP leaves Workshop, Router, Registry, Eval, Delivery and schema 2 usable', () => {
  assert.equal(chooseWorkshop({ goalKnown: false }).enter, true);
  assert.equal(chooseWorkshop({ smallTask: true }).enter, false);
  const discovery = advanceDiscovery();
  const sections = Object.fromEntries(['problem', 'usersScenario', 'desiredOutcome', 'scopeIn', 'scopeOut',
    'evidence', 'proposedApproach', 'alternatives', 'openQuestions', 'successCriteria', 'deliveryDepth']
    .map(key => [key, 'synthetic ' + key]));
  const brief = createProductBrief({ sections, discovery, deliveryComplete: true });
  assert.equal(brief.status, 'ready');
  assert.equal(brief.delivery.manifest, null);
  const packet = json('examples/execution-packet.json');
  const packetBefore = packetIdentity(packet);
  const rec = recommend({ packet });
  assert.equal(rec.tier, 'STRONG');
  assert.equal(compactRecommendation(rec).tier, 'STRONG');
  const mapped = resolveRoutingCandidates({ recommendation: rec, registry: loadRegistry({ baseline }), now });
  assert.equal(mapped.status, 'unresolved');
  assert.deepEqual(mapped.usable_ids, []);
  assert.equal(mapped.overhead.network_call, false);
  let snapshot = json('examples/project-state.json');
  const result = json('examples/result-packet.json');
  const review = { ...json('examples/review.json'), result_sha256: resultDigest(result) };
  const step = (event, extra = {}) => { snapshot = transition({ snapshot, packet, event,
    work_type: packet.work_type, ...extra }).snapshot; };
  step('prepare'); step('start', { preflight: json('examples/preflight.json') });
  step('submit', { result }); step('accept', { result, review });
  assert.equal(validateSnapshot(snapshot).state, 'COMPLETE');
  assert.equal(snapshot.schema_version, 2);
  assert.deepEqual(packetIdentity(packet), packetBefore);
  const record = passiveShadowRecord({ task_class: 'synthetic-document', task_id: packet.task_id,
    recommendation: rec, result, review, rework_count: 0, case_origin: 'synthetic_boundary' });
  assert.equal(record.actual_tier, 'unknown');
  assert.equal(record.overhead.usage, null);
  assert.equal(record.overhead.dedicated_model_calls, 0);
  const plan = planDelivery({ artifact_id: 'synthetic-long', sections: Array.from({ length: 24 },
    (_, i) => ({ id: 'section-' + i, content: 'Synthetic section ' + i })) });
  const binding = { artifact_id: plan.manifest.artifact_id, artifact_revision: plan.manifest.artifact_revision,
    manifest_digest: plan.manifest.digest };
  const events = plan.emissions.map(emission => ({ ...binding, ...emission, kind: 'delivered',
    source: 'emission', evidence_ref: 'synthetic/emitted/' + emission.segment_id }));
  events.push({ ...binding, kind: 'completion', source: 'emission',
    evidence_ref: 'synthetic/emitted/final', marker: plan.manifest.completion_marker });
  const delivery = inspectDelivery(plan.manifest, events);
  assert.equal(delivery.complete, true);
  assert.equal(delivery.visibility, 'unknown');
});

test('M11: provider evidence cannot stand in for runtime; current unavailable/selectable facts win', () => {
  const loaded = registry();
  const beforeState = structuredClone(loaded);
  const absent = resolve(loaded);
  assert.equal(absent.status, 'unresolved');
  assert.equal(absent.candidates[0].runtime.available, 'unknown');
  assert.equal(absent.candidates[0].runtime.reasoning_control, 'unknown');
  for (const change of [{ available: false }, { selectable: false }, { reasoning_control: false }]) {
    const observed = resolve(loaded, overlay(change));
    assert.equal(observed.status, 'unresolved');
    assert.deepEqual(observed.usable_ids, []);
    for (const [key, value] of Object.entries(change)) assert.equal(observed.candidates[0].runtime[key], value);
    assert.equal(observed.candidates[0].provider.tier, 'STRONG');
  }
  assert.equal(resolve(loaded, overlay()).status, 'resolved');
  assert.deepEqual(loaded, beforeState);
});

test('M11: unknown quota stays unknown; known quota needs existing evidence/time contract', () => {
  const loaded = registry();
  for (const readable of [false, 'unknown']) {
    const quota = { readable, remaining: null, unit: null };
    assert.deepEqual(resolve(loaded, overlay({ quota })).candidates[0].runtime.quota, quota);
    assert.throws(() => validateRuntimeOverlay(overlay({ quota: { readable, remaining: 0, unit: 'requests' } })),
      /unreadable must be unknown/);
  }
  const known = { readable: true, remaining: 3, unit: 'synthetic-requests-in-explicit-window' };
  assert.deepEqual(resolve(loaded, overlay({ quota: known })).candidates[0].runtime.quota, known);
  assert.throws(() => validateRuntimeOverlay(overlay({ source_ref: '' })), /source_ref/);
  assert.throws(() => validateRuntimeOverlay(overlay({ observed_at: null })), /observed_at/);
  const expired = resolve(loaded, overlay({ valid_until: before }));
  assert.equal(expired.candidates[0].runtime.available, 'unknown');
  assert.deepEqual(expired.candidates[0].runtime.quota, { readable: 'unknown', remaining: null, unit: null });
  assert.throws(() => resolveRoutingCandidates({ recommendation: recommend(), registry: loaded, now,
    overlay: overlay(), host_session: 'another-session' }), /host_session/);
});

test('M11: unsupported switching cannot authorize; support plus policy still needs independent authorization', () => {
  const rec = recommend();
  const policy = autoPolicy();
  for (const supported of [true, false, 'unknown']) {
    const denied = decideResourceRouting({ recommendation: rec, policy,
      runtime: runtime({ switch_supported: supported }) });
    assert.equal(denied.tier_action, 'RECOMMEND_ONLY');
    assert.equal(denied.frontier.selected, 'unknown');
    const authorized = decideResourceRouting({ recommendation: rec, policy,
      runtime: runtime({ switch_supported: supported, auto_route_authorized: true }) });
    assert.equal(authorized.tier_action, supported === true ? 'AUTO_ROUTE_ALLOWED' : 'RECOMMEND_ONLY');
    assert.equal(authorized.frontier.actually_used, 'unknown');
  }
  const unknown = decideResourceRouting({ recommendation: rec, policy, runtime: runtime({
    tier_availability: { FAST: 'unknown', BALANCED: 'unknown', STRONG: 'unknown', FRONTIER: 'unknown' },
    auto_route_authorized: true }) });
  assert.equal(unknown.tier_action, 'RECOMMEND_ONLY');
  assert.throws(() => decideResourceRouting({ recommendation: rec, policy,
    runtime: runtime({ current_tier: 'unknown', current_reasoning: 'unknown' }) }), /runtime.current_tier/);
  assert.equal(recommend().tier, 'STRONG', 'abstract recommendation remains available without current-model facts');
});

test('M11: FRONTIER support never creates approval or Packet side effects', () => {
  const rec = recommend({ frontier: true });
  const policy = autoPolicy();
  const live = runtime({ auto_route_authorized: true });
  const noApproval = decideResourceRouting({ recommendation: rec, policy, runtime: live });
  assert.equal(noApproval.frontier.approved, false);
  assert.equal(noApproval.frontier.approval_required, true);
  assert.equal(noApproval.tier_action, 'RECOMMEND_ONLY');
  const approval = { recommendation_id: rec.recommendation_id, tier: 'FRONTIER', action: 'select_model',
    resource_limit: 'one synthetic step', evidence_ref: 'synthetic/explicit-user-approval' };
  const approved = decideResourceRouting({ recommendation: rec, policy, runtime: live, frontier_approval: approval });
  assert.equal(approved.frontier.approved, true);
  assert.equal(approved.frontier.selected, 'unknown');
  assert.equal(approved.frontier.actually_used, 'unknown');
  assert.equal(approved.tier_action, 'RECOMMEND_ONLY');
  const packet = json('examples/execution-packet.json');
  const initial = json('examples/project-state.json');
  const prepared = transition({ snapshot: initial, packet, work_type: packet.work_type, event: 'prepare' }).snapshot;
  const running = transition({ snapshot: prepared, packet, work_type: packet.work_type, event: 'start',
    preflight: json('examples/preflight.json') }).snapshot;
  assert.equal(checkSideEffect(packet, running, { action: 'email_send', target: 'synthetic@example.test' }).allowed, false);
});

test('M11: runtime boundary rejects static facts, authorization and claimed selection', () => {
  for (const injected of [{ provider_facts: local().entries[0].provider_facts },
    { auto_route_authorized: true }, { selected: true }, { actually_used: true }]) {
    assert.throws(() => validateRuntimeOverlay(overlay(injected)), /unexpected or missing field/);
  }
  const unknown = overlay({ available: 'unknown', selectable: 'unknown',
    reasoning_control: 'unknown', switching_support: 'unknown' });
  assert.equal(resolve(registry(), unknown).status, 'unresolved');
});

test('M11: transitive core dependency boundary remains local with no MCP, network, watcher or model client', () => {
  const queue = ['adaptive-router', 'resource-policy', 'model-capability-registry', 'workshop',
    'routing-eval', 'delivery-manifest', 'router'].map(name => new URL('../scripts/' + name + '.mjs', import.meta.url));
  const seen = new Set();
  while (queue.length) {
    const url = queue.pop();
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const source = readFileSync(url, 'utf8');
    assert.doesNotMatch(source, /\b(?:fetch|WebSocket|setInterval|setTimeout|watch|watchFile)\s*\(/, url.href);
    assert.doesNotMatch(source, /\b(?:import|require)\s*\(/, url.href);
    for (const [, dependency] of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (dependency.startsWith('node:')) {
        assert.ok(['node:crypto', 'node:util', 'node:fs'].includes(dependency), dependency);
      } else {
        assert.match(dependency, /^\.\/[a-z-]+\.mjs$/);
        queue.push(new URL(dependency, url));
      }
    }
  }
  assert.ok(seen.has(new URL('../scripts/contracts.mjs', import.meta.url).href));
  // Existing contracts.mjs reads only the local routing definition; no persistence or external I/O is added.
});
