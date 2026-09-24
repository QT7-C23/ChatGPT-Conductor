import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transition } from '../scripts/router.mjs';
import { resultDigest, packetLink, packetIdentity } from '../scripts/contracts.mjs';

const load = name => JSON.parse(readFileSync(new URL('../examples/' + name, import.meta.url), 'utf8'));
function legacy(state) {
  const snapshot = load('project-state.json'), packet = load('execution-packet.json'), result = load('result-packet.json');
  snapshot.schema_version = packet.schema_version = result.schema_version = 1; snapshot.state = state;
  for (const key of ['lifecycle', 'revision_reviews', 'plan_approvals', 'migration_record', 'review_record', 'result_sha256']) delete snapshot[key];
  delete packet.lifecycle; delete result.lifecycle;
  delete packet.authorization.source_kind;
  for (const key of ['revision_instructions', 'known_capabilities', 'capability_preflight_required', 'side_effects']) delete packet[key];
  const active = !['DISCUSS', 'PLAN'].includes(state);
  snapshot.active_packet = active ? { packet_id: packet.packet_id, packet_revision: packet.packet_revision, task_id: packet.task_id, content_sha256: resultDigest(packet) } : null;
  return { snapshot, packet: active ? packet : null, result: active ? result : null, review: ['REVISE', 'COMPLETE'].includes(state) ? { packet_id: packet.packet_id, packet_revision: packet.packet_revision, decision: 'accepted', reviewer: 'CHAT', evidence: '旧版审核' } : null,
    confirmation: { source_kind: 'user_instruction', approval_ref: 'Chat 核对用户批准迁移记录 M1', executor_stopped: true, effects_reconciled: true, evidence_ref: '保留旧文件和动作清单', pending_revision_instructions: state === 'REVISE' ? ['修订旧结果'] : [] } };
}
const migrate = async input => (await import('../scripts/migration.mjs')).migrateSnapshot(input);
for (const stage of ['DISCUSS', 'PLAN', 'READY_TO_EXECUTE', 'EXECUTE', 'REVIEW', 'REVISE', 'COMPLETE']) test('F04 schema 1 ' + stage + ' migrates only into a non-executing safe state', async () => {
  const input = legacy(stage); const before = structuredClone(input); const out = await migrate(input);
  assert.equal(out.status, 'migrated'); assert.equal(out.snapshot.state, stage === 'DISCUSS' ? 'DISCUSS' : 'PLAN');
  assert.equal(out.snapshot.lifecycle, 2); assert.equal(out.snapshot.revision, input.snapshot.revision + 1);
  assert.equal(out.snapshot.decision_version, input.snapshot.decision_version);
  assert.equal(out.snapshot.result_sha256, null); assert.equal(out.snapshot.review_record, null);
  assert.equal(out.snapshot.migration_record.source_sha256, resultDigest(input.snapshot));
  assert.deepEqual(input, before, 'migration must not rewrite the legacy evidence');
  const packet = input.packet ?? load('execution-packet.json');
  assert.throws(() => transition({ snapshot: out.snapshot, packet, event: 'start', work_type: 'general' }), /transition/);
  if (input.packet) {
    assert.equal(out.snapshot.active_packet.packet_revision, input.packet.packet_revision);
    assert.throws(() => transition({ snapshot: out.snapshot, packet: input.packet, event: 'prepare', work_type: 'general' }), /packet|schema|lifecycle/);
  }
});
for (const field of ['executor_stopped', 'effects_reconciled']) test('F04 EXECUTE migration blocks when ' + field + ' is unconfirmed', async () => {
  const input = legacy('EXECUTE'); input.confirmation[field] = false;
  const out = await migrate(input); assert.equal(out.status, 'blocked'); assert.equal('snapshot' in out, false); assert.match(out.reasons.join(' '), new RegExp(field));
});
for (const stage of ['REVIEW', 'REVISE', 'COMPLETE']) test('F04 ' + stage + ' migration blocks missing result evidence', async () => {
  const input = legacy(stage); input.result = null;
  const out = await migrate(input); assert.equal(out.status, 'blocked'); assert.equal('snapshot' in out, false);
});
test('F04 migration rejects unknown lifecycle, missing packet and untrusted authority', async () => {
  for (const mutate of [x => { x.packet = null; }, x => { x.confirmation.source_kind = 'tool_output'; }, x => { x.snapshot.lifecycle = 99; }, x => { x.packet.goal += 'tampered'; }]) {
    const input = legacy('EXECUTE'); mutate(input); const out = await migrate(input); assert.equal(out.status, 'blocked'); assert.equal('snapshot' in out, false);
  }
});
test('F04 historical COMPLETE never supplies new COMPLETE approval or deployment authorization', async () => {
  const out = await migrate(legacy('COMPLETE'));
  assert.equal(out.snapshot.review_record, null);
  assert.throws(() => transition({ snapshot: out.snapshot, event: 'accept', work_type: 'general' }), /transition/);
  assert.ok(out.snapshot.migration_record.review_sha256);
  assert.equal(out.snapshot.migration_record.authorization_inherited, false);
});
test('F02/F04 migration cannot erase outstanding REVISE instructions', async () => {
  const input = legacy('REVISE'); input.review.revision_instructions = ['原审核要求必须保留']; input.confirmation.pending_revision_instructions = [...input.review.revision_instructions];
  const out = await migrate(input); assert.equal(out.status, 'migrated');
  const packet = load('execution-packet.json'); packet.lifecycle = 2; packet.packet_revision++;
  assert.throws(() => transition({ snapshot: out.snapshot, packet, event: 'prepare', work_type: 'general' }), /revision_instructions/);
  packet.revision_instructions = ['原审核要求必须保留'];
  const approval = { reviewer: 'CHAT', source_kind: 'user_instruction', approval_ref: '本测试明确重新批准执行', approval_id: 'EA-migration-retention', ...packetLink(packet), from_packet_sha256: out.snapshot.active_packet.content_sha256, to_packet_sha256: packetIdentity(packet).content_sha256, replaces_review_id: null };
  const authorized = transition({ snapshot: out.snapshot, packet, approval, event: 'reauthorize', work_type: 'general' });
  const ready = transition({ snapshot: authorized.snapshot, packet, event: 'prepare', work_type: 'general' });
  assert.equal(ready.snapshot.state, 'READY_TO_EXECUTE');
  packet.packet_revision++; packet.revision_instructions = [];
  assert.throws(() => transition({ snapshot: ready.snapshot, packet, event: 'prepare', work_type: 'general' }), /revision_instructions/);
});
test('F04 original schema 2 REVIEW migrates once; changed result and missing reconciliation fail closed', async () => {
  const input = legacy('REVIEW');
  input.snapshot.schema_version = input.packet.schema_version = input.result.schema_version = 2;
  input.snapshot.active_packet.content_sha256 = resultDigest(input.packet);
  input.snapshot.result_sha256 = resultDigest(input.result); input.snapshot.review_record = null;
  const out = await migrate(input); assert.equal(out.status, 'migrated'); assert.equal(out.snapshot.state, 'PLAN');
  assert.equal((await migrate({ ...input, snapshot: out.snapshot })).status, 'blocked');
  const changed = structuredClone(input); changed.result.summary = '替换结果';
  assert.equal((await migrate(changed)).status, 'blocked');
  delete input.confirmation.pending_revision_instructions;
  assert.equal((await migrate(input)).status, 'blocked');
});
