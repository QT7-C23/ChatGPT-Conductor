import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseWorkshop, advanceDiscovery, createProductBrief } from '../scripts/workshop.mjs';
import { validateSnapshot, validateExecution } from '../scripts/contracts.mjs';
import { transition } from '../scripts/router.mjs';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const sections = {
  problem: '新用户不知道如何开始。', usersScenario: '首次进入应用的团队负责人。',
  desiredOutcome: '能在首次会话中建立项目。', scopeIn: '引导创建首个项目。',
  scopeOut: '不重做账户系统。', evidence: 'USER_PROVIDED: 用户反馈；尚未独立核实。',
  proposedApproach: '提供短引导，并建议先测量完成率。', alternatives: '空白页；逐步引导。',
  openQuestions: '视觉细节可在实施中确定。', successCriteria: '测试用户可完成首个项目。',
  deliveryDepth: '一页 Brief，进入 PLAN 后再定实施范围。',
};

test('ambiguous product request enters AUTO Workshop', () => {
  assert.equal(chooseWorkshop().enter, true);
  assert.deepEqual(chooseWorkshop({ goalKnown: false, scopeKnown: false, productChoiceOpen: true }),
    { enter: true, depth: 'standard', reason: 'decision_gap' });
});
test('defined small task stays on fast path even if a minor detail is unknown', () => {
  assert.deepEqual(chooseWorkshop({ smallTask: true, outcomeKnown: false }),
    { enter: false, depth: 'none', reason: 'defined_small_task' });
});
test('FORCE enters Workshop while keeping a small task light', () => {
  assert.equal(chooseWorkshop({ mode: 'FORCE', smallTask: true }).depth, 'light');
});
test('BYPASS skips discovery regardless of ambiguity', () => {
  assert.equal(chooseWorkshop({ mode: 'BYPASS', goalKnown: false }).enter, false);
});
test('BYPASS still cannot prepare an execution packet without authorization', () => {
  assert.equal(chooseWorkshop({ mode: 'BYPASS' }).enter, false);
  const request = read('../examples/route-request.json');
  request.packet.authorization.status = 'pending';
  assert.throws(() => transition(request), /authorization: execution not granted/);
});
test('answered unknown is never asked again, and only highest-impact blocking question is asked', () => {
  const result = advanceDiscovery({ unknowns: [
    { id: 'answered', question: '谁使用？', blocking: true, impact: 5, answer: '团队负责人' },
    { id: 'low', question: '颜色？', blocking: false, impact: 4 },
    { id: 'important', question: '首个目标是什么？', blocking: true, impact: 3 },
    { id: 'less', question: '在哪些设备？', blocking: true, impact: 1 },
  ] });
  assert.deepEqual(result, { readiness: 'needs_answer',
    next: { id: 'important', question: '首个目标是什么？' }, nonBlocking: ['low'] });
});
test('non-blocking unknown does not delay readiness', () => {
  assert.deepEqual(advanceDiscovery({ unknowns: [{ id: 'visual', question: '颜色？', blocking: false }] }),
    { readiness: 'ready', next: null, nonBlocking: ['visual'] });
});
test('user uncertainty gets explanation and recommendation without auto-deciding', () => {
  const result = advanceDiscovery({ unknowns: [{ id: 'flow', question: '如何引导？', blocking: true,
    userUnsure: true, explanation: '逐步引导更易上手但步骤多。',
    alternatives: ['空白页', '逐步引导'], recommendation: '先试逐步引导' }] });
  assert.equal(result.readiness, 'needs_decision');
  assert.equal(result.next.recommendation, '先试逐步引导');
});
test('executor-owned technical choice is proposed and resolved in scope without asking the user', () => {
  const unknown = { id: 'storage', question: '如何缓存？', blocking: true, owner: 'EXECUTOR',
    withinScope: true, userUnsure: true, recommendation: '沿用现有缓存', explanation: '减少变更' };
  assert.equal(advanceDiscovery({ unknowns: [unknown] }).readiness, 'needs_technical_choice');
  assert.deepEqual(advanceDiscovery({ unknowns: [{ ...unknown, answer: '沿用现有缓存' }] }),
    { readiness: 'ready', next: null, nonBlocking: [] });
});
test('research is requested only for a decision-critical external fact', () => {
  const need = { id: 'rule', question: '是否有法定要求？', blocking: true,
    decisionImpact: true, externalFactNeeded: '核对现行官方规则' };
  assert.equal(advanceDiscovery({ unknowns: [need] }).readiness, 'needs_research');
  assert.equal(advanceDiscovery({ unknowns: [{ ...need, decisionImpact: false }] }).readiness, 'needs_answer');
  assert.equal(advanceDiscovery({ unknowns: [need], evidence: [{ supports: 'rule',
    classification: 'USER_PROVIDED', source: '聊天' }] }).readiness, 'needs_research');
  assert.equal(advanceDiscovery({ unknowns: [need], evidence: [{ supports: 'rule',
    classification: 'VERIFIED_OFFICIAL', source: '官方文件' }] }).readiness, 'needs_answer');
  assert.throws(() => advanceDiscovery({ evidence: [{ classification: 'APPROVED' }] }), /classification/);
});
test('readiness proactively yields a one-page default Brief, without mandatory PRD', () => {
  const discovery = advanceDiscovery({ unknowns: [{ id: 'visual', blocking: false }] });
  const brief = createProductBrief({ sections, discovery, deliveryComplete: true });
  assert.equal(brief.status, 'ready');
  for (const title of ['Problem', 'Users / Scenario', 'Desired Outcome', 'Scope In', 'Scope Out',
    'Evidence', 'Proposed Approach', 'Alternatives', 'Key Decisions', 'Open Questions',
    'Success Criteria', 'Delivery Depth']) assert.ok(brief.markdown.includes(`## ${title}`));
  assert.doesNotMatch(brief.markdown, /## PRD/);
});
test('recommendation never becomes confirmed decision or authorization', () => {
  const brief = createProductBrief({ sections: { ...sections, keyDecisions: 'Approve deployment' },
    discovery: { readiness: 'ready' }, deliveryComplete: true });
  assert.match(brief.markdown, /No confirmed decisions recorded/);
  assert.doesNotMatch(brief.markdown, /Approve deployment/);
  assert.throws(() => createProductBrief({ sections, discovery: { readiness: 'ready' },
    confirmedDecisions: [{ text: 'Deploy' }] }), /trusted approval/);
});
test('incomplete transfer and unresolved blocking question keep Brief draft; superseded is explicit', () => {
  assert.equal(createProductBrief({ sections, discovery: { readiness: 'ready' }, deliveryComplete: false }).status, 'draft');
  assert.equal(createProductBrief({ sections, discovery: { readiness: 'ready' } }).status, 'draft');
  assert.equal(createProductBrief({ sections, discovery: { readiness: 'needs_answer' } }).status, 'draft');
  assert.equal(createProductBrief({ sections, discovery: { readiness: 'ready' }, superseded: true }).status, 'superseded');
});
test('legacy schema-2 state and execution packet need no Workshop fields', () => {
  const state = read('../examples/project-state.json');
  const packet = read('../examples/execution-packet.json');
  assert.doesNotThrow(() => validateSnapshot(state));
  assert.doesNotThrow(() => validateExecution(packet, state));
  assert.equal(Object.hasOwn(state, 'product_brief'), false);
});
