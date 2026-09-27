// Isolated M1 behavior experiments; synthetic inputs, no model/network/usage measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolvePolicy } from '../docs/design/spikes/resource-policy.mjs';
import { inspectDelivery } from '../docs/design/spikes/delivery-boundary.mjs';
import { transition } from '../scripts/router.mjs';
import { packetIdentity, resultDigest, validateExecution } from '../scripts/contracts.mjs';

const policy = overrides => ({ contract: 'ResourcePolicyV1', version: 1, ...overrides });
const baseline = () => policy({ resource_mode: 'balanced', reserve_frontier: true,
  auto_escalate_reasoning: true, auto_escalate_model: false });

test('M1-P1: absent optional layers retain explicitly supplied baseline and provenance', () => {
  assert.deepEqual(resolvePolicy(baseline()), {
    values: { resource_mode: 'balanced', reserve_frontier: true, auto_escalate_reasoning: true, auto_escalate_model: false },
    sources: { resource_mode: 'baseline', reserve_frontier: 'baseline', auto_escalate_reasoning: 'baseline', auto_escalate_model: 'baseline' },
  });
});
test('M1-P2: project false wins while missing fields inherit user values without mutation', () => {
  const inputs = [baseline(), policy({ resource_mode: 'economy', auto_escalate_model: true }),
    policy({ auto_escalate_model: false, auto_escalate_reasoning: false })];
  const before = structuredClone(inputs);
  assert.deepEqual(resolvePolicy(...inputs), {
    values: { resource_mode: 'economy', reserve_frontier: true, auto_escalate_reasoning: false, auto_escalate_model: false },
    sources: { resource_mode: 'user-default', reserve_frontier: 'baseline', auto_escalate_reasoning: 'project-override', auto_escalate_model: 'project-override' },
  });
  assert.deepEqual(inputs, before);
});
for (const [label, patch] of [
  ['unknown key', { auto_escalte_model: true }],
  ['null field', { resource_mode: null }],
  ['string boolean', { auto_escalate_model: 'false' }],
  ['unknown mode', { resource_mode: 'unlimited' }],
  ['unknown version', { version: 2 }],
]) {
  test(`M1-P3: rejects ${label} instead of silently falling back`, () => {
    assert.throws(() => resolvePolicy(baseline(), policy(patch)), /Contract violation/);
    assert.throws(() => resolvePolicy(baseline(), null, policy(patch)), /Contract violation/);
  });
}
test('M1-P4: no implicit production defaults when baseline is missing or incomplete', () => {
  assert.throws(() => resolvePolicy(null), /baseline/);
  assert.throws(() => resolvePolicy(policy({ resource_mode: 'balanced' })), /required/);
});

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
function delivery() {
  const received = { brief: '问题与范围\n', design: '设计与约束\n', checks: '验收与限制\n' };
  const body = { contract: 'DeliveryManifestV1', version: 1, artifact_id: 'M1', artifact_revision: 1,
    parts: Object.entries(received).map(([id, content]) => ({ id, sha256: sha(content) })) };
  return {
    manifest: { ...body, marker: `ARTIFACT COMPLETE M1@1 ${resultDigest(body)}` },
    received,
    confirmations: body.parts.map(part => ({ artifact_id: 'M1', artifact_revision: 1,
      part_id: part.id, sha256: part.sha256, evidence_ref: `fixture-receipt:${part.id}` })),
  };
}
const inspect = d => inspectDelivery(d.manifest, d.received, d.confirmations);
test('M1-D1: full bytes, independent confirmations and exact marker complete delivery only', () => {
  const d = delivery(), before = structuredClone(d);
  assert.deepEqual(inspect(d), { confirmed_parts: ['brief', 'design', 'checks'], resume_from: null, delivery_complete: true });
  assert.deepEqual(d, before);
});
test('M1-D2: proactive part plan exposes first missing boundary before any receipt', () => {
  const d = delivery(); d.received = {}; d.confirmations = [];
  assert.deepEqual(inspect(d), { confirmed_parts: [], resume_from: 'brief', delivery_complete: false });
});
test('M1-D3: a later confirmed part cannot bridge an unconfirmed middle part', () => {
  const d = delivery(); d.confirmations.splice(1, 1);
  assert.deepEqual(inspect(d), { confirmed_parts: ['brief'], resume_from: 'design', delivery_complete: false });
});
test('M1-D4: completion marker cannot conceal a missing received part', () => {
  const d = delivery(); delete d.received.design;
  assert.deepEqual(inspect(d), { confirmed_parts: ['brief'], resume_from: 'design', delivery_complete: false });
});
test('M1-D5: all parts confirmed without marker still are not a complete delivery', () => {
  const d = delivery(); d.manifest.marker = null;
  assert.deepEqual(inspect(d), { confirmed_parts: ['brief', 'design', 'checks'], resume_from: null, delivery_complete: false });
});
test('M1-D6: stale or unrelated receipt never confirms this artifact revision', () => {
  for (const patch of [{ artifact_revision: 2 }, { artifact_id: 'OTHER' }, { sha256: '0'.repeat(64) }]) {
    const d = delivery(); Object.assign(d.confirmations[0], patch);
    assert.deepEqual(inspect(d), { confirmed_parts: [], resume_from: 'brief', delivery_complete: false });
  }
});
test('M1-D7: changed content invalidates its boundary despite the old receipt and marker', () => {
  const d = delivery(); d.received.design += '新增未经确认内容';
  assert.deepEqual(inspect(d), { confirmed_parts: ['brief'], resume_from: 'design', delivery_complete: false });
});
test('M1-D8: old marker does not validate a reordered part plan', () => {
  const d = delivery(); d.manifest.parts.reverse();
  assert.deepEqual(inspect(d), { confirmed_parts: ['checks', 'design', 'brief'], resume_from: null, delivery_complete: false });
});
test('M1-D9: duplicate parts, duplicate receipts and missing evidence are rejected', () => {
  const duplicatePart = delivery(); duplicatePart.manifest.parts.push(duplicatePart.manifest.parts[0]);
  assert.throws(() => inspect(duplicatePart), /duplicate part/);
  const duplicateReceipt = delivery(); duplicateReceipt.confirmations.push(duplicateReceipt.confirmations[0]);
  assert.throws(() => inspect(duplicateReceipt), /duplicate confirmation/);
  const noEvidence = delivery(); noEvidence.confirmations[0].evidence_ref = '';
  assert.throws(() => inspect(noEvidence), /confirmation.fields/);
});
test('M1-D10: manifest cannot embed authorization or a new lifecycle phase', () => {
  for (const extra of [{ authorization: { status: 'granted' } }, { lifecycle: 'DELIVERING' }, { version: 2 }]) {
    const d = delivery(); Object.assign(d.manifest, extra);
    assert.throws(() => inspect(d), /unexpected field|manifest.version/);
  }
});

const read = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
function governance() {
  const snapshot = read('project-state'), packet = read('execution-packet'), preflight = read('preflight');
  const ready = transition({ snapshot, packet, event: 'prepare', work_type: packet.work_type }).snapshot;
  return { snapshot: ready, packet, preflight, event: 'start', work_type: packet.work_type };
}
test('M1-I1: optional recommendation envelope can evolve while unchanged schema-2 packet starts', () => {
  const request = governance();
  const handoff = { packet: request.packet, recommendation: { recommendation_id: 'fixture-R1', revision: 1,
    binding: packetIdentity(request.packet).content_sha256, tier: 'BALANCED' } };
  const identity = packetIdentity(handoff.packet);
  handoff.recommendation.revision++;
  handoff.recommendation.explanation = 'More detail, same task requirements';
  const outcome = transition({ ...request, packet: handoff.packet });
  assert.equal(outcome.snapshot.state, 'EXECUTE');
  assert.deepEqual(outcome.snapshot.active_packet, identity);
  assert.equal(handoff.packet.schema_version, 2);
  assert.equal(handoff.packet.packet_revision, 1);
});
test('M1-I2: core packet and transition request reject extension fields', () => {
  const request = governance();
  assert.throws(() => validateExecution({ ...request.packet, routing_recommendation: {} }, request.snapshot), /unexpected field/);
  assert.throws(() => transition({ ...request, routing_recommendation: {} }), /unexpected field/);
});
for (const field of ['inputs', 'required_capabilities']) {
  test(`M1-I3: changing ${field} requires PLAN even with incremented packet revision`, () => {
    const request = governance();
    const snapshot = { ...request.snapshot, state: 'PLAN' };
    const packet = structuredClone(request.packet); packet.packet_revision++;
    if (field === 'inputs') packet.inputs.push({ ref: 'routing/R1@1.json', description: 'Now a required immutable input', available: true });
    else packet.required_capabilities.push('verified-host-capability');
    const outcome = transition({ snapshot, packet, event: 'prepare', work_type: packet.work_type });
    assert.equal(outcome.action, 'replan_required');
    assert.equal(outcome.snapshot.state, 'PLAN');
    assert.deepEqual(outcome.snapshot.active_packet, request.snapshot.active_packet);
  });
}
test('M1-I4: changing known capabilities cannot reuse the same packet revision', () => {
  const request = governance();
  request.packet.known_capabilities.push('optional-host-observation');
  assert.throws(() => transition(request), /active_packet: stale or changed packet/);
});
test('M1-I5: unverified required capability blocks with recovery conditions, not a new phase', () => {
  const request = governance();
  request.preflight.checked_capabilities[0] = { capability: 'files', available: false, evidence: 'Fixture: host capability not verified' };
  request.preflight.recovery_conditions = ['Verify access in the receiving host'];
  const outcome = transition(request);
  assert.equal(outcome.action, 'preflight_blocked');
  assert.equal(outcome.snapshot.state, 'REVIEW');
  assert.equal(outcome.result.status, 'blocked');
  assert.deepEqual(outcome.result.missing_capabilities, ['files']);
  assert.deepEqual(outcome.result.side_effects_performed, []);
  assert.deepEqual(outcome.snapshot.active_packet, request.snapshot.active_packet);
});
test('M1-I6: completed output and permissive resource settings do not grant packet authorization', () => {
  const d = delivery(); assert.equal(inspect(d).delivery_complete, true);
  const resolved = resolvePolicy(baseline(), null, policy({ resource_mode: 'quality_first', reserve_frontier: false, auto_escalate_model: true }));
  assert.equal(resolved.values.auto_escalate_model, true);
  const packet = read('execution-packet'); packet.authorization.status = 'pending';
  assert.throws(() => transition({ snapshot: read('project-state'), packet, event: 'prepare', work_type: packet.work_type }), /authorization/);
});
