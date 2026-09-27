import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { recommendRouting, resolveRoutingCandidates } from '../scripts/adaptive-router.mjs';
import { resolveResourcePolicy, decideResourceRouting } from '../scripts/resource-policy.mjs';
import { attributeFailure, failureReassessmentHint } from '../scripts/failure-attribution.mjs';
import { validateRegistrySnapshot, validateRuntimeOverlay, factFreshness, registryDigest,
  loadRegistry, resolveRegistryCandidates } from '../scripts/model-capability-registry.mjs';

const now = '2026-09-27T12:00:00.000Z';
const before = '2026-09-01T00:00:00.000Z';
const after = '2026-10-01T00:00:00.000Z';
const hash = text => createHash('sha256').update(text).digest('hex');
const baseline = JSON.parse(readFileSync(new URL('../contracts/model-capabilities.v1.json', import.meta.url)));
const facts = (changes = {}) => ({ tier: 'STRONG', reasoning_support: 'supported',
  capabilities: ['synthetic-reasoning'], evidence_refs: ['synthetic-provider-doc'],
  verified_at: before, valid_until: after, confidence: 'HIGH', ...changes });
const entry = (id = 'synthetic.option-a', changes = {}) => ({ id, provider_family: 'synthetic-provider',
  host_family: 'synthetic-host', provider_facts: facts(), eval_evidence: [], ...changes });
const snapshot = (entries = [entry()], changes = {}) => ({ contract: 'ModelCapabilityRegistryV1',
  version: 1, registry_version: 'synthetic-1', snapshot_id: 'synthetic-snapshot-1', entries, ...changes });
const observation = (id = 'synthetic.option-a', changes = {}) => ({ id, available: true, selectable: true,
  reasoning_control: true, switching_support: true,
  quota: { readable: 'unknown', remaining: null, unit: null }, source_ref: 'synthetic-host-observation',
  observed_at: before, valid_until: after, ...changes });
const overlay = (observations = [observation()]) => ({ contract: 'ModelRuntimeOverlayV1',
  version: 1, host_session: 'synthetic-session', observations });
const loaded = (entries = [entry()]) => loadRegistry({ baseline, local: snapshot(entries), selected: 'local',
  expected_local_digest: registryDigest(snapshot(entries)) });
const resolve = (registry = loaded(), runtime = overlay(), tier = 'STRONG', eval_scope = null) =>
  resolveRegistryCandidates({ registry, tier, reasoning: 'HIGH', now, overlay: runtime,
    host_session: 'synthetic-session', eval_scope });
const recommend = (registryDigestValue = null, frontier = false) => recommendRouting({
  binding: { kind: 'draft', project_id: 'synthetic-project', input_digest: hash('input') },
  basis: { scope_digest: hash('scope'), task_digest: hash('task'), runtime_capability_digest: null,
    registry_evidence_digest: registryDigestValue, policy_digest: null },
  profile: { reasoning_complexity: 'HIGH', context_load: frontier ? 'HIGH' : 'LOW',
    ambiguity: frontier ? 'HIGH' : 'LOW', failure_cost: 'LOW', verifiability: frontier ? 'LOW' : 'HIGH',
    change_surface: frontier ? 'HIGH' : 'LOW', prior_evidence: 'HIGH' },
  checkpoint: 'pre_execution', frontier_evidence_refs: frontier ? ['synthetic-frontier-evidence'] : [],
});

test('A: provider, eval and runtime have separate strict contracts', () => {
  assert.equal(validateRegistrySnapshot(baseline), baseline);
  assert.throws(() => validateRegistrySnapshot(snapshot([entry('x', { available: true })])), /Contract violation/);
  assert.throws(() => validateRegistrySnapshot(snapshot([entry('x', { provider_facts: facts({ quota: 100 }) })])), /Contract violation/);
  assert.throws(() => validateRegistrySnapshot(snapshot([entry('x', { eval_evidence: [{ ref: 'eval-1',
    scope: 'synthetic task', tier: 'STRONG', reasoning_support: 'supported', capabilities: [],
    observed_at: before, valid_until: after, confidence: 'MEDIUM', available: true }] })])), /Contract violation/);
  assert.throws(() => validateRuntimeOverlay(overlay([observation('x', { provider_facts: facts() })])), /Contract violation/);
});

test('B: unknown tier, reasoning and runtime are legal and unresolved', () => {
  const uncertain = entry('synthetic.unknown', { provider_facts: facts({ tier: 'unknown',
    reasoning_support: 'unknown', confidence: 'unknown', capabilities: [], evidence_refs: [], verified_at: null, valid_until: null }) });
  const result = resolve(loaded([uncertain]), overlay([]));
  assert.equal(result.status, 'unresolved');
  assert.equal(result.confidence, 'LOW');
  assert.ok(result.reasons.includes('provider_unknown'));
  assert.equal(result.refresh_needed, true);
});

test('C: stale evidence stays in the snapshot and requests later research only', () => {
  const stale = entry('synthetic.option-a', { provider_facts: facts({ valid_until: '2026-09-10T00:00:00.000Z' }) });
  const registry = loaded([stale]);
  const result = resolve(registry);
  assert.equal(factFreshness(stale.provider_facts, now), 'stale');
  assert.equal(result.status, 'unresolved');
  assert.equal(result.refresh_needed, true);
  assert.ok(result.reasons.includes('provider_stale'));
  assert.equal(registry.snapshot.entries.length, 1);
  assert.deepEqual(result.overhead, { extra_model_call: false, network_call: false, automatic_refresh: false });
});

test('D: fresh STRONG evidence resolves a synthetic candidate', () => {
  const result = resolve();
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.usable_ids, ['synthetic.option-a']);
  assert.equal(result.confidence, 'HIGH');
  assert.equal(result.candidates[0].provider.freshness, 'fresh');
  assert.equal(result.registry_ref.source, 'local');
});

test('E/F: runtime facts stay separate and unreadable quota remains unknown', () => {
  const source = overlay();
  const registry = loaded();
  const result = resolve(registry, source);
  assert.deepEqual(result.candidates[0].runtime.quota, { readable: 'unknown', remaining: null, unit: null });
  assert.equal(result.candidates[0].runtime.switching_support, true);
  assert.equal(result.candidates[0].runtime.reasoning_control, true);
  assert.equal(Object.hasOwn(registry.snapshot.entries[0], 'available'), false);
  assert.deepEqual(source, overlay());
  assert.throws(() => validateRuntimeOverlay(overlay([observation('x',
    { quota: { readable: false, remaining: 0, unit: 'requests' } })])), /Contract violation/);
});

test('runtime unavailable overrides a fresh static candidate without changing evidence', () => {
  const registry = loaded();
  const result = resolve(registry, overlay([observation('synthetic.option-a',
    { available: false, selectable: false })]));
  assert.equal(result.candidates[0].provider.tier, 'STRONG');
  assert.equal(result.candidates[0].runtime.available, false);
  assert.equal(result.status, 'unresolved');
  assert.deepEqual(result.usable_ids, []);
  assert.equal(registry.snapshot.entries[0].provider_facts.tier, 'STRONG');
});

test('eval evidence stays attributed and stale eval lowers confidence without rewriting provider facts', () => {
  const assessed = entry('synthetic.option-a', { eval_evidence: [{ ref: 'synthetic-eval-1',
    scope: 'synthetic bounded task', tier: 'STRONG', reasoning_support: 'supported', capabilities: [],
    observed_at: before, valid_until: '2026-09-10T00:00:00.000Z', confidence: 'MEDIUM' }] });
  assert.equal(resolve(loaded([assessed])).status, 'resolved');
  const result = resolve(loaded([assessed]), overlay(), 'STRONG', 'synthetic bounded task');
  assert.equal(result.candidates[0].provider.freshness, 'fresh');
  assert.equal(result.candidates[0].confidence, 'LOW');
  assert.equal(result.candidates[0].eval_evidence[0].ref, 'synthetic-eval-1');
  assert.equal(result.status, 'unresolved');
  assert.equal(result.refresh_needed, true);
  assert.ok(result.reasons.includes('eval_stale'));
});

test('G/M: Router maps outside Packet identity; a schema-2 recommendation without Registry is valid', () => {
  const registry = loaded();
  const old = recommend();
  const rec = recommend(registry.digest);
  const result = resolveRoutingCandidates({ recommendation: rec, registry, now, overlay: overlay(),
    host_session: 'synthetic-session' });
  assert.equal(result.status, 'resolved');
  assert.equal(old.tier, 'STRONG');
  assert.equal(Object.hasOwn(rec, 'model'), false);
  assert.equal(Object.hasOwn(rec.binding, 'packet_revision'), false);
  const different = loaded([entry('synthetic.option-b')]);
  assert.equal(resolveRoutingCandidates({ recommendation: old, registry: different, now,
    overlay: overlay([observation('synthetic.option-b')]), host_session: 'synthetic-session' }).status, 'resolved');
  assert.throws(() => resolveRoutingCandidates({ recommendation: rec, registry: different, now,
    overlay: overlay([observation('synthetic.option-b')]), host_session: 'synthetic-session' }), /registry_evidence_digest/);
});

test('H: no match, low confidence and unknown never invent FRONTIER', () => {
  for (const items of [[], [entry('x', { provider_facts: facts({ confidence: 'LOW' }) })],
    [entry('x', { provider_facts: facts({ tier: 'unknown', confidence: 'unknown',
      reasoning_support: 'unknown', capabilities: [], evidence_refs: [], verified_at: null, valid_until: null }) })]]) {
    const result = resolve(loaded(items), overlay([]));
    assert.equal(result.status, 'unresolved');
    assert.equal(result.confidence, 'LOW');
    assert.equal(result.usable_ids.length, 0);
    assert.equal(result.candidates.some(item => item.provider.tier === 'FRONTIER'), false);
  }
});

test('I/L: explicit local snapshot selection is digest checked and cacheable without I/O', () => {
  const local = snapshot();
  const first = loadRegistry({ baseline, local, selected: 'local', expected_local_digest: registryDigest(local) });
  const second = loadRegistry({ baseline, local, selected: 'local', expected_local_digest: registryDigest(local) });
  assert.deepEqual(first, second);
  assert.equal(first.baseline_ref.registry_version, '1');
  assert.equal(first.registry_version, 'synthetic-1');
  assert.throws(() => loadRegistry({ baseline, local, selected: 'local', expected_local_digest: hash('wrong') }), /digest mismatch/);
  assert.throws(() => validateRegistrySnapshot({ ...local, authorization: { status: 'granted' } }), /Contract violation/);
  assert.throws(() => validateRegistrySnapshot({ ...local, entries: [entry('x', { side_effects: [] })] }), /Contract violation/);
});

test('J: FRONTIER approved but unavailable remains unselected', () => {
  const rec = recommend(null, true);
  const approval = { recommendation_id: rec.recommendation_id, tier: 'FRONTIER', action: 'select_model',
    resource_limit: 'one synthetic task', evidence_ref: 'synthetic-user-approval' };
  const runtime = { current_tier: 'STRONG', current_reasoning: 'HIGH',
    tier_availability: { FAST: 'unknown', BALANCED: 'unknown', STRONG: 'available', FRONTIER: 'unavailable' },
    switch_supported: true, reasoning_adjustable: true, auto_route_authorized: true };
  const decision = decideResourceRouting({ recommendation: rec, policy: resolveResourcePolicy(), runtime,
    frontier_approval: approval });
  assert.equal(decision.frontier.approved, true);
  assert.equal(decision.frontier.available, 'unavailable');
  assert.equal(decision.frontier.selected, 'unknown');
  assert.equal(decision.frontier.actually_used, 'unknown');
  assert.equal(decision.tier_action, 'RECOMMEND_ONLY');
});

test('K: stale/unknown Registry and unavailable model never become CAPABILITY_LIMIT', () => {
  for (const signal of ['REGISTRY_STALE', 'REGISTRY_UNKNOWN', 'MODEL_UNAVAILABLE']) {
    const attribution = attributeFailure({ evidence: [{ ref: 'synthetic-observation', signal }] });
    assert.notEqual(attribution.category, 'CAPABILITY_LIMIT');
    assert.equal(attribution.routing_reassessment_required, false);
    assert.equal(failureReassessmentHint({ attribution, tier: 'STRONG', reasoning: 'HIGH',
      reasoning_adjustable: true }), null);
  }
});

test('runtime expiration or session mismatch cannot be used as current availability', () => {
  const expired = overlay([observation('synthetic.option-a',
    { valid_until: '2026-09-10T00:00:00.000Z' })]);
  const result = resolve(loaded(), expired);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.candidates[0].runtime.available, 'unknown');
  assert.equal(result.refresh_needed, true);
  assert.throws(() => resolveRegistryCandidates({ registry: loaded(), tier: 'STRONG', reasoning: 'HIGH',
    now, overlay: overlay(), host_session: 'different-session' }), /host_session/);
});
