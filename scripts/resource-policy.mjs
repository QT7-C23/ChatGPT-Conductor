// Resource decisions are local recommendations. The host owns trusted approvals and runtime facts.
import { validateRoutingRecommendation } from './adaptive-router.mjs';

const fields = ['resource_mode', 'reserve_frontier', 'auto_escalate_reasoning', 'auto_escalate_model'];
const tiers = ['FAST', 'BALANCED', 'STRONG', 'FRONTIER'];
const levels = ['LOW', 'MEDIUM', 'HIGH'];
const availability = ['available', 'unavailable', 'unknown'];
const fail = field => { throw new Error(`Contract violation: ${field}`); };
const check = (condition, field) => { if (!condition) fail(field); };
const exact = (value, keys, field) => {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  check(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), `${field}: unexpected or missing field`);
};

// Candidate only: M7 Eval may change these values. This is not an evaluated optimum.
export const CANDIDATE_RESOURCE_POLICY = Object.freeze({
  contract: 'ResourcePolicyV1', version: 1, resource_mode: 'balanced',
  reserve_frontier: true, auto_escalate_reasoning: true, auto_escalate_model: false,
});

function validateLayer(value, name, complete = false) {
  const present = fields.filter(key => Object.hasOwn(value ?? {}, key));
  exact(value, ['contract', 'version', ...(complete ? fields : present)], name);
  check(value.contract === 'ResourcePolicyV1' && value.version === 1, `${name}.version`);
  for (const key of present) check(key === 'resource_mode' ?
    ['economy', 'balanced', 'quality_first'].includes(value[key]) : typeof value[key] === 'boolean', `${name}.${key}`);
  return present;
}

export function resolveResourcePolicy({ baseline = CANDIDATE_RESOURCE_POLICY, user_default = null,
  project_override = null, task_instruction = null } = {}) {
  const values = {}, sources = {};
  const baselineSource = baseline === CANDIDATE_RESOURCE_POLICY ? 'candidate-default' : 'baseline';
  for (const [name, layer] of [[baselineSource, baseline], ['user-default', user_default],
    ['project-override', project_override], ['task-instruction', task_instruction]]) {
    if (layer === null && name !== baselineSource) continue;
    for (const key of validateLayer(layer, name, name === baselineSource)) {
      values[key] = layer[key];
      sources[key] = name;
    }
  }
  return { contract: 'ResolvedResourcePolicyV1', version: 1, values, sources };
}

function validateResolved(policy) {
  exact(policy, ['contract', 'version', 'values', 'sources'], 'policy');
  check(policy.contract === 'ResolvedResourcePolicyV1' && policy.version === 1, 'policy.version');
  exact(policy.values, fields, 'policy.values');
  exact(policy.sources, fields, 'policy.sources');
  validateLayer({ contract: 'ResourcePolicyV1', version: 1, ...policy.values }, 'policy.values', true);
  for (const key of fields) check(['candidate-default', 'baseline', 'user-default', 'project-override', 'task-instruction'].includes(policy.sources[key]), `policy.sources.${key}`);
}

function validateRuntime(runtime) {
  exact(runtime, ['current_tier', 'current_reasoning', 'tier_availability', 'switch_supported',
    'reasoning_adjustable', 'auto_route_authorized'], 'runtime');
  check(tiers.includes(runtime.current_tier), 'runtime.current_tier');
  check(levels.includes(runtime.current_reasoning), 'runtime.current_reasoning');
  exact(runtime.tier_availability, tiers, 'runtime.tier_availability');
  for (const tier of tiers) check(availability.includes(runtime.tier_availability[tier]), `runtime.tier_availability.${tier}`);
  for (const key of ['switch_supported', 'reasoning_adjustable'])
    check([true, false, 'unknown'].includes(runtime[key]), `runtime.${key}`);
  check(typeof runtime.auto_route_authorized === 'boolean', 'runtime.auto_route_authorized');
}

function validateApproval(approval, recommendation) {
  if (approval === null) return false;
  exact(approval, ['recommendation_id', 'tier', 'action', 'resource_limit', 'evidence_ref'], 'frontier_approval');
  check(approval.recommendation_id === recommendation.recommendation_id && approval.tier === 'FRONTIER' &&
    approval.action === 'select_model', 'frontier_approval.binding');
  for (const key of ['resource_limit', 'evidence_ref'])
    check(typeof approval[key] === 'string' && approval[key].trim().length > 0, `frontier_approval.${key}`);
  return true;
}

// The M3 capability assessment sets a reliability floor. Modes can move only inside this interval.
export function reasonableCapabilityRange(recommendation) {
  validateRoutingRecommendation(recommendation, { allow_unresolved_inheritance: true });
  const floor = recommendation.tier;
  const ceiling = floor === 'FAST' ? 'BALANCED' : floor === 'BALANCED' ? 'STRONG' : floor;
  return { floor, ceiling };
}

export function decideResourceRouting({ recommendation, policy, runtime, frontier_approval = null }) {
  validateRoutingRecommendation(recommendation, { allow_unresolved_inheritance: true });
  validateResolved(policy);
  validateRuntime(runtime);
  const approved = validateApproval(frontier_approval, recommendation);
  check(!approved || recommendation.tier === 'FRONTIER', 'frontier_approval: no FRONTIER recommendation');
  const range = reasonableCapabilityRange(recommendation);
  const tier = policy.values.resource_mode === 'quality_first' ? range.ceiling : range.floor;
  const available = runtime.tier_availability[tier];
  const increasing = tiers.indexOf(tier) > tiers.indexOf(runtime.current_tier);
  const tier_action = tier === runtime.current_tier ? 'NO_CHANGE' :
    tier !== 'FRONTIER' && increasing && policy.values.auto_escalate_model &&
    runtime.auto_route_authorized && runtime.switch_supported === true && available === 'available' ?
      'AUTO_ROUTE_ALLOWED' : 'RECOMMEND_ONLY';
  const reasoning_action = recommendation.reasoning === runtime.current_reasoning ? 'NO_CHANGE' :
    levels.indexOf(recommendation.reasoning) > levels.indexOf(runtime.current_reasoning) &&
    policy.values.auto_escalate_reasoning && runtime.reasoning_adjustable === true ?
      'AUTO_ADJUST_ALLOWED' : 'RECOMMEND_ONLY';
  return {
    contract: 'ResourceDecisionV1', version: 1, recommendation_id: recommendation.recommendation_id,
    range, tier, reasoning: recommendation.reasoning, tier_action, reasoning_action,
    frontier: {
      recommended: recommendation.tier === 'FRONTIER', approved,
      available: runtime.tier_availability.FRONTIER, selected: 'unknown', actually_used: 'unknown',
      approval_required: recommendation.tier === 'FRONTIER' && !approved,
      reserved: policy.values.reserve_frontier,
    },
    overhead: { extra_model_call: false, dedicated_analysis: false },
  };
}
