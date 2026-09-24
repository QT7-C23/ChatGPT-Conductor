import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transition, classify, rules } from '../scripts/router.mjs';
import { validateExecution, validateResult, packetIdentity, packetLink, resultDigest } from '../scripts/contracts.mjs';
import { migrateSnapshot } from '../scripts/migration.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const base = {
  snapshot: read('../examples/project-state.json'),
  packet: read('../examples/execution-packet.json'),
  result: read('../examples/result-packet.json'),
  review: read('../examples/review.json'),
};
function request(state = 'PLAN', event = 'prepare') {
  const r = structuredClone({ ...base, event, work_type: 'general', preflight: base.result.capability_preflight });
  r.snapshot.state = state;
  if (['REVIEW', 'REVISE', 'COMPLETE'].includes(state)) r.snapshot.result_sha256 = resultDigest(r.result);
  if (!['DISCUSS', 'PLAN'].includes(state)) {
    r.snapshot.active_packet = packetIdentity(r.packet);
  }
  if (state === 'COMPLETE') r.snapshot.review_record = structuredClone(r.review);
  if (state === 'REVISE') {
    r.snapshot.review_record = { ...structuredClone(r.review), verdict: 'REVISE', revision_instructions: ['按审核意见调整'] };
    r.packet.revision_instructions = ['按审核意见调整'];
    r.snapshot.revision_reviews = [structuredClone(r.snapshot.review_record)];
  }
  return r;
}
const challenge = {
  project_id: 'demo', task_id: 'T1', packet_id: 'EP-T1', packet_revision: 1, decision_version: 1, executor: 'WORK', lifecycle: 1, blocking: true,
  decision_id: 'D1', reason: '输入包含发布要求，与锁定范围冲突',
  evidence: 'brief.md 第三节', proposal: '请在 Chat 决定是否另立发布任务',
  impact: '影响发布步骤', affected_tasks: ['T1'],
};
for (const c of read('./routing-cases.json')) {
  test(c.id + ': ' + c.prompt, () => {
    const r = request(c.state, c.event);
    r.work_type = c.work_type;
    if (c.work_type === 'code') {
      r.packet.work_type = 'code';
      r.packet.executor = 'CODEX';
    }
    if (c.event === 'prepare' && c.state === 'REVISE') r.packet.packet_revision = 2;
    if (c.event === 'challenge') r.challenge = challenge;
    if (c.event === 'revise') { r.review.verdict = 'REVISE'; r.review.revision_instructions = ['修订简报']; }
    if (c.event === 'escalate') { r.review.verdict = 'ESCALATE'; r.challenge = challenge; }
    if (c.event === 'replan') {
      r.snapshot.active_packet = packetIdentity(r.packet); r.packet.packet_revision++; r.packet.goal += '已批准的调整';
      r.approval = { reviewer: 'CHAT', source_kind: 'user_instruction', approval_ref: '用户已批准重新规划', from_packet_sha256: r.snapshot.active_packet.content_sha256, to_packet_sha256: packetIdentity(r.packet).content_sha256, replaces_review_id: null };
    }
    if (c.event === 'reauthorize') {
      r.snapshot = migrateSnapshot(read('../examples/migration-request.json')).snapshot;
      r.packet.lifecycle = r.snapshot.lifecycle;
      r.approval = { reviewer: 'CHAT', source_kind: 'user_instruction', approval_ref: '用户明确批准迁移后的完整执行包', approval_id: 'EA-R14', ...packetLink(r.packet), from_packet_sha256: null, to_packet_sha256: packetIdentity(r.packet).content_sha256, replaces_review_id: null };
    }
    const before = structuredClone(r);
    const outcome = transition(r);
    assert.equal(outcome.snapshot.state, c.expected_state);
    assert.equal(outcome.surface, c.surface);
    assert.equal(outcome.snapshot.revision, r.snapshot.revision + 1);
    assert.deepEqual(r, before, 'routing must not mutate caller state');
  });
}
test('classification follows deliverable, mixed and unknown need Chat', () => {
  assert.equal(classify('code'), 'CODEX');
  assert.equal(classify('general'), 'WORK');
  assert.equal(classify('mixed'), 'CHAT');
  assert.equal(classify('unknown'), 'CHAT');
});
const rejected = [
  ['plan approval is not execution authorization', r => { r.packet.authorization.status = 'pending'; }, /authorization/],
  ['missing user authorization reference', r => { r.packet.authorization.source = ''; }, /authorization.source/],
  ['locked decision changed in packet', r => { r.packet.locked_decisions[0].decision = '直接发布'; }, /locked_decisions/],
  ['stale decision version', r => { r.packet.decision_version = 0; }, /decision_version/],
  ['blocking open decision', r => { r.snapshot.open_decisions[0].blocking = true; r.packet.open_decisions[0].blocking = true; }, /blocking/],
  ['missing input', r => { r.packet.inputs[0].available = false; }, /inputs/],
  ['pending dependency', r => { r.packet.dependencies = [{ task_id: 'T0', status: 'pending' }]; }, /dependencies/],
  ['unknown capability must require preflight', r => { r.packet.known_capabilities = []; r.packet.capability_preflight_required = false; }, /capabilities/],
  ['code misrouted to Work', r => { r.packet.work_type = 'code'; r.work_type = 'code'; }, /executor/],
  ['mixed task must be split', r => { r.work_type = 'mixed'; }, /split/],
  ['unknown task needs clarification', r => { r.work_type = 'unknown'; }, /clarify/],
  ['empty acceptance criteria', r => { r.packet.acceptance = []; }, /acceptance/],
  ['duplicate criterion IDs', r => { r.packet.acceptance.push(r.packet.acceptance[0]); }, /duplicate/],
  ['unknown packet field', r => { r.packet.silent_override = true; }, /unexpected/],
];
for (const [name, change, error] of rejected) test(name, () => {
  const r = request(); change(r); assert.throws(() => transition(r), error);
});
test('changed locked decision in result cannot pass review', () => {
  const r = request('EXECUTE', 'submit');
  r.result.locked_decisions[0].decision = '已经发布';
  assert.throws(() => transition(r), /locked_decisions/);
});
test('executor cannot resolve a Chat-owned decision', () => {
  const r = request('EXECUTE', 'submit');
  r.snapshot.open_decisions[0].owner = 'CHAT';
  r.packet.open_decisions[0].owner = 'CHAT';
  r.snapshot.active_packet = packetIdentity(r.packet);
  assert.throws(() => transition(r), /owner/);
});
test('stale result is rejected', () => {
  const r = request('EXECUTE', 'submit'); r.result.packet_revision = 2;
  assert.throws(() => transition(r), /packet_revision/);
});
test('missing evidence is rejected', () => {
  const r = request('EXECUTE', 'submit'); r.result.checks[0].evidence = '';
  assert.throws(() => transition(r), /evidence/);
});
test('failed checks can be reviewed, never completed', () => {
  const r = request('EXECUTE', 'submit');
  r.result.status = 'partial'; r.result.checks[0].status = 'failed';
  r.snapshot = transition(r).snapshot;
  assert.equal(r.snapshot.state, 'REVIEW');
  r.event = 'accept'; r.review.result_sha256 = resultDigest(r.result);
  assert.throws(() => transition(r), /complete/);
});
test('executor success is not Chat approval', () => {
  const r = request('REVIEW', 'accept'); r.review.reviewer = 'WORK';
  assert.throws(() => transition(r), /reviewer/);
});
test('review bound to exact packet revision', () => {
  const r = request('REVIEW', 'accept'); r.review.packet_revision = 2;
  assert.throws(() => transition(r), /review/);
});
test('active packet blocks replay of old task', () => {
  const r = request('READY_TO_EXECUTE', 'start');
  r.snapshot.active_packet.packet_id = 'EP-OTHER';
  assert.throws(() => transition(r), /active_packet/);
});
test('revision requires a newer packet', () => {
  assert.throws(() => transition(request('REVISE', 'prepare')), /packet_revision/);
});
test('challenge stops dispatch and preserves paused packet identity', () => {
  const r = request('EXECUTE', 'challenge'); r.challenge = challenge;
  const out = transition(r);
  assert.equal(out.surface, 'CHAT');
  assert.deepEqual(out.snapshot.active_packet, r.snapshot.active_packet);
  assert.equal(out.snapshot.escalations[0].resolution_ref, null);
  assert.deepEqual(out.snapshot.locked_decisions, r.snapshot.locked_decisions);
});
test('submitted challenge escalates rather than approving', () => {
  const r = request('EXECUTE', 'submit'); r.result.challenges = [challenge]; r.result.status = 'blocked';
  assert.equal(transition(r).snapshot.state, 'PLAN');
});
test('no direct EXECUTE to COMPLETE', () => {
  assert.throws(() => transition(request('EXECUTE', 'accept')), /transition/);
});
test('invalid states and events fail closed', () => {
  const r = request(); r.snapshot.state = 'AUTO'; assert.throws(() => transition(r), /state/);
  r.snapshot.state = 'PLAN'; r.event = 'autopublish'; assert.throws(() => transition(r), /event/);
});
test('baseline and examples satisfy contracts', () => {
  const r = request();
  validateExecution(r.packet, r.snapshot);
  validateResult(r.result, r.packet);
});
test('every declared state and event is represented by successful route cases', () => {
  const cases = read('./routing-cases.json');
  assert.deepEqual(new Set(cases.flatMap(c => [c.state, c.expected_state])), new Set(rules.states));
  assert.deepEqual(new Set(cases.map(c => c.event)), new Set(Object.keys(rules.events)));
});
test('array events cannot bypass guards via property-key coercion', () => {
  const r = request('REVIEW', 'accept'); r.event = ['accept'];
  delete r.packet; delete r.result; delete r.review;
  assert.throws(() => transition(r), /event/);
  r.snapshot.state = 'READY_TO_EXECUTE'; r.event = ['start'];
  assert.throws(() => transition(r), /event/);
});
test('work_type must be a primitive string', () => {
  const r = request(); r.work_type = ['general'];
  assert.throws(() => transition(r), /work_type/);
});
test('same packet ID and revision cannot change authorized content', () => {
  const r = request(); r.snapshot = transition(r).snapshot; r.event = 'start';
  r.packet.goal = '换成另一个目标';
  assert.throws(() => transition(r), /active_packet/);
});
test('challenge cannot restart without a recorded resolution and new packet', () => {
  const r = request('EXECUTE', 'challenge'); r.challenge = challenge;
  r.snapshot = transition(r).snapshot; r.event = 'prepare'; delete r.challenge;
  assert.throws(() => transition(r), /challenge/);
  r.snapshot.escalations[0].resolution_ref = '用户批准维持原决策，记录 DC1';
  r.snapshot.revision++;
  assert.throws(() => transition(r), /packet_revision/);
  r.packet.packet_revision++;
  r.snapshot = transition(r).snapshot; r.event = 'start';
  r.preflight.packet_revision = r.packet.packet_revision;
  r.preflight.checked_capabilities[0].evidence = '新包执行前重新确认能力可用';
  assert.equal(transition(r).snapshot.state, 'EXECUTE');
});
test('fingerprint is stable across JSON object key ordering', () => {
  const p = structuredClone(base.packet);
  const reordered = Object.fromEntries(Object.entries(p).reverse());
  assert.deepEqual(packetIdentity(p), packetIdentity(reordered));
});
