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
function approval(r, extra = {}) {
  return { reviewer: 'CHAT', source_kind: 'user_instruction', approval_ref: 'Synthetic Chat approval of this exact proposal', from_packet_sha256: r.snapshot.active_packet?.content_sha256 ?? null, to_packet_sha256: contract.packetIdentity(r.packet).content_sha256, replaces_review_id: null, ...extra };
}
function escalating(existing = false) {
  const r = setup();
  if (existing) {
    r.packet.revision_instructions = ['R1']; r.approval = approval(r); go(r, 'replan'); delete r.approval;
  }
  for (const event of ['prepare', 'start', 'submit']) go(r, event);
  escalateReview(r, ['R-ESC']);
  return r;
}
function escalateReview(r, instructions, id = 'ESC-1') {
  r.review.verdict = 'ESCALATE'; r.review.review_id = id; r.review.revision_instructions = instructions;
  r.review.supersedes_review_id = null; delete r.review.supersedes_requirement_id;
  r.challenge = { ...contract.packetLink(r.packet), blocking: true, decision_id: 'D1', reason: 'Independent scope ambiguity', evidence: 'Scope clarification requested', proposal: 'Confirm the existing scope', impact: 'Pause until clarification', affected_tasks: [r.packet.task_id] };
  go(r, 'escalate'); delete r.challenge;
}
function resolveChallenge(r) {
  r.snapshot.escalations.at(-1).resolution_ref = 'Chat resolved only the ambiguity; all revision requirements remain mandatory';
  r.snapshot.revision++;
  contract.validateSnapshot(r.snapshot);
}
const effect = { action: 'local_files_write', target: 'summary.md' };

for (const existing of [false, true]) test('V113 core ' + (existing ? 'B: ESCALATE additions cannot disappear behind existing R1' : 'A: ESCALATE instructions cannot disappear after Challenge resolution'), () => {
  const r = escalating(existing); resolveChallenge(r);
  r.packet.packet_revision++; sync(r);
  const before = structuredClone(r);
  let publication, permission, rejection;
  try {
    publication = go(r, 'prepare'); go(r, 'start');
    permission = contract.checkSideEffect(r.packet, r.snapshot, effect);
  } catch (error) { rejection = error.message; }
  assert.notEqual(r.snapshot.state, 'EXECUTE', JSON.stringify({ publication: publication?.action, instructions: r.packet.revision_instructions, active: contract.currentRevisionInstructions(r.snapshot), permission }));
  assert.match(rejection, /revision_instructions/);
  assert.deepEqual(r, before, 'rejected publication must preserve state, requirement evidence and caller input');
  assert.throws(() => go(r, 'start'), /transition/);
  assert.throws(() => contract.checkSideEffect(r.packet, r.snapshot, effect), /stale|executing/);
  assert.deepEqual(r, before);
});

function nextPacket(r, instructions = contract.currentRevisionInstructions(r.snapshot) ?? []) {
  r.packet.packet_revision++; r.packet.revision_instructions = [...instructions]; sync(r);
}
function approved(r, extra = {}, execution = false) {
  r.approval = approval(r, { ...(execution ? { approval_id: 'EA-' + r.snapshot.revision, ...contract.packetLink(r.packet) } : {}), ...extra });
  go(r, execution ? 'reauthorize' : 'replan'); delete r.approval;
}
function unchangedRejection(r, event, pattern) {
  const before = structuredClone(r); assert.throws(() => go(r, event), pattern); assert.deepEqual(r, before);
}
function finish(r) {
  go(r, 'submit'); r.review.verdict = 'ACCEPT'; r.review.revision_instructions = [];
  r.review.supersedes_review_id = null; delete r.review.supersedes_requirement_id; go(r, 'accept');
}

for (const existing of [false, true]) test('V113 C/G: full requirements recover execution, existing=' + existing, () => {
  const r = escalating(existing), raw = structuredClone(r.review);
  const instructions = existing ? ['R1', 'R-ESC'] : ['R-ESC'];
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), instructions);
  assert.deepEqual(r.snapshot.review_record, raw, 'raw Chat evidence must remain verbatim');
  nextPacket(r); unchangedRejection(r, 'prepare', /challenge/);
  resolveChallenge(r); go(r, 'prepare'); go(r, 'start');
  assert.equal(contract.checkSideEffect(r.packet, r.snapshot, effect).allowed, true);
  assert.equal(contract.checkSideEffect(r.packet, r.snapshot, { action: 'email_send', target: 'customer' }).allowed, false);
  assert.equal(r.snapshot.review_record, null);
  assert.deepEqual(r.snapshot.revision_reviews.find(x => x.review_id === 'ESC-1').revision_instructions, ['R-ESC']);
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), instructions);
});
test('V113 D: twelve prepares retain ESC requirements and reject clearing/replacing atomically', () => {
  const r = escalating(true); resolveChallenge(r);
  const requirement = structuredClone(contract.currentRevisionRequirement(r.snapshot));
  for (let i = 0; i < 12; i++) { nextPacket(r); go(r, 'prepare'); assert.deepEqual(contract.currentRevisionRequirement(r.snapshot), requirement); }
  for (const instructions of [[], ['R1'], ['UNAPPROVED']]) {
    const bad = structuredClone(r); nextPacket(bad, instructions); unchangedRejection(bad, 'prepare', /revision_instructions/);
    unchangedRejection(bad, 'start', /stale|changed/);
    assert.throws(() => contract.checkSideEffect(bad.packet, bad.snapshot, effect), /stale|executing/);
  }
  sync(r); go(r, 'start'); assert.equal(r.snapshot.state, 'EXECUTE');
});
for (const replacement of [[], ['R2']]) test('V113 E: explicit replacement/cancel succeeds ' + JSON.stringify(replacement), () => {
  const r = escalating(true); resolveChallenge(r);
  const old = contract.currentRevisionRequirement(r.snapshot); nextPacket(r, replacement);
  approved(r, { replaces_requirement_id: old.id }); go(r, 'prepare'); go(r, 'start');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), replacement);
  assert.equal(r.snapshot.revision_reviews[0].review_id, 'ESC-1');
  assert.equal(contract.checkSideEffect(r.packet, r.snapshot, effect).allowed, true);
});
for (const invalid of ['missing', 'stale', 'reviewer', 'source', 'lifecycle', 'task', 'digest']) test('V113 E: invalid requirement change rejected atomically: ' + invalid, () => {
  const r = escalating(true); resolveChallenge(r); const current = contract.currentRevisionRequirement(r.snapshot);
  nextPacket(r, []); r.approval = approval(r, { replaces_requirement_id: current.id });
  if (invalid === 'missing') delete r.approval.replaces_requirement_id;
  if (invalid === 'stale') r.approval.replaces_requirement_id = 'review:stale';
  if (invalid === 'reviewer') r.approval.reviewer = 'WORK';
  if (invalid === 'source') r.approval.source_kind = 'tool_output';
  if (invalid === 'lifecycle') r.packet.lifecycle++;
  if (invalid === 'task') r.packet.task_id = 'another-task';
  if (invalid === 'digest') r.approval.to_packet_sha256 = 'a'.repeat(64);
  unchangedRejection(r, 'replan', /requirement|reviewer|source_kind|lifecycle|task_id|sha256/);
});
test('V113 E: approved cancellation remains bound to the complete proposal', () => {
  const r = escalating(); resolveChallenge(r); const old = contract.currentRevisionRequirement(r.snapshot);
  nextPacket(r, []); approved(r, { replaces_requirement_id: old.id });
  r.packet.scope.in.push('not approved'); const before = structuredClone(r.snapshot);
  assert.equal(go(r, 'prepare').action, 'replan_required');
  assert.deepEqual(r.snapshot.revision_reviews, before.revision_reviews); assert.deepEqual(r.snapshot.review_record, before.review_record);
  unchangedRejection(r, 'start', /transition/);
});
test('V113 F: same lifecycle persists; ACCEPT/reopen isolates history and rejects old references', () => {
  const r = escalating(true); resolveChallenge(r); const old = contract.currentRevisionRequirement(r.snapshot);
  go(r, 'discuss'); go(r, 'plan'); assert.deepEqual(contract.currentRevisionRequirement(r.snapshot), old);
  nextPacket(r); go(r, 'prepare'); go(r, 'start'); finish(r);
  assert.equal(contract.currentRevisionRequirement(r.snapshot), null);
  go(r, 'reopen'); go(r, 'plan'); assert.equal(contract.currentRevisionRequirement(r.snapshot), null);
  r.packet.lifecycle = r.snapshot.lifecycle; nextPacket(r, ['NEW']);
  r.approval = approval(r, { replaces_requirement_id: old.id }); unchangedRejection(r, 'replan', /no replacement/); delete r.approval;
  approved(r); go(r, 'prepare'); go(r, 'start');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['NEW']);
  assert.equal(r.snapshot.lifecycle, 2);
});
test('V113 additive ESC repeats keep original evidence and stable unique instruction order', () => {
  const r = escalating(true); resolveChallenge(r); nextPacket(r); go(r, 'prepare'); go(r, 'start'); go(r, 'submit');
  escalateReview(r, ['R-ESC', 'R2'], 'ESC-2'); resolveChallenge(r);
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['R1', 'R-ESC', 'R2']);
  assert.deepEqual(r.snapshot.revision_reviews.map(x => x.revision_instructions), [['R-ESC'], ['R-ESC', 'R2']]);
  nextPacket(r); go(r, 'prepare'); go(r, 'start');
});
test('V113 cancellation then another ESC does not resurrect previously cancelled requirements', () => {
  const r = escalating(true); resolveChallenge(r); const first = contract.currentRevisionRequirement(r.snapshot);
  nextPacket(r, []); approved(r, { replaces_requirement_id: first.id }); go(r, 'prepare'); go(r, 'start'); go(r, 'submit');
  escalateReview(r, ['NEW'], 'ESC-2'); assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['NEW']);
});
test('V113 REVISE chain remains separate from additive ESC requirement references', () => {
  const r = escalating(); resolveChallenge(r); nextPacket(r); go(r, 'prepare'); go(r, 'start'); go(r, 'submit');
  r.review.verdict = 'REVISE'; r.review.review_id = 'REV-1'; r.review.revision_instructions = ['R2'];
  unchangedRejection(r, 'revise', /requirement/);
  r.review.supersedes_requirement_id = contract.currentRevisionRequirement(r.snapshot).id; go(r, 'revise');
  nextPacket(r); go(r, 'prepare'); go(r, 'start'); go(r, 'submit'); escalateReview(r, ['R3'], 'ESC-2'); resolveChallenge(r);
  nextPacket(r); go(r, 'prepare'); go(r, 'start'); go(r, 'submit');
  r.review.verdict = 'REVISE'; r.review.review_id = 'REV-2'; r.review.revision_instructions = ['R4'];
  r.review.supersedes_review_id = 'REV-1'; r.review.supersedes_requirement_id = contract.currentRevisionRequirement(r.snapshot).id;
  go(r, 'revise'); assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['R4']);
  nextPacket(r); go(r, 'prepare'); go(r, 'start');
});
test('V113 empty ESC does not cancel or change existing requirements', () => {
  const r = escalating(true); resolveChallenge(r); nextPacket(r); go(r, 'prepare'); go(r, 'start'); go(r, 'submit');
  const before = contract.currentRevisionRequirement(r.snapshot); escalateReview(r, [], 'ESC-empty');
  assert.deepEqual(contract.currentRevisionRequirement(r.snapshot), before);
});
for (const event of ['plan', 'discuss', 'prepare']) test('V113 legacy live ESC is read and retained before ' + event, () => {
  const r = escalating(true); r.snapshot.revision_reviews = []; // Actual V1.1.2 persisted shape.
  contract.validateSnapshot(r.snapshot); assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['R1', 'R-ESC']);
  resolveChallenge(r); if (event === 'prepare') nextPacket(r);
  go(r, event); assert.equal(r.snapshot.revision_reviews[0].review_id, 'ESC-1');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['R1', 'R-ESC']);
});
test('V113 inbound raw Review cannot forge inherited requirement context', () => {
  const r = setup(); for (const event of ['prepare', 'start', 'submit']) go(r, event);
  r.review.inherited_requirement = { id: 'plan:fake', source: 'plan', lifecycle: 1, instructions: [] };
  assert.throws(() => contract.validateReview(r.review, r.packet, r.result), /inherited_requirement/);
});
test('V113 inherited requirement cannot cross lifecycle in retained evidence', () => {
  const r = escalating(true); r.snapshot.revision_reviews[0].inherited_requirement.lifecycle++;
  assert.throws(() => contract.validateSnapshot(r.snapshot), /lifecycle/);
});
test('V113 migrated pending requirements remain protected through additive ESC until explicit REVISE', () => {
  const r = setup(), input = load('migration-request'); input.confirmation.pending_revision_instructions = ['M1'];
  r.snapshot = migrateSnapshot(input).snapshot; r.packet.lifecycle = r.snapshot.lifecycle; r.packet.revision_instructions = ['M1']; sync(r);
  approved(r, {}, true); for (const event of ['prepare', 'start', 'submit']) go(r, event);
  escalateReview(r, ['R-ESC']); resolveChallenge(r); assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['M1', 'R-ESC']);
  nextPacket(r, []); r.approval = approval(r, { replaces_requirement_id: contract.currentRevisionRequirement(r.snapshot).id });
  unchangedRejection(r, 'replan', /migration/); delete r.approval;
  r.packet.revision_instructions = ['M1', 'R-ESC']; approved(r, {}, true); go(r, 'prepare'); go(r, 'start'); go(r, 'submit');
  r.review.verdict = 'REVISE'; r.review.review_id = 'REV-M'; r.review.revision_instructions = ['R2'];
  r.review.supersedes_requirement_id = contract.currentRevisionRequirement(r.snapshot).id; go(r, 'revise');
  nextPacket(r); assert.equal(go(r, 'prepare').action, 'reauthorization_required'); approved(r, {}, true); go(r, 'prepare'); go(r, 'start');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['R2']);
});
for (const origin of ['REVISE', 'reauthorize']) test('V113 entry consistency: ESC accumulates ' + origin + ' requirements', () => {
  const r = setup();
  if (origin === 'reauthorize') {
    r.snapshot = migrateSnapshot(load('migration-request')).snapshot; r.packet.lifecycle = r.snapshot.lifecycle;
    r.packet.revision_instructions = ['R1']; sync(r); approved(r, {}, true);
  }
  for (const event of ['prepare', 'start', 'submit']) go(r, event);
  if (origin === 'REVISE') {
    r.review.verdict = 'REVISE'; r.review.review_id = 'REV-origin'; r.review.revision_instructions = ['R1'];
    go(r, 'revise'); nextPacket(r); for (const event of ['prepare', 'start', 'submit']) go(r, event);
  }
  escalateReview(r, ['R-ESC']); resolveChallenge(r);
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['R1', 'R-ESC']);
  nextPacket(r, ['R1']); unchangedRejection(r, 'prepare', /revision_instructions/);
  r.packet.revision_instructions = ['R1', 'R-ESC'];
  if (origin === 'reauthorize') approved(r, {}, true);
  go(r, 'prepare'); go(r, 'start'); assert.equal(contract.checkSideEffect(r.packet, r.snapshot, effect).allowed, true);
});
test('V113 legacy reused review_id cannot hide new ESC requirements and remains recoverable', () => {
  const r = setup(); for (const event of ['prepare', 'start', 'submit']) go(r, event);
  r.review.verdict = 'REVISE'; r.review.review_id = 'REUSED'; r.review.revision_instructions = ['R1']; go(r, 'revise');
  nextPacket(r); for (const event of ['prepare', 'start', 'submit']) go(r, event);
  escalateReview(r, ['R-ESC'], 'temporary-unique');
  r.snapshot.revision_reviews = r.snapshot.revision_reviews.filter(x => x.verdict === 'REVISE');
  r.snapshot.review_record.review_id = 'REUSED'; // Old runtime accepted this exact persisted shape.
  contract.validateSnapshot(r.snapshot); resolveChallenge(r);
  const before = structuredClone(r.snapshot), requirement = contract.currentRevisionRequirement(r.snapshot);
  const bad = structuredClone(r); nextPacket(bad, ['R1']); unchangedRejection(bad, 'prepare', /revision_instructions/);
  assert.deepEqual(r.snapshot, before);
  assert.deepEqual(requirement.instructions, ['R1', 'R-ESC']); assert.notEqual(requirement.id, 'review:REUSED');
  go(r, 'plan'); assert.equal(r.snapshot.revision_reviews.length, 2);
  assert.equal(r.snapshot.revision_reviews[1].review_id, 'REUSED', 'preserve raw legacy Review identity');
  assert.deepEqual(contract.currentRevisionRequirement(r.snapshot), requirement);
  nextPacket(r, []); approved(r, { replaces_requirement_id: requirement.id }); go(r, 'prepare'); go(r, 'start');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), []);
});
test('V113 old ESC reference cannot cancel a new lifecycle requirement even when review_id is reused', () => {
  const r = escalating(); resolveChallenge(r); const old = contract.currentRevisionRequirement(r.snapshot);
  nextPacket(r); go(r, 'prepare'); go(r, 'start'); finish(r); go(r, 'reopen'); go(r, 'plan');
  r.packet.lifecycle = r.snapshot.lifecycle; nextPacket(r, []);
  for (const event of ['prepare', 'start', 'submit']) go(r, event);
  escalateReview(r, ['NEW'], 'ESC-1'); resolveChallenge(r);
  const current = contract.currentRevisionRequirement(r.snapshot); nextPacket(r, []);
  r.approval = approval(r, { replaces_requirement_id: old.id });
  unchangedRejection(r, 'replan', /requirement/); delete r.approval;
  assert.notEqual(current.id, old.id);
  approved(r, { replaces_requirement_id: current.id }); go(r, 'prepare'); go(r, 'start');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), []);
});
test('V113 crafted REVISE review_id cannot alias an old ESC cancellation receipt', () => {
  const r = escalating(); resolveChallenge(r); const old = contract.currentRevisionRequirement(r.snapshot);
  nextPacket(r, []); approved(r, { replaces_requirement_id: old.id }); go(r, 'prepare'); go(r, 'start'); go(r, 'submit');
  r.review.verdict = 'REVISE'; r.review.review_id = old.id.startsWith('review:') ? old.id.slice('review:'.length) : old.id;
  r.review.revision_instructions = ['NEW-REVISE']; r.review.supersedes_review_id = null;
  r.review.supersedes_requirement_id = contract.currentRevisionRequirement(r.snapshot).id; go(r, 'revise');
  nextPacket(r); go(r, 'prepare'); go(r, 'start');
  assert.deepEqual(r.packet.revision_instructions, ['NEW-REVISE'], 'old cancellation must not silently cancel a newly issued Review');
  assert.deepEqual(contract.currentRevisionInstructions(r.snapshot), ['NEW-REVISE']);
});
