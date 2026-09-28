// Capability recommendation only. The host supplies assessed facts; this module has no I/O or execution authority.
import { planDelivery } from './delivery-manifest.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveRegistryCandidates } from './model-capability-registry.mjs';

const levels = ['LOW', 'MEDIUM', 'HIGH'];
const tiers = ['FAST', 'BALANCED', 'STRONG', 'FRONTIER'];
const checkpoints = ['workshop', 'research_escalation', 'pre_execution', 'failure_reassessment', 'review', 'significant_replan'];
const profileFields = ['reasoning_complexity', 'context_load', 'ambiguity', 'failure_cost', 'verifiability', 'change_surface', 'prior_evidence'];
const basisFields = ['scope_digest', 'task_digest', 'runtime_capability_digest', 'registry_evidence_digest', 'policy_digest'];
const recordFields = ['contract', 'version', 'recommendation_id', 'revision', 'checkpoint', 'binding', 'basis', 'profile', 'capability_need', 'execution_risk', 'tier', 'reasoning', 'confidence', 'rationale', 'evidence_refs', 'reconsider_when', 'inherited', 'previous_recommendation_id', 'routing_path', 'overhead'];
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value !== null && typeof value === 'object' ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = field => { throw new Error(`Contract violation: ${field}`); };
const check = (condition, field) => { if (!condition) fail(field); };
const exact = (value, keys, field) => {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  check(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), `${field}: unexpected or missing field`);
};
const nonempty = (value, field) => check(typeof value === 'string' && value.trim().length > 0, field);
const sha = (value, field) => check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), field);
const choice = (value, values, field) => check(values.includes(value), field);
const same = (a, b, field) => check(isDeepStrictEqual(a, b), field);

function validateBinding(binding) {
  const draft = binding?.kind === 'draft';
  exact(binding, draft ? ['kind', 'project_id', 'input_digest'] :
    ['kind', 'project_id', 'task_id', 'packet_id', 'packet_revision', 'decision_version', 'executor', 'lifecycle', 'packet_sha256'], 'binding');
  choice(binding.kind, ['draft', 'packet'], 'binding.kind');
  nonempty(binding.project_id, 'binding.project_id');
  if (draft) sha(binding.input_digest, 'binding.input_digest');
  else {
    for (const key of ['task_id', 'packet_id']) nonempty(binding[key], `binding.${key}`);
    for (const key of ['packet_revision', 'decision_version', 'lifecycle'])
      check(Number.isSafeInteger(binding[key]) && binding[key] > 0, `binding.${key}`);
    choice(binding.executor, ['WORK', 'CODEX'], 'binding.executor');
    sha(binding.packet_sha256, 'binding.packet_sha256');
  }
}

function validateInputs({ binding, basis, profile, checkpoint, frontier_evidence_refs = [] }) {
  validateBinding(binding);
  exact(basis, basisFields, 'basis');
  for (const key of basisFields) {
    check(basis[key] === null || (typeof basis[key] === 'string' && /^[a-f0-9]{64}$/.test(basis[key])), `basis.${key}`);
    if (['scope_digest', 'task_digest'].includes(key)) sha(basis[key], `basis.${key}`);
  }
  exact(profile, profileFields, 'profile');
  for (const key of profileFields) choice(profile[key], levels, `profile.${key}`);
  choice(checkpoint, checkpoints, 'checkpoint');
  check(Array.isArray(frontier_evidence_refs) && frontier_evidence_refs.every(ref => typeof ref === 'string' && ref.trim()), 'frontier_evidence_refs');
}

function assess(profile, frontierEvidence) {
  const simple = profile.reasoning_complexity === 'LOW' && profile.context_load === 'LOW' &&
    profile.ambiguity === 'LOW' && profile.verifiability === 'HIGH' && profile.change_surface === 'LOW';
  const demanding = profile.reasoning_complexity === 'HIGH' ||
    (profile.context_load === 'HIGH' && profile.ambiguity === 'HIGH');
  const exceptional = demanding && profile.context_load === 'HIGH' && profile.ambiguity === 'HIGH' &&
    profile.verifiability === 'LOW' && profile.change_surface === 'HIGH' && frontierEvidence.length > 0;
  const tier = simple ? 'FAST' : exceptional ? 'FRONTIER' : demanding ? 'STRONG' : 'BALANCED';
  const reasoning = profile.reasoning_complexity === 'HIGH' || profile.ambiguity === 'HIGH' ? 'HIGH' :
    profile.reasoning_complexity === 'MEDIUM' || profile.ambiguity === 'MEDIUM' ? 'MEDIUM' : 'LOW';
  const executionRisk = profile.failure_cost === 'HIGH' ||
    (profile.failure_cost === 'MEDIUM' && profile.change_surface === 'HIGH') ? 'HIGH' :
    profile.failure_cost === 'MEDIUM' || profile.change_surface === 'HIGH' ? 'MEDIUM' : 'LOW';
  const confidence = exceptional || profile.ambiguity === 'HIGH' || profile.prior_evidence === 'LOW' ? 'LOW' :
    profile.ambiguity === 'MEDIUM' || profile.prior_evidence === 'MEDIUM' ? 'MEDIUM' : 'HIGH';
  const capabilityNeed = simple ? 'Clear, bounded and directly verifiable' : demanding ?
    'Substantial reasoning or conflicting context' : 'Routine professional judgment';
  const rationale = `${capabilityNeed}; execution risk ${executionRisk.toLowerCase()} is assessed separately.`;
  return { simple, tier, reasoning, executionRisk, confidence, capabilityNeed, rationale };
}

export function recommendRouting({ binding, basis, profile, checkpoint, previous = null, frontier_evidence_refs = [] }) {
  validateInputs({ binding, basis, profile, checkpoint, frontier_evidence_refs });
  if (previous !== null) validateRoutingRecommendation(previous, { allow_unresolved_inheritance: true });
  const inherited = previous !== null && isDeepStrictEqual(previous.binding, binding) &&
    isDeepStrictEqual(previous.basis, basis) && isDeepStrictEqual(previous.profile, profile) &&
    isDeepStrictEqual(previous.evidence_refs, frontier_evidence_refs);
  const assessment = inherited ? null : assess(profile, frontier_evidence_refs);
  const record = {
    contract: 'RoutingRecommendationV1', version: 1,
    recommendation_id: '',
    revision: 1, checkpoint, binding: structuredClone(binding), basis: structuredClone(basis),
    profile: structuredClone(profile),
    capability_need: inherited ? previous.capability_need : assessment.capabilityNeed,
    execution_risk: inherited ? previous.execution_risk : assessment.executionRisk,
    tier: inherited ? previous.tier : assessment.tier,
    reasoning: inherited ? previous.reasoning : assessment.reasoning,
    confidence: inherited ? previous.confidence : assessment.confidence,
    rationale: inherited ? previous.rationale : assessment.rationale,
    evidence_refs: [...frontier_evidence_refs],
    reconsider_when: inherited ? previous.reconsider_when :
      'Reassess when scope, task, runtime capability, policy, registry evidence, or profile changes.',
    inherited, previous_recommendation_id: inherited ? previous.recommendation_id : null,
    routing_path: inherited ? 'INHERITED' : assessment.simple ? 'FAST_PATH' : 'RULES',
    overhead: { extra_model_call: false, dedicated_analysis: false },
  };
  record.recommendation_id = digest({ ...record, recommendation_id: null });
  validateRoutingRecommendation(record, { binding, basis, previous: inherited ? previous : null });
  return record;
}

export function validateRoutingRecommendation(record, { binding, basis, previous = null, allow_unresolved_inheritance = false } = {}) {
  exact(record, recordFields, 'recommendation');
  check(record.contract === 'RoutingRecommendationV1' && record.version === 1, 'recommendation.version');
  nonempty(record.recommendation_id, 'recommendation.recommendation_id');
  same(record.recommendation_id, digest({ ...record, recommendation_id: null }), 'recommendation.recommendation_id: changed record');
  check(Number.isSafeInteger(record.revision) && record.revision > 0, 'recommendation.revision');
  validateInputs({ binding: record.binding, basis: record.basis, profile: record.profile,
    checkpoint: record.checkpoint, frontier_evidence_refs: record.evidence_refs });
  choice(record.tier, tiers, 'recommendation.tier');
  if (record.tier === 'FRONTIER') check(record.evidence_refs.length > 0, 'recommendation.FRONTIER evidence');
  choice(record.reasoning, levels, 'recommendation.reasoning');
  choice(record.confidence, levels, 'recommendation.confidence');
  choice(record.execution_risk, levels, 'recommendation.execution_risk');
  for (const key of ['capability_need', 'rationale', 'reconsider_when']) {
    nonempty(record[key], `recommendation.${key}`);
    check(record[key].length <= 280, `recommendation.${key}: too long`);
  }
  check(typeof record.inherited === 'boolean', 'recommendation.inherited');
  choice(record.routing_path, ['FAST_PATH', 'RULES', 'INHERITED'], 'recommendation.routing_path');
  if (record.routing_path === 'FAST_PATH')
    check(assess(record.profile, record.evidence_refs).simple && record.tier === 'FAST', 'recommendation.FAST_PATH');
  exact(record.overhead, ['extra_model_call', 'dedicated_analysis'], 'recommendation.overhead');
  same(record.overhead, { extra_model_call: false, dedicated_analysis: false }, 'recommendation.overhead');
  if (record.inherited) {
    check(record.routing_path === 'INHERITED' && (previous !== null || allow_unresolved_inheritance), 'recommendation.inheritance');
    nonempty(record.previous_recommendation_id, 'recommendation.previous_recommendation_id');
    if (previous !== null) {
      validateRoutingRecommendation(previous, { allow_unresolved_inheritance: true });
      same(record.previous_recommendation_id, previous.recommendation_id, 'recommendation.previous_recommendation_id');
      for (const key of ['binding', 'basis', 'profile', 'evidence_refs', 'capability_need', 'execution_risk', 'tier', 'reasoning', 'confidence', 'rationale', 'reconsider_when'])
        same(record[key], previous[key], `recommendation.inheritance.${key}`);
    }
  } else {
    check(record.previous_recommendation_id === null && record.routing_path !== 'INHERITED', 'recommendation.inheritance');
  }
  if (binding !== undefined) same(record.binding, binding, 'recommendation.binding: stale or cross-task');
  if (basis !== undefined) same(record.basis, basis, 'recommendation.basis: stale');
  return record;
}

export function compactRecommendation(record, options) {
  validateRoutingRecommendation(record, options);
  return { tier: record.tier, reasoning: record.reasoning, confidence: record.confidence,
    rationale: record.rationale };
}

// Candidate names stay outside RoutingRecommendationV1 and the schema-2 Packet.
export function resolveRoutingCandidates({ recommendation, registry, now, overlay = null, host_session = null,
  eval_scope = null }) {
  validateRoutingRecommendation(recommendation, { allow_unresolved_inheritance: true });
  if (recommendation.basis.registry_evidence_digest !== null)
    same(recommendation.basis.registry_evidence_digest, registry.digest, 'recommendation.basis.registry_evidence_digest');
  return resolveRegistryCandidates({ registry, tier: recommendation.tier, reasoning: recommendation.reasoning,
    now, overlay, host_session, eval_scope });
}

// Called only after the host has independently decided that more capability may be needed.
export function nextCapabilityStep({ tier, reasoning, reasoning_adjustable }) {
  choice(tier, tiers, 'tier'); choice(reasoning, levels, 'reasoning');
  check(typeof reasoning_adjustable === 'boolean', 'reasoning_adjustable');
  if (reasoning_adjustable && reasoning !== 'HIGH') return { tier, reasoning: levels[levels.indexOf(reasoning) + 1] };
  // FRONTIER needs an independently evidenced recommendation; this hint cannot manufacture it.
  if (tier === 'STRONG' || tier === 'FRONTIER') return null;
  return { tier: tiers[Math.min(tiers.indexOf(tier) + 1, tiers.length - 1)], reasoning };
}

// Ordinary recommendations never enter delivery planning; an explicitly expanded report still needs to be long.
export function prepareRoutingExplanation({ recommendation, extended = false, sections = [],
  artifact_id = `routing-${recommendation?.recommendation_id}`, artifact_revision = 1 }) {
  const compact = compactRecommendation(recommendation, { allow_unresolved_inheritance: true });
  if (typeof extended !== 'boolean') throw new Error('Contract violation: routing explanation.extended');
  if (!extended) return { recommendation: compact, delivery: { manifest: null, emissions: [] } };
  return { recommendation: compact, delivery: planDelivery({ artifact_id, artifact_revision,
    artifact_kind: 'router_explanation', sections }) };
}
