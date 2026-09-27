import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FAILURE_CATEGORIES, attributeFailure, validateFailureAttribution,
  failureReassessmentHint } from '../scripts/failure-attribution.mjs';
import { recommendRouting } from '../scripts/adaptive-router.mjs';
import { resolveResourcePolicy, decideResourceRouting } from '../scripts/resource-policy.mjs';
import { validateExecution, validateResult } from '../scripts/contracts.mjs';
import { transition } from '../scripts/router.mjs';

const fact = (signal, ref = `case/${signal}`) => ({ signal, ref });
const capability = () => [fact('REPEATED_CONSTRAINT_FAILURE', 'review/repeated-constraints'),
  fact('SPEC_CLEAR', 'spec/approved-criteria'), fact('ENVIRONMENT_HEALTHY', 'preflight/healthy')];
const attribution = evidence => attributeFailure({ evidence, result_status: 'partial', review_verdict: 'REVISE' });
const hash = value => createHash('sha256').update(value).digest('hex');
const routing = (profile, evidence = []) => recommendRouting({
  binding: { kind: 'draft', project_id: 'example', input_digest: hash('draft') },
  basis: { scope_digest: hash('scope'), task_digest: hash('task'), runtime_capability_digest: null,
    registry_evidence_digest: null, policy_digest: null },
  profile, checkpoint: 'failure_reassessment', frontier_evidence_refs: evidence,
});
const profile = { reasoning_complexity: 'HIGH', context_load: 'LOW', ambiguity: 'LOW',
  failure_cost: 'LOW', verifiability: 'HIGH', change_surface: 'LOW', prior_evidence: 'HIGH' };
const runtime = { current_tier: 'BALANCED', current_reasoning: 'LOW',
  tier_availability: { FAST: 'available', BALANCED: 'available', STRONG: 'available', FRONTIER: 'available' },
  switch_supported: true, reasoning_adjustable: true, auto_route_authorized: true };

test('A: six categories have fixed actions and light structure', () => {
  assert.deepEqual(FAILURE_CATEGORIES, ['CAPABILITY_LIMIT', 'SPEC_AMBIGUITY', 'MISSING_CONTEXT',
    'TOOL_OR_ENVIRONMENT', 'TEST_OR_SPEC_CONFLICT', 'UNKNOWN']);
  const cases = [
    [capability(), 'CAPABILITY_LIMIT', 'REASSESS_REASONING_FIRST'],
    [[fact('SPEC_UNCLEAR')], 'SPEC_AMBIGUITY', 'RETURN_WORKSHOP_PLAN'],
    [[fact('CONTEXT_MISSING')], 'MISSING_CONTEXT', 'SUPPLY_CONTEXT'],
    [[fact('ENVIRONMENT_FAILURE')], 'TOOL_OR_ENVIRONMENT', 'RECOVER_ENVIRONMENT_PREFLIGHT'],
    [[fact('TEST_SPEC_CONFLICT')], 'TEST_OR_SPEC_CONFLICT', 'RETURN_PLAN_CHALLENGE'],
    [[], 'UNKNOWN', 'DIAGNOSE'],
  ];
  for (const [evidence, category, action] of cases) {
    const result = attribution(evidence);
    assert.equal(result.category, category);
    assert.equal(result.recommended_action, action);
    assert.deepEqual(result.evidence_refs, evidence.map(item => item.ref));
    assert.deepEqual(validateFailureAttribution(result), result);
    assert.equal(result.routing_reassessment_required, category === 'CAPABILITY_LIMIT');
  }
});

test('B: verified capability failure opens only a reasoning-first candidate checkpoint', () => {
  const result = attribution(capability());
  assert.equal(result.confidence, 'MEDIUM');
  assert.deepEqual(failureReassessmentHint({ attribution: result, tier: 'BALANCED', reasoning: 'LOW',
    reasoning_adjustable: true }), {
    checkpoint: 'failure_reassessment', evidence_refs: result.evidence_refs,
    next_capability: { tier: 'BALANCED', reasoning: 'MEDIUM' },
  });
  assert.equal(failureReassessmentHint({ attribution: result, tier: 'STRONG', reasoning: 'HIGH',
    reasoning_adjustable: true }).next_capability, null);
});

test('C/D: unclear spec returns Workshop/PLAN; missing context requests input, neither reassesses routing', () => {
  for (const [signal, action] of [['SPEC_UNCLEAR', 'RETURN_WORKSHOP_PLAN'],
    ['CONTEXT_MISSING', 'SUPPLY_CONTEXT']]) {
    const result = attribution([fact(signal)]);
    assert.equal(result.recommended_action, action);
    assert.equal(failureReassessmentHint({ attribution: result, tier: 'FAST', reasoning: 'LOW',
      reasoning_adjustable: true }), null);
  }
});

test('E: npm launcher, network 443, permission and missing local file use assessed environment signals', () => {
  for (const [signal, ref] of [['TOOL_FAILURE', 'npm/launcher-path'],
    ['ENVIRONMENT_FAILURE', 'network/connect-443'], ['PERMISSION_DENIED', 'filesystem/denied'],
    ['CONTEXT_MISSING', 'inputs/missing-supplied-file']]) {
    const result = attribution([fact(signal, ref)]);
    assert.equal(result.category, signal === 'CONTEXT_MISSING' ? 'MISSING_CONTEXT' : 'TOOL_OR_ENVIRONMENT');
    assert.equal(result.routing_reassessment_required, false);
    assert.equal(result.evidence_refs[0], ref);
  }
});

test('F: approved spec versus test conflict returns PLAN/Challenge without capability evidence', () => {
  const result = attribution([fact('TEST_SPEC_CONFLICT', 'review/test-vs-approved-spec')]);
  assert.equal(result.category, 'TEST_OR_SPEC_CONFLICT');
  assert.equal(result.recommended_action, 'RETURN_PLAN_CHALLENGE');
  assert.equal(result.routing_reassessment_required, false);
});

test('G/H/J: absent or conflicting evidence and REVISE alone remain UNKNOWN', () => {
  for (const result of [attributeFailure(), attributeFailure({ review_verdict: 'REVISE' }),
    attribution([fact('REPEATED_CONSTRAINT_FAILURE')]),
    attribution([fact('REPEATED_CONSTRAINT_FAILURE'), fact('SPEC_UNCLEAR'),
      fact('SPEC_CLEAR'), fact('ENVIRONMENT_HEALTHY')])]) {
    assert.equal(result.category, 'UNKNOWN');
    assert.equal(result.confidence, 'LOW');
    assert.equal(result.recommended_action, 'DIAGNOSE');
    assert.equal(result.routing_reassessment_required, false);
    assert.equal(failureReassessmentHint({ attribution: result, tier: 'STRONG', reasoning: 'HIGH',
      reasoning_adjustable: true }), null);
  }
});

test('I: capability evidence cannot bypass auto escalation policy or FRONTIER approval', () => {
  const result = attribution(capability());
  const policy = resolveResourcePolicy();
  const recommendation = routing(profile);
  assert.ok(failureReassessmentHint({ attribution: result, tier: 'BALANCED', reasoning: 'HIGH',
    reasoning_adjustable: true }));
  const decision = decideResourceRouting({ recommendation, policy, runtime });
  assert.equal(decision.tier, 'STRONG');
  assert.equal(decision.tier_action, 'RECOMMEND_ONLY');
  const noReasoning = resolveResourcePolicy({ task_instruction: { contract: 'ResourcePolicyV1', version: 1,
    auto_escalate_reasoning: false } });
  assert.equal(decideResourceRouting({ recommendation, policy: noReasoning, runtime }).reasoning_action, 'RECOMMEND_ONLY');
  const frontierProfile = { ...profile, context_load: 'HIGH', ambiguity: 'HIGH',
    verifiability: 'LOW', change_surface: 'HIGH' };
  const frontier = decideResourceRouting({ recommendation: routing(frontierProfile, result.evidence_refs),
    policy, runtime });
  assert.equal(frontier.frontier.recommended, true);
  assert.equal(frontier.frontier.approved, false);
  assert.equal(frontier.frontier.approval_required, true);
  assert.equal(frontier.tier_action, 'RECOMMEND_ONLY');
  assert.equal(frontier.frontier.selected, 'unknown');
  assert.equal(frontier.frontier.actually_used, 'unknown');
});

test('J: malformed categories, unsupported capability, and authority or usage claims are rejected', () => {
  const result = attribution(capability());
  for (const patch of [{ category: 'OTHER' }, { category: 'SPEC_AMBIGUITY' },
    { routing_reassessment_required: false }, { recommended_action: 'ACCEPT' },
    { evidence_refs: ['fabricated'] }, { authorization: 'granted' },
    { usage: { tokens: 1 } }, { chain_of_thought: 'private' }])
    assert.throws(() => validateFailureAttribution({ ...result, ...patch }), /Contract violation/);
  assert.throws(() => attributeFailure({ evidence: [{ ref: 'x', signal: 'FRONTIER_APPROVED' }] }), /Contract violation/);
  assert.doesNotMatch(JSON.stringify(result), /authorization|usage|chain_of_thought|selected|actually_used/);
});

test('K/L: old schema 2 Result stays valid; seven states and Packet authorization are unchanged', () => {
  const request = JSON.parse(readFileSync(new URL('../examples/route-request.json', import.meta.url)));
  const result = JSON.parse(readFileSync(new URL('../examples/result-packet.json', import.meta.url)));
  validateExecution(request.packet, request.snapshot);
  validateResult(result, request.packet);
  assert.equal(Object.hasOwn(result, 'failure_attribution'), false);
  assert.equal(result.schema_version, 2);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../contracts/routing.json', import.meta.url))).states,
    ['DISCUSS', 'PLAN', 'READY_TO_EXECUTE', 'EXECUTE', 'REVIEW', 'REVISE', 'COMPLETE']);
  request.packet.authorization.status = 'pending';
  assert.throws(() => transition(request), /authorization: execution not granted/);
  const recommendation = routing(profile);
  const decision = decideResourceRouting({ recommendation, policy: resolveResourcePolicy(), runtime });
  assert.deepEqual(recommendation.overhead, { extra_model_call: false, dedicated_analysis: false });
  assert.deepEqual(decision.overhead, { extra_model_call: false, dedicated_analysis: false });
});
