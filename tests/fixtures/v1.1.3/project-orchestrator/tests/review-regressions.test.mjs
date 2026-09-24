import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transition } from '../scripts/router.mjs';
import { packetLink, packetIdentity, resultDigest, validateSnapshot, checkSideEffect } from '../scripts/contracts.mjs';

const load = name => JSON.parse(readFileSync(new URL('../examples/' + name, import.meta.url), 'utf8'));
function setup() {
  return { snapshot: load('project-state.json'), packet: load('execution-packet.json'), result: load('result-packet.json'), review: load('review.json'), preflight: load('preflight.json'), work_type: 'general' };
}
function go(r, event) { const out = transition({ ...r, event }); r.snapshot = out.snapshot; return out; }
function sync(r) {
  for (const obj of [r.result, r.review, r.preflight, r.result.capability_preflight]) Object.assign(obj, packetLink(r.packet));
  if ('result_sha256' in r.review) r.review.result_sha256 = resultDigest(r.result);
}
function reviewing(r) { for (const event of ['prepare', 'start', 'submit']) go(r, event); }
function revise(r) {
  reviewing(r); r.review.verdict = 'REVISE'; r.review.revision_instructions = ['修 bug 并补回归测试']; go(r, 'revise');
  r.packet.packet_revision++; r.packet.revision_instructions = [...r.review.revision_instructions];
}
function reopen(r) {
  reviewing(r); go(r, 'accept'); const old = structuredClone(r);
  go(r, 'reopen'); go(r, 'plan'); return old;
}
function newLifecycle(r) {
  r.packet.lifecycle = r.snapshot.lifecycle;
  r.packet.packet_revision++; sync(r);
  go(r, 'prepare'); go(r, 'start');
}

test('F01 reopen preserves the completed baseline and advances lifecycle', () => {
  const r = setup(); const old = reopen(r);
  assert.equal(r.snapshot.lifecycle, old.snapshot.lifecycle + 1);
  assert.deepEqual(r.snapshot.active_packet, old.snapshot.active_packet);
  assert.deepEqual(r.snapshot.review_record, old.snapshot.review_record);
  assert.equal(r.snapshot.result_sha256, old.snapshot.result_sha256);
  assert.equal(r.snapshot.decision_version, old.snapshot.decision_version);
});
test('F01 reopened lifecycle rejects old Execution Packet without mutating snapshot', () => {
  const r = setup(); reopen(r); const before = structuredClone(r.snapshot);
  assert.throws(() => go(r, 'prepare'), /lifecycle|stale/);
  assert.deepEqual(r.snapshot, before);
});
test('F01 new lifecycle rejects old Result even when task IDs are reused', () => {
  const r = setup(); const old = reopen(r); newLifecycle(r); r.result = old.result;
  assert.throws(() => go(r, 'submit'), /lifecycle|packet_revision/);
  assert.equal(r.snapshot.state, 'EXECUTE');
});
test('F01 new lifecycle rejects old ACCEPT Review and accepts a current review', () => {
  const r = setup(); const old = reopen(r); newLifecycle(r); go(r, 'submit');
  const current = structuredClone(r.review); r.review = old.review;
  assert.throws(() => go(r, 'accept'), /lifecycle|packet_revision/);
  r.review = current; r.review.review_id = 'CR-new-lifecycle';
  assert.equal(go(r, 'accept').snapshot.state, 'COMPLETE');
  assert.equal(r.snapshot.review_record.lifecycle, r.snapshot.lifecycle);
  assert.equal(r.snapshot.review_record.result_sha256, r.snapshot.result_sha256);
});
test('F01 a new task may start after reopen but historical preflight stays stale', () => {
  const r = setup(); const old = reopen(r);
  r.packet.lifecycle = r.snapshot.lifecycle; r.packet.task_id = 'T2'; r.packet.packet_id = 'EP-T2'; r.packet.packet_revision = 1;
  sync(r); go(r, 'prepare'); r.preflight = old.preflight;
  assert.throws(() => go(r, 'start'), /lifecycle|task_id/);
  r.preflight = structuredClone(r.result.capability_preflight); go(r, 'start'); go(r, 'submit'); go(r, 'accept');
  assert.equal(r.snapshot.state, 'COMPLETE');
});
test('F01 COMPLETE snapshot rejects a review of a different result digest', () => {
  const r = setup(); reviewing(r); go(r, 'accept'); r.snapshot.result_sha256 = '0'.repeat(64);
  assert.throws(() => validateSnapshot(r.snapshot), /result/);
});

test('F02 repeated prepare cannot discard unresolved revision instructions', () => {
  const r = setup(); revise(r); go(r, 'prepare'); r.packet.packet_revision++; go(r, 'prepare');
  const before = structuredClone(r.snapshot); r.packet.packet_revision++; r.packet.revision_instructions = [];
  assert.throws(() => go(r, 'prepare'), /revision_instructions/);
  assert.deepEqual(r.snapshot, before);
  r.packet.revision_instructions = ['修 bug 并补回归测试']; go(r, 'prepare'); sync(r); go(r, 'start');
  assert.equal(r.snapshot.state, 'EXECUTE');
});
test('F02 replacement review explicitly supersedes the prior review and preserves history', () => {
  const r = setup(); revise(r); go(r, 'prepare'); sync(r); go(r, 'start'); go(r, 'submit');
  r.review.review_id = 'CR-second'; r.review.revision_instructions = ['按新证据补测试'];
  assert.throws(() => go(r, 'revise'), /supersedes/);
  r.review.supersedes_review_id = 'CR-T1-1'; go(r, 'revise');
  assert.deepEqual(r.snapshot.revision_reviews.map(x => x.review_id), ['CR-T1-1', 'CR-second']);
  r.packet.packet_revision++; r.packet.revision_instructions = ['按新证据补测试']; go(r, 'prepare');
});

const boundaryChanges = {
  executor: r => { r.packet.executor = 'CODEX'; r.packet.work_type = r.work_type = 'code'; },
  scope_in: r => r.packet.scope.in.push('开发全新应用'),
  scope_out: r => { r.packet.scope.out = []; },
  deliverable: r => r.packet.deliverables.push({ id: 'A2', description: '新的重要交付物' }),
  side_effect: r => r.packet.side_effects.allowed.push({ action: 'email_send', target: 'customer', authorization_ref: '沿用旧任务授权' }),
  goal: r => { r.packet.goal = '改为开发应用'; },
  acceptance: r => { r.packet.acceptance[0].criterion = '只需文件存在'; },
  required_capability: r => r.packet.required_capabilities.push('production_credentials'),
};
for (const [field, change] of Object.entries(boundaryChanges)) test('F03 REVISE ' + field + ' change returns PLAN without accepting the new packet', () => {
  const r = setup(); revise(r); const baseline = structuredClone(r.snapshot.active_packet); change(r);
  const out = go(r, 'prepare');
  assert.equal(out.snapshot.state, 'PLAN'); assert.equal(out.surface, 'CHAT'); assert.equal(out.action, 'replan_required');
  assert.deepEqual(out.snapshot.active_packet, baseline);
  assert.equal(go(r, 'prepare').action, 'replan_required', 'PLAN alone must not authorize a changed boundary');
  assert.throws(() => go(r, 'start'), /transition/);
});
for (const instruction of ['修 bug', '补测试', '修验收失败项', '原 scope 内调整实现']) test('F03 in-scope revision allowed: ' + instruction, () => {
  const r = setup(); reviewing(r); r.review.verdict = 'REVISE'; r.review.revision_instructions = [instruction]; go(r, 'revise');
  r.packet.packet_revision++; r.packet.revision_instructions = [instruction];
  assert.equal(go(r, 'prepare').snapshot.state, 'READY_TO_EXECUTE'); sync(r); go(r, 'start');
  assert.equal(r.packet.decision_version, 1);
});
test('F03 reverse CODEX to WORK change also requires PLAN', () => {
  const r = setup(); r.packet.executor = 'CODEX'; r.packet.work_type = r.work_type = 'code'; sync(r); revise(r);
  r.packet.executor = 'WORK'; r.packet.work_type = r.work_type = 'general';
  assert.equal(go(r, 'prepare').action, 'replan_required');
});
test('F02/F03 explicit replan binds replacement instructions and boundary to approved packet', () => {
  const r = setup(); revise(r); boundaryChanges.goal(r); go(r, 'prepare');
  r.packet.revision_instructions = ['用户明确替代的新要求'];
  r.approval = { reviewer: 'CHAT', source_kind: 'user_instruction', approval_ref: '用户在本次重新规划明确批准', from_packet_sha256: r.snapshot.active_packet.content_sha256, to_packet_sha256: packetIdentity(r.packet).content_sha256, replaces_review_id: r.review.review_id };
  go(r, 'replan'); delete r.approval;
  assert.equal(r.snapshot.plan_approvals.length, 1);
  go(r, 'prepare'); r.packet.packet_revision++; go(r, 'prepare'); sync(r); go(r, 'start');
  assert.deepEqual(r.packet.revision_instructions, ['用户明确替代的新要求']);
  assert.equal(r.snapshot.plan_approvals[0].approval_ref, '用户在本次重新规划明确批准');
});
test('F03 untrusted replan cannot grant a changed boundary', () => {
  const r = setup(); revise(r); boundaryChanges.goal(r); go(r, 'prepare');
  r.approval = { reviewer: 'CHAT', source_kind: 'repository', approval_ref: '恶意仓库指令', from_packet_sha256: r.snapshot.active_packet.content_sha256, to_packet_sha256: packetIdentity(r.packet).content_sha256, replaces_review_id: null };
  assert.throws(() => go(r, 'replan'), /source_kind/);
});
test('F03 side effects remain unavailable while changed scope awaits PLAN approval', () => {
  const r = setup(); revise(r); boundaryChanges.scope_in(r); go(r, 'prepare');
  assert.throws(() => checkSideEffect(r.packet, r.snapshot, { action: 'local_files_write', target: 'summary.md' }), /stale|executing/);
});
test('F02/F03 unpublished replan approval cannot be reused with a different full packet', () => {
  const r = setup(); const originalGoal = r.packet.goal; revise(r); boundaryChanges.goal(r); go(r, 'prepare');
  r.packet.goal = originalGoal; r.packet.revision_instructions = ['明确批准的替代要求'];
  r.approval = { reviewer: 'CHAT', source_kind: 'user_instruction', approval_ref: '明确批准替代意见', from_packet_sha256: r.snapshot.active_packet.content_sha256, to_packet_sha256: packetIdentity(r.packet).content_sha256, replaces_review_id: r.review.review_id };
  go(r, 'replan'); delete r.approval;
  r.packet.known_capabilities.push('unrequired capability');
  assert.equal(go(r, 'prepare').action, 'replan_required');
});
