import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { recommendRouting, validateRoutingRecommendation, compactRecommendation, nextCapabilityStep } from '../scripts/adaptive-router.mjs';
import { packetIdentity } from '../scripts/contracts.mjs';
import { transition } from '../scripts/router.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const profile = {
  reasoning_complexity: 'LOW', context_load: 'LOW', ambiguity: 'LOW', failure_cost: 'LOW',
  verifiability: 'HIGH', change_surface: 'LOW', prior_evidence: 'HIGH',
};
const input = (changes = {}) => ({
  binding: { kind: 'draft', project_id: 'example', input_digest: hash('draft') },
  basis: { scope_digest: hash('scope'), task_digest: hash('task'), runtime_capability_digest: null,
    registry_evidence_digest: null, policy_digest: null },
  profile, checkpoint: 'workshop', ...changes,
});
const route = changes => recommendRouting(input(changes));

test('A: clear bounded task uses deterministic FAST path without a model call', () => {
  const record = route();
  assert.equal(record.tier, 'FAST');
  assert.equal(record.routing_path, 'FAST_PATH');
  assert.deepEqual(record.overhead, { extra_model_call: false, dedicated_analysis: false });
  assert.deepEqual(compactRecommendation(record), {
    tier: 'FAST', reasoning: 'LOW', confidence: 'HIGH', rationale: record.rationale,
  });
});

test('B: routine professional task receives BALANCED', () => {
  const record = route({ profile: { ...profile, reasoning_complexity: 'MEDIUM', change_surface: 'MEDIUM' } });
  assert.equal(record.tier, 'BALANCED');
  assert.equal(record.reasoning, 'MEDIUM');
  assert.equal(record.routing_path, 'RULES');
});

test('C: high reasoning and low execution risk can receive STRONG', () => {
  const record = route({ profile: { ...profile, reasoning_complexity: 'HIGH' } });
  assert.equal(record.tier, 'STRONG');
  assert.equal(record.reasoning, 'HIGH');
  assert.equal(record.execution_risk, 'LOW');
});

test('D: high failure cost alone does not inflate capability tier', () => {
  const record = route({ profile: { ...profile, failure_cost: 'HIGH' } });
  assert.equal(record.tier, 'FAST');
  assert.equal(record.execution_risk, 'HIGH');
  assert.match(record.rationale, /risk high/);
});

test('E: reasoning and tier are independent, and a separate increase is reasoning-first', () => {
  const record = route({ profile: { ...profile, ambiguity: 'MEDIUM' } });
  assert.equal(record.tier, 'BALANCED');
  assert.equal(record.reasoning, 'MEDIUM');
  assert.deepEqual(nextCapabilityStep({ tier: 'BALANCED', reasoning: 'MEDIUM', reasoning_adjustable: true }),
    { tier: 'BALANCED', reasoning: 'HIGH' });
  assert.deepEqual(nextCapabilityStep({ tier: 'BALANCED', reasoning: 'HIGH', reasoning_adjustable: true }),
    { tier: 'STRONG', reasoning: 'HIGH' });
  assert.equal(nextCapabilityStep({ tier: 'STRONG', reasoning: 'HIGH', reasoning_adjustable: true }), null);
});

test('F: exceptional recommendation is only a tier, never an approval or use claim', () => {
  const record = route({ profile: { ...profile, reasoning_complexity: 'HIGH', context_load: 'HIGH',
    ambiguity: 'HIGH', verifiability: 'LOW', change_surface: 'HIGH' },
  frontier_evidence_refs: ['reviewed-case-17'] });
  assert.equal(record.tier, 'FRONTIER');
  assert.equal(record.confidence, 'LOW');
  for (const key of ['approved', 'available', 'selected', 'actually_used', 'authorization'])
    assert.equal(Object.hasOwn(record, key), false);
  assert.equal(record.overhead.extra_model_call, false);
});

test('G: absent quota, model mapping and registry still allow abstract recommendation', () => {
  const record = route({ profile: { ...profile, reasoning_complexity: 'HIGH' } });
  assert.equal(record.tier, 'STRONG');
  assert.equal(record.basis.registry_evidence_digest, null);
  assert.equal(Object.hasOwn(record, 'quota'), false);
  assert.equal(Object.hasOwn(record, 'model'), false);
});

test('H: unchanged facts inherit without analysis; material changes invalidate', () => {
  const first = route();
  const second = route({ checkpoint: 'pre_execution', previous: first });
  assert.equal(second.inherited, true);
  assert.equal(second.previous_recommendation_id, first.recommendation_id);
  assert.equal(second.routing_path, 'INHERITED');
  assert.deepEqual(second.overhead, { extra_model_call: false, dedicated_analysis: false });
  const third = route({ checkpoint: 'review', previous: second });
  assert.equal(third.inherited, true);
  for (const change of [
    { profile: { ...profile, reasoning_complexity: 'HIGH' } },
    { basis: { ...input().basis, scope_digest: hash('new scope') } },
    { basis: { ...input().basis, runtime_capability_digest: hash('host changed') } },
    { basis: { ...input().basis, registry_evidence_digest: hash('new evidence') } },
    { basis: { ...input().basis, policy_digest: hash('new policy') } },
    { binding: { ...input().binding, input_digest: hash('new draft') } },
  ]) {
    const changed = route({ checkpoint: 'review', previous: first, ...change });
    assert.equal(changed.inherited, false);
    assert.equal(changed.previous_recommendation_id, null);
  }
});

test('I: routing checkpoints stay separate from the seven lifecycle states', () => {
  const states = JSON.parse(readFileSync(new URL('../contracts/routing.json', import.meta.url))).states;
  assert.deepEqual(states, ['DISCUSS', 'PLAN', 'READY_TO_EXECUTE', 'EXECUTE', 'REVIEW', 'REVISE', 'COMPLETE']);
  for (const checkpoint of ['workshop', 'research_escalation', 'pre_execution', 'failure_reassessment', 'review', 'significant_replan'])
    assert.equal(route({ checkpoint }).checkpoint, checkpoint);
});

test('J: optional recommendation does not mutate or authorize an Execution Packet', () => {
  const request = JSON.parse(readFileSync(new URL('../examples/route-request.json', import.meta.url)));
  const packetBefore = structuredClone(request.packet);
  const rec = route({ binding: { kind: 'packet', project_id: request.packet.project_id,
    task_id: request.packet.task_id, packet_id: request.packet.packet_id,
    packet_revision: request.packet.packet_revision, decision_version: request.packet.decision_version,
    executor: request.packet.executor, lifecycle: request.packet.lifecycle,
    packet_sha256: packetIdentity(request.packet).content_sha256 } });
  assert.equal(rec.binding.kind, 'packet');
  assert.deepEqual(request.packet, packetBefore);
  request.packet.authorization.status = 'pending';
  assert.throws(() => transition(request), /authorization: execution not granted/);
  assert.equal(request.packet.schema_version, 2);
  assert.equal(request.packet.packet_revision, packetBefore.packet_revision);
});

test('K: machine validator rejects bad enums, fields and inconsistent inheritance', () => {
  const record = route();
  for (const patch of [{ tier: 'ASTRA' }, { reasoning: 'ULTRA' }, { confidence: 'CERTAIN' },
    { inherited: true }, { routing_path: 'INHERITED' }, { approved: true },
    { usage: { tokens: 0 } }, { chain_of_thought: 'hidden reasoning' }])
    assert.throws(() => validateRoutingRecommendation({ ...record, ...patch }), /Contract violation/);
  const inherited = route({ previous: record });
  assert.throws(() => validateRoutingRecommendation(inherited), /inheritance/);
  assert.throws(() => validateRoutingRecommendation({ ...inherited, tier: 'STRONG' }, { previous: record }), /changed record/);
  assert.throws(() => validateRoutingRecommendation(record, { basis: { ...record.basis, scope_digest: hash('other') } }), /stale/);
  assert.throws(() => recommendRouting(input({ profile: { ...profile, unknown: 'HIGH' } })), /Contract violation/);
});

test('L: records contain neither private reasoning nor synthetic usage', () => {
  for (const record of [route(), route({ profile: { ...profile, reasoning_complexity: 'HIGH' } })]) {
    assert.doesNotMatch(JSON.stringify(record), /chain.of.thought|hidden_reasoning|token_count|usage|quota/i);
    assert.ok(record.rationale.length <= 280);
  }
});

test('draft and packet bindings never share a cache entry', () => {
  const first = route();
  const packetBinding = { kind: 'packet', project_id: 'example', task_id: 't1', packet_id: 'p1',
    packet_revision: 1, decision_version: 1, executor: 'CODEX', lifecycle: 1, packet_sha256: hash('packet') };
  const later = route({ binding: packetBinding, previous: first });
  assert.equal(later.inherited, false);
  assert.throws(() => validateRoutingRecommendation(later, { binding: first.binding }), /cross-task/);
});

test('cache identity is stable across JSON key order but detects changed content', () => {
  const record = route();
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  assert.deepEqual(validateRoutingRecommendation(reordered), reordered);
  assert.throws(() => validateRoutingRecommendation({ ...record, rationale: 'Different reason' }), /changed record/);
});
