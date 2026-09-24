import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transition } from '../scripts/router.mjs';
import { migrateSnapshot } from '../scripts/migration.mjs';
import * as contract from '../scripts/contracts.mjs';

const load = name => JSON.parse(readFileSync(new URL('../examples/' + name + '.json', import.meta.url), 'utf8'));
function setup() {
  return { snapshot: load('project-state'), packet: load('execution-packet'), result: load('result-packet'), review: load('review'), preflight: load('preflight'), work_type: 'general' };
}
function go(r, event) { const out = transition({ ...r, event }); r.snapshot = out.snapshot; return out; }
function sync(r) {
  for (const value of [r.result, r.result.capability_preflight, r.review, r.preflight]) Object.assign(value, contract.packetLink(r.packet));
  r.review.result_sha256 = contract.resultDigest(r.result);
}
function reviewing(r) { for (const event of ['prepare', 'start', 'submit']) go(r, event); }
function legacy(schema, state) {
  const r = setup(); reviewing(r); go(r, 'accept');
  const { snapshot, packet, result, review } = r;
  snapshot.schema_version = packet.schema_version = result.schema_version = schema;
  for (const key of ['lifecycle', 'revision_reviews', 'plan_approvals', 'migration_record']) delete snapshot[key];
  delete packet.lifecycle; delete result.lifecycle; delete result.capability_preflight.lifecycle;
  delete review.lifecycle; delete review.result_sha256; delete review.supersedes_review_id;
  delete snapshot.active_packet.lifecycle; delete snapshot.active_packet.boundary_sha256;
  if (schema === 1) {
    delete packet.authorization.source_kind;
    for (const key of ['revision_instructions', 'known_capabilities', 'capability_preflight_required', 'side_effects']) delete packet[key];
  }
  snapshot.active_packet.content_sha256 = contract.resultDigest(packet);
  snapshot.state = state;
  snapshot.result_sha256 = ['REVIEW', 'COMPLETE'].includes(state) ? contract.resultDigest(result) : null;
  snapshot.review_record = state === 'COMPLETE' ? structuredClone(review) : null;
  return { snapshot, packet, result, review: state === 'COMPLETE' ? review : null,
    confirmation: { source_kind: 'user_instruction', approval_ref: 'M1: only convert legacy format; no new execution authorization', executor_stopped: true, effects_reconciled: true, evidence_ref: 'legacy executor stopped and prior effects reconciled', pending_revision_instructions: [] } };
}
function migrated(schema = 2, state = 'REVIEW') {
  const input = legacy(schema, state), output = migrateSnapshot(input);
  assert.equal(output.status, 'migrated', JSON.stringify(output)); assert.equal(output.snapshot.state, 'PLAN');
  const r = setup(); r.snapshot = output.snapshot;
  // Schema 1 requires format-only additions; schema 2 copies the complete old grants unchanged.
  r.packet = schema === 2 ? structuredClone(input.packet) : { ...r.packet, authorization: { ...input.packet.authorization, source_kind: 'user_instruction' } };
  r.packet.schema_version = 2; r.packet.lifecycle = r.snapshot.lifecycle; r.packet.packet_revision++;
  sync(r); return { r, input };
}
function approval(r, extra = {}) {
  return { reviewer: 'CHAT', source_kind: 'user_instruction', approval_ref: 'Chat explicitly approves this complete proposal',
    from_packet_sha256: r.snapshot.active_packet?.content_sha256 ?? null, to_packet_sha256: contract.packetIdentity(r.packet).content_sha256, replaces_review_id: null, ...extra };
}
function authorize(r, id = 'EA1') {
  r.approval = approval(r, { approval_id: id, ...contract.packetLink(r.packet) });
  const out = go(r, 'reauthorize'); delete r.approval; assert.equal(out.snapshot.state, 'PLAN'); return out;
}
const effect = { action: 'local_files_write', target: 'summary.md' };
function assertCannotRun(r) {
  const out = go(r, 'prepare');
  assert.equal(out.snapshot.state, 'PLAN', 'no current execution approval must stop preparation');
  assert.equal(out.action, 'reauthorization_required');
  assert.throws(() => go(r, 'start'), /transition|execution_approval/);
  assert.throws(() => contract.checkSideEffect(r.packet, r.snapshot, effect), /stale|executing|execution_approval/);
}
for (const schema of [1, 2]) for (const state of ['READY_TO_EXECUTE', 'EXECUTE', 'REVIEW', 'COMPLETE']) {
  test(`P1 schema ${schema} ${state} copied legacy grants cannot prepare/start/perform effects`, () => {
    const { r, input } = migrated(schema, state);
    if (schema === 2) {
      assert.deepEqual(r.packet.authorization, input.packet.authorization);
      assert.deepEqual(r.packet.side_effects, input.packet.side_effects);
    }
    const before = structuredClone(input); assertCannotRun(r); assert.deepEqual(input, before);
  });
  test(`P1 schema ${schema} ${state} fresh exact approval restores execution and allowed effects`, () => {
    const { r } = migrated(schema, state); authorize(r);
    go(r, 'prepare'); go(r, 'start');
    assert.deepEqual(contract.checkSideEffect(r.packet, r.snapshot, effect), { allowed: true, status: 'allowed' });
    assert.equal(contract.checkSideEffect(r.packet, r.snapshot, { action: 'email_send', target: 'customer' }).allowed, false);
    const receipt = r.snapshot.plan_approvals.find(a => a.kind === 'execution');
    assert.equal(receipt.approval_id, 'EA1'); assert.equal(receipt.lifecycle, r.snapshot.lifecycle);
    assert.equal(receipt.to_packet_sha256, contract.packetIdentity(r.packet).content_sha256);
    go(r, 'submit'); go(r, 'accept'); assert.equal(r.snapshot.state, 'COMPLETE');
  });
}
const changes = {
  scope: r => r.packet.scope.in.push('extra work'),
  executor: r => { r.packet.executor = 'CODEX'; r.packet.work_type = r.work_type = 'code'; },
  side_effects: r => r.packet.side_effects.allowed.push({ action: 'external_send', target: 'new-target', authorization_ref: 'old authority' }),
  next_packet: r => { r.packet.packet_revision++; r.packet.scope.in.push('different packet N+1'); },
};
for (const [field, change] of Object.entries(changes)) test('P1 approved proposal changed ' + field + ' cannot use the old execution approval', () => {
  const { r } = migrated(); authorize(r); change(r);
  if (field === 'next_packet') assert.throws(() => go(r, 'prepare'), /packet_revision/);
  else assertCannotRun(r);
});
test('P1 publishing N does not authorize a materially different N+1', () => {
  const { r } = migrated(); authorize(r); go(r, 'prepare');
  r.packet.packet_revision++; r.packet.scope.in.push('new work'); assertCannotRun(r);
  authorize(r, 'EA2'); sync(r); go(r, 'prepare'); go(r, 'start');
  assert.equal(contract.checkSideEffect(r.packet, r.snapshot, effect).allowed, true);
});
test('P1 old execution approval identity cannot be replayed through reauthorize', () => {
  for (const key of ['project_id', 'task_id', 'packet_id', 'packet_revision', 'lifecycle']) {
    const { r } = migrated(); r.approval = approval(r, { approval_id: 'OLD', ...contract.packetLink(r.packet) });
    r.approval[key] = typeof r.approval[key] === 'number' ? r.approval[key] - 1 : 'old';
    assert.throws(() => go(r, 'reauthorize'), new RegExp(key));
  }
});
test('P1 executor and untrusted data cannot issue a current execution approval', () => {
  for (const change of [a => { a.reviewer = 'CODEX'; }, a => { a.source_kind = 'tool_output'; }, a => { a.approval_id = ''; }]) {
    const { r } = migrated(); r.approval = approval(r, { approval_id: 'EA1', ...contract.packetLink(r.packet) }); change(r.approval);
    assert.throws(() => go(r, 'reauthorize'), /reviewer|source_kind|approval_id/);
  }
});
test('P1 imported V1.1.1 EXECUTE state cannot bypass start via side-effect or submit', () => {
  const { r } = migrated(); r.snapshot.active_packet = contract.packetIdentity(r.packet); r.snapshot.state = 'EXECUTE';
  assert.throws(() => contract.checkSideEffect(r.packet, r.snapshot, effect), /execution_approval/);
  assert.throws(() => go(r, 'submit'), /execution_approval/);
});
test('P1 reopen cannot reuse a migrated lifecycle execution approval', () => {
  const { r } = migrated(); authorize(r); reviewing(r); go(r, 'accept');
  go(r, 'reopen'); go(r, 'plan'); r.packet.lifecycle++; r.packet.packet_revision++; sync(r); assertCannotRun(r);
  authorize(r, 'EA2'); reviewing(r); go(r, 'accept'); assert.equal(r.snapshot.lifecycle, 3);
});
function replanRequirements() {
  const r = setup(); go(r, 'prepare'); r.packet.packet_revision++; r.packet.goal += ' replanned';
  assert.equal(go(r, 'prepare').action, 'replan_required');
  r.packet.revision_instructions = ['R1: add regression before executing']; r.approval = approval(r);
  go(r, 'replan'); delete r.approval; go(r, 'prepare'); return r;
}
for (const replacement of [[], ['R2: unauthorized replacement']]) test('P2 replan-origin R1 rejects unapproved prepare replacement ' + JSON.stringify(replacement), () => {
  const r = replanRequirements(); const before = structuredClone(r.snapshot); r.packet.packet_revision++; r.packet.revision_instructions = replacement;
  assert.throws(() => go(r, 'prepare'), /revision_instructions/); assert.deepEqual(r.snapshot, before);
});
test('P2 replan-origin R1 remains required through at least ten prepare calls', () => {
  const r = replanRequirements();
  for (let i = 0; i < 10; i++) { r.packet.packet_revision++; go(r, 'prepare'); assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['R1: add regression before executing']); }
  r.packet.packet_revision++; r.packet.revision_instructions = [];
  assert.throws(() => go(r, 'prepare'), /revision_instructions/);
});
for (const replacement of [['R2: approved replacement'], []]) test('P2 explicit Chat approval can replace/cancel a plan-origin requirement ' + JSON.stringify(replacement), () => {
  const r = replanRequirements(); r.packet.packet_revision++; r.packet.goal += ' again'; go(r, 'prepare');
  const current = contract.currentRevisionRequirement(r.snapshot);
  r.packet.revision_instructions = replacement; r.approval = approval(r, { replaces_requirement_id: current.id });
  go(r, 'replan'); delete r.approval; go(r, 'prepare');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), replacement);
  const next = contract.currentRevisionRequirement(r.snapshot); assert.notEqual(next.id, current.id);
  r.packet.packet_revision++; r.packet.revision_instructions = ['R1: add regression before executing'];
  assert.throws(() => go(r, 'prepare'), /revision_instructions/);
});
test('P2 replacement requires current requirement reference, Chat and trusted source', () => {
  for (const change of [a => { delete a.replaces_requirement_id; }, a => { a.replaces_requirement_id = 'plan:stale'; }, a => { a.reviewer = 'WORK'; }, a => { a.source_kind = 'repository'; }]) {
    const r = replanRequirements(); r.packet.packet_revision++; r.packet.goal += ' again'; go(r, 'prepare');
    r.packet.revision_instructions = ['R2']; r.approval = approval(r, { replaces_requirement_id: contract.currentRevisionRequirement(r.snapshot).id }); change(r.approval);
    assert.throws(() => go(r, 'replan'), /requirement|reviewer|source_kind/);
  }
});
test('P2 REVISE explicitly references and replaces active plan-origin requirements', () => {
  const r = replanRequirements(); sync(r); go(r, 'start'); go(r, 'submit');
  r.review.verdict = 'REVISE'; r.review.revision_instructions = ['R2 from review'];
  assert.throws(() => go(r, 'revise'), /requirement/);
  r.review.supersedes_requirement_id = contract.currentRevisionRequirement(r.snapshot).id; go(r, 'revise');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['R2 from review']);
});
test('P2 ACCEPT explicitly completes requirements; reopen does not pollute a new task', () => {
  const r = replanRequirements(); sync(r); go(r, 'start'); go(r, 'submit'); go(r, 'accept');
  assert.equal(contract.currentRevisionRequirement(r.snapshot), null);
  assert.ok(r.snapshot.plan_approvals.some(a => a.revision_instructions.length));
  go(r, 'reopen'); go(r, 'plan');
  r.packet.lifecycle = r.snapshot.lifecycle; r.packet.packet_id = 'EP-T2'; r.packet.task_id = 'T2'; r.packet.packet_revision = 1; r.packet.revision_instructions = []; sync(r);
  reviewing(r); go(r, 'accept'); assert.equal(r.snapshot.lifecycle, 2);
});
test('P2 reopened non-migrated task can explicitly approve new requirements against its preserved baseline', () => {
  const r = setup(); reviewing(r); go(r, 'accept'); go(r, 'reopen'); go(r, 'plan');
  r.packet.lifecycle = r.snapshot.lifecycle; r.packet.packet_revision++; r.packet.revision_instructions = ['new lifecycle R1']; sync(r);
  assert.equal(go(r, 'prepare').action, 'replan_required');
  r.approval = approval(r); go(r, 'replan'); delete r.approval;
  reviewing(r); assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['new lifecycle R1']);
});
test('P2 initial planning cancellation approval remains bound to the exact complete proposal', () => {
  const r = setup(); r.packet.revision_instructions = ['R1'];
  r.approval = approval(r); go(r, 'replan'); delete r.approval;
  r.packet.revision_instructions = [];
  r.approval = approval(r, { replaces_requirement_id: contract.currentRevisionRequirement(r.snapshot).id });
  go(r, 'replan'); delete r.approval;
  r.packet.scope.in.push('not approved');
  const out = go(r, 'prepare');
  assert.equal(out.action, 'replan_required'); assert.equal(out.snapshot.active_packet, null);
  assert.throws(() => go(r, 'start'), /transition/);
});
