import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { recommendRouting } from '../scripts/adaptive-router.mjs';
import { CANDIDATE_RESOURCE_POLICY, resolveResourcePolicy, reasonableCapabilityRange,
  decideResourceRouting } from '../scripts/resource-policy.mjs';
import { transition } from '../scripts/router.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const baseProfile = { reasoning_complexity: 'LOW', context_load: 'LOW', ambiguity: 'LOW',
  failure_cost: 'LOW', verifiability: 'HIGH', change_surface: 'LOW', prior_evidence: 'HIGH' };
const recommend = (profile = baseProfile, frontier_evidence_refs = []) => recommendRouting({
  binding: { kind: 'draft', project_id: 'example', input_digest: hash('input') },
  basis: { scope_digest: hash('scope'), task_digest: hash('task'), runtime_capability_digest: null,
    registry_evidence_digest: null, policy_digest: null },
  profile, checkpoint: 'pre_execution', frontier_evidence_refs,
});
const layer = values => ({ contract: 'ResourcePolicyV1', version: 1, ...values });
const runtime = changes => ({ current_tier: 'FAST', current_reasoning: 'LOW',
  tier_availability: { FAST: 'available', BALANCED: 'available', STRONG: 'available', FRONTIER: 'unknown' },
  switch_supported: true, reasoning_adjustable: true, auto_route_authorized: true, ...changes });
const decide = ({ profile = baseProfile, evidence = [], policy = resolveResourcePolicy(),
  host = runtime(), frontier_approval = null } = {}) => decideResourceRouting({
  recommendation: recommend(profile, evidence), policy, runtime: host, frontier_approval,
});

test('A: project overrides only explicit fields and preserves false', () => {
  const user = layer({ resource_mode: 'quality_first', auto_escalate_model: true });
  const project = layer({ auto_escalate_model: false });
  const resolved = resolveResourcePolicy({ user_default: user, project_override: project });
  assert.equal(resolved.values.resource_mode, 'quality_first');
  assert.equal(resolved.values.auto_escalate_model, false);
  assert.equal(resolved.sources.resource_mode, 'user-default');
  assert.equal(resolved.sources.auto_escalate_model, 'project-override');
  assert.deepEqual(user, layer({ resource_mode: 'quality_first', auto_escalate_model: true }));
  assert.deepEqual(project, layer({ auto_escalate_model: false }));
});

test('A: malformed layers fail closed rather than falling back', () => {
  for (const bad of [layer({ auto_escalate_model: 'false' }), layer({ resource_mode: null }),
    layer({ auto_escalate_model: null }), layer({ reserve_frontier: 0 }),
    layer({ unknown: true }), { ...layer({}), version: 2 }, {}, []])
    assert.throws(() => resolveResourcePolicy({ project_override: bad }), /Contract violation/);
  assert.throws(() => resolveResourcePolicy({ baseline: layer({ resource_mode: 'balanced' }) }), /Contract violation/);
});

test('B/C: economy cannot undercut a STRONG reliability floor', () => {
  const profile = { ...baseProfile, reasoning_complexity: 'HIGH' };
  const recommendation = recommend(profile);
  assert.deepEqual(reasonableCapabilityRange(recommendation), { floor: 'STRONG', ceiling: 'STRONG' });
  const result = decide({ profile, policy: resolveResourcePolicy({ project_override: layer({ resource_mode: 'economy' }) }) });
  assert.equal(result.tier, 'STRONG');
  assert.equal(result.tier_action, 'RECOMMEND_ONLY');
});

test('B/C: quality_first stays inside the capability range and never manufactures FRONTIER', () => {
  const policy = resolveResourcePolicy({ project_override: layer({ resource_mode: 'quality_first' }) });
  assert.equal(decide({ policy }).tier, 'BALANCED');
  assert.equal(decide({ profile: { ...baseProfile, reasoning_complexity: 'MEDIUM' }, policy }).tier, 'STRONG');
  assert.equal(decide({ profile: { ...baseProfile, reasoning_complexity: 'HIGH' }, policy }).tier, 'STRONG');
  assert.equal(decide({ policy }).frontier.recommended, false);
});

test('D: candidate values are explicit and still require M7 validation', () => {
  assert.deepEqual(CANDIDATE_RESOURCE_POLICY, layer({ resource_mode: 'balanced', reserve_frontier: true,
    auto_escalate_reasoning: true, auto_escalate_model: false }));
  assert.deepEqual(resolveResourcePolicy().values, {
    resource_mode: 'balanced', reserve_frontier: true, auto_escalate_reasoning: true, auto_escalate_model: false,
  });
  assert.equal(Object.hasOwn(CANDIDATE_RESOURCE_POLICY, 'eval_proven'), false);
  const supplied = resolveResourcePolicy({ baseline: layer({ resource_mode: 'economy', reserve_frontier: false,
    auto_escalate_reasoning: false, auto_escalate_model: true }) });
  assert.equal(supplied.sources.resource_mode, 'baseline');
  assert.equal(supplied.values.reserve_frontier, false);
});

test('E: model auto escalation needs policy, authorization and actual runtime support', () => {
  const profile = { ...baseProfile, reasoning_complexity: 'MEDIUM' };
  assert.equal(decide({ profile }).tier_action, 'RECOMMEND_ONLY');
  const policy = resolveResourcePolicy({ project_override: layer({ auto_escalate_model: true }) });
  assert.equal(decide({ profile, policy }).tier_action, 'AUTO_ROUTE_ALLOWED');
  for (const host of [runtime({ auto_route_authorized: false }), runtime({ switch_supported: 'unknown' }),
    runtime({ tier_availability: { ...runtime().tier_availability, BALANCED: 'unknown' } })])
    assert.equal(decide({ profile, policy, host }).tier_action, 'RECOMMEND_ONLY');
});

test('F: FRONTIER recommendation, approval, availability, selection and use remain distinct', () => {
  const profile = { ...baseProfile, reasoning_complexity: 'HIGH', context_load: 'HIGH',
    ambiguity: 'HIGH', verifiability: 'LOW', change_surface: 'HIGH' };
  const recommendation = recommend(profile, ['reviewed-evidence']);
  const policy = resolveResourcePolicy({ project_override: layer({ auto_escalate_model: true,
    reserve_frontier: false, resource_mode: 'quality_first' }) });
  const input = { recommendation, policy, runtime: runtime({ tier_availability: { ...runtime().tier_availability, FRONTIER: 'available' } }) };
  const unapproved = decideResourceRouting(input);
  assert.deepEqual(unapproved.frontier, { recommended: true, approved: false, available: 'available',
    selected: 'unknown', actually_used: 'unknown', approval_required: true, reserved: false });
  assert.equal(unapproved.tier_action, 'RECOMMEND_ONLY');
  const approval = { recommendation_id: recommendation.recommendation_id, tier: 'FRONTIER',
    action: 'select_model', resource_limit: 'one task within approved budget', evidence_ref: 'trusted-user-approval' };
  const approved = decideResourceRouting({ ...input, frontier_approval: approval });
  assert.equal(approved.frontier.approved, true);
  assert.equal(approved.frontier.approval_required, false);
  assert.equal(approved.frontier.selected, 'unknown');
  assert.equal(approved.frontier.actually_used, 'unknown');
  assert.equal(approved.tier_action, 'RECOMMEND_ONLY');
  assert.throws(() => decideResourceRouting({ ...input, frontier_approval: { ...approval, recommendation_id: hash('old') } }), /binding/);
});

test('G/K: FRONTIER approval is not Packet authorization and does not alter seven stages or schema', () => {
  const request = JSON.parse(readFileSync(new URL('../examples/route-request.json', import.meta.url)));
  const before = structuredClone(request.packet);
  const profile = { ...baseProfile, reasoning_complexity: 'HIGH', context_load: 'HIGH',
    ambiguity: 'HIGH', verifiability: 'LOW', change_surface: 'HIGH' };
  const recommendation = recommend(profile, ['reviewed-evidence']);
  const approval = { recommendation_id: recommendation.recommendation_id, tier: 'FRONTIER',
    action: 'select_model', resource_limit: 'single task', evidence_ref: 'trusted-user-approval' };
  assert.equal(decideResourceRouting({ recommendation, policy: resolveResourcePolicy(), runtime: runtime(),
    frontier_approval: approval }).frontier.approved, true);
  assert.deepEqual(request.packet, before);
  request.packet.authorization.status = 'pending';
  assert.throws(() => transition(request), /authorization: execution not granted/);
  assert.equal(request.packet.schema_version, 2);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../contracts/routing.json', import.meta.url))).states,
    ['DISCUSS', 'PLAN', 'READY_TO_EXECUTE', 'EXECUTE', 'REVIEW', 'REVISE', 'COMPLETE']);
});

test('H: reasoning change obeys policy and observed host support', () => {
  const profile = { ...baseProfile, ambiguity: 'MEDIUM' };
  assert.equal(decide({ profile }).reasoning_action, 'AUTO_ADJUST_ALLOWED');
  assert.equal(decide({ profile, host: runtime({ reasoning_adjustable: 'unknown' }) }).reasoning_action, 'RECOMMEND_ONLY');
  assert.equal(decide({ profile, policy: resolveResourcePolicy({ project_override: layer({ auto_escalate_reasoning: false }) }) }).reasoning_action, 'RECOMMEND_ONLY');
});

test('I/J: usage is quiet and unknown is allowed without calls or synthetic values', () => {
  const result = decide({ host: runtime({ tier_availability: { ...runtime().tier_availability, FRONTIER: 'unknown' } }) });
  assert.deepEqual(result.overhead, { extra_model_call: false, dedicated_analysis: false });
  assert.doesNotMatch(JSON.stringify(result), /quota|usage|token|model_name|authorization/i);
  assert.equal(result.frontier.available, 'unknown');
  const first = recommend();
  const inherited = recommendRouting({ binding: first.binding, basis: first.basis, profile: first.profile,
    checkpoint: 'review', previous: first });
  assert.equal(first.routing_path, 'FAST_PATH');
  assert.equal(inherited.routing_path, 'INHERITED');
  assert.deepEqual(inherited.overhead, { extra_model_call: false, dedicated_analysis: false });
  assert.deepEqual(decideResourceRouting({ recommendation: inherited, policy: resolveResourcePolicy(), runtime: runtime() }).overhead,
    { extra_model_call: false, dedicated_analysis: false });
});

test('precedence: explicit task instruction outranks project and user settings', () => {
  const policy = resolveResourcePolicy({ user_default: layer({ resource_mode: 'economy' }),
    project_override: layer({ resource_mode: 'quality_first', auto_escalate_model: true }),
    task_instruction: layer({ resource_mode: 'balanced', auto_escalate_model: false }) });
  assert.equal(policy.values.resource_mode, 'balanced');
  assert.equal(policy.values.auto_escalate_model, false);
  assert.equal(policy.sources.resource_mode, 'task-instruction');
  assert.equal(decide({ profile: { ...baseProfile, reasoning_complexity: 'MEDIUM' }, policy }).tier_action, 'RECOMMEND_ONLY');
});
