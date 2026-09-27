// Failure evidence is supplied by the host or Review. This module only classifies it locally.
import { nextCapabilityStep } from './adaptive-router.mjs';

export const FAILURE_CATEGORIES = Object.freeze([
  'CAPABILITY_LIMIT', 'SPEC_AMBIGUITY', 'MISSING_CONTEXT',
  'TOOL_OR_ENVIRONMENT', 'TEST_OR_SPEC_CONFLICT', 'UNKNOWN',
]);

const signals = Object.freeze({
  REPEATED_CONSTRAINT_FAILURE: 'CAPABILITY_LIMIT',
  SPEC_UNCLEAR: 'SPEC_AMBIGUITY',
  CONTEXT_MISSING: 'MISSING_CONTEXT',
  TOOL_FAILURE: 'TOOL_OR_ENVIRONMENT',
  ENVIRONMENT_FAILURE: 'TOOL_OR_ENVIRONMENT',
  PERMISSION_DENIED: 'TOOL_OR_ENVIRONMENT',
  TEST_SPEC_CONFLICT: 'TEST_OR_SPEC_CONFLICT',
});
const checks = ['SPEC_CLEAR', 'ENVIRONMENT_HEALTHY'];
const actions = Object.freeze({
  CAPABILITY_LIMIT: 'REASSESS_REASONING_FIRST',
  SPEC_AMBIGUITY: 'RETURN_WORKSHOP_PLAN',
  MISSING_CONTEXT: 'SUPPLY_CONTEXT',
  TOOL_OR_ENVIRONMENT: 'RECOVER_ENVIRONMENT_PREFLIGHT',
  TEST_OR_SPEC_CONFLICT: 'RETURN_PLAN_CHALLENGE',
  UNKNOWN: 'DIAGNOSE',
});
const fields = ['contract', 'version', 'category', 'evidence', 'evidence_refs', 'confidence',
  'recommended_action', 'routing_reassessment_required', 'alternative_explanations'];
const fail = field => { throw new Error(`Contract violation: ${field}`); };
const check = (condition, field) => { if (!condition) fail(field); };
const exact = (value, keys, field) => {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  check(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), `${field}: unexpected or missing field`);
};
const refs = (value, field) => check(Array.isArray(value) && value.length <= 12 &&
  value.every(ref => typeof ref === 'string' && ref.trim().length > 0 && ref.length <= 160) &&
  new Set(value).size === value.length, field);

function validateEvidence(evidence) {
  check(Array.isArray(evidence) && evidence.length <= 12, 'evidence');
  const seen = new Set();
  for (const item of evidence) {
    exact(item, ['ref', 'signal'], 'evidence.item');
    refs([item.ref], 'evidence.ref');
    check(Object.hasOwn(signals, item.signal) || checks.includes(item.signal), 'evidence.signal');
    check(!seen.has(item.ref), 'evidence.ref: duplicate');
    seen.add(item.ref);
  }
}

function classify(evidence) {
  const categories = new Set(evidence.map(item => signals[item.signal]).filter(Boolean));
  const has = signal => evidence.some(item => item.signal === signal);
  const capabilityReady = has('REPEATED_CONSTRAINT_FAILURE') && has('SPEC_CLEAR') && has('ENVIRONMENT_HEALTHY');
  if (categories.has('CAPABILITY_LIMIT') && !capabilityReady) categories.delete('CAPABILITY_LIMIT');
  const category = categories.size === 1 ? [...categories][0] : 'UNKNOWN';
  const supporting = category === 'UNKNOWN' ? evidence : evidence.filter(item => signals[item.signal] === category ||
    (category === 'CAPABILITY_LIMIT' && checks.includes(item.signal)));
  return { category, supporting, alternatives: categories.size > 1 ? [...categories].sort() : [] };
}

// Each signal is a host-assessed fact with a real, locatable reference. No log text is guessed here.
export function attributeFailure({ evidence = [], result_status = null, review_verdict = null } = {}) {
  check(['succeeded', 'partial', 'blocked', null].includes(result_status), 'result_status');
  check(['ACCEPT', 'REVISE', 'ESCALATE', null].includes(review_verdict), 'review_verdict');
  validateEvidence(evidence);
  const { category, supporting, alternatives } = classify(evidence);
  const attribution = {
    contract: 'FailureAttributionV1', version: 1, category, evidence: structuredClone(evidence),
    evidence_refs: supporting.map(item => item.ref),
    confidence: category === 'UNKNOWN' ? 'LOW' : category === 'CAPABILITY_LIMIT' ? 'MEDIUM' :
      supporting.length > 1 ? 'HIGH' : 'MEDIUM',
    recommended_action: actions[category],
    routing_reassessment_required: category === 'CAPABILITY_LIMIT',
    alternative_explanations: alternatives,
  };
  validateFailureAttribution(attribution);
  return attribution;
}

export function validateFailureAttribution(attribution) {
  exact(attribution, fields, 'attribution');
  check(attribution.contract === 'FailureAttributionV1' && attribution.version === 1, 'attribution.version');
  validateEvidence(attribution.evidence);
  check(FAILURE_CATEGORIES.includes(attribution.category), 'attribution.category');
  refs(attribution.evidence_refs, 'attribution.evidence_refs');
  check(['LOW', 'MEDIUM', 'HIGH'].includes(attribution.confidence), 'attribution.confidence');
  check(attribution.recommended_action === actions[attribution.category], 'attribution.recommended_action');
  check(attribution.routing_reassessment_required === (attribution.category === 'CAPABILITY_LIMIT'),
    'attribution.routing_reassessment_required');
  check(Array.isArray(attribution.alternative_explanations) &&
    attribution.alternative_explanations.every(value => FAILURE_CATEGORIES.includes(value) && value !== 'UNKNOWN'),
  'attribution.alternative_explanations');
  const expected = classify(attribution.evidence);
  check(attribution.category === expected.category, 'attribution.category: unsupported by evidence');
  check(JSON.stringify(attribution.evidence_refs) === JSON.stringify(expected.supporting.map(item => item.ref)),
    'attribution.evidence_refs: unsupported');
  check(JSON.stringify(attribution.alternative_explanations) === JSON.stringify(expected.alternatives),
    'attribution.alternative_explanations: unsupported');
  return attribution;
}

// A checkpoint hint, never a routing recommendation, policy decision, or model switch.
export function failureReassessmentHint({ attribution, tier, reasoning, reasoning_adjustable }) {
  validateFailureAttribution(attribution);
  if (!attribution.routing_reassessment_required) return null;
  return {
    checkpoint: 'failure_reassessment', evidence_refs: [...attribution.evidence_refs],
    next_capability: nextCapabilityStep({ tier, reasoning, reasoning_adjustable }),
  };
}
