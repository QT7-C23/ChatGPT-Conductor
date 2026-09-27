// Offline routing evaluation. Callers own evidence collection, model execution and retention.
import { validateRoutingRecommendation, nextCapabilityStep } from './adaptive-router.mjs';
import { validateFailureAttribution } from './failure-attribution.mjs';

const tiers = ['FAST', 'BALANCED', 'STRONG', 'FRONTIER'];
const reasoning = ['LOW', 'MEDIUM', 'HIGH'];
const overheads = ['no_extra_model_call', 'piggyback', 'dedicated_analysis', 'unknown'];
const outcomes = ['underroute', 'overroute', 'insufficient_evidence'];
const check = (value, field) => { if (!value) throw new Error(`Contract violation: ${field}`); };
const ref = (value, field) => check(typeof value === 'string' && value.trim().length > 0, field);
const count = (value, field) => check(Number.isSafeInteger(value) && value >= 0, field);
const choice = (value, values, field) => check(values.includes(value), field);
const object = (value, field) => check(value !== null && typeof value === 'object' && !Array.isArray(value), field);
const exact = (value, keys, field) => {
  object(value, field);
  check(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), field);
};
const optionalCount = (value, field) => { if (value !== null) count(value, field); };
const tri = (value, field) => choice(value, [true, false, 'unknown'], field);
const timestamp = (value, field) => check(typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, field);
const sameTask = (source, binding, field) => {
  if (source === null) return;
  object(source, field);
  if (binding.kind === 'packet') {
    for (const key of ['project_id', 'task_id', 'packet_id', 'packet_revision', 'decision_version', 'lifecycle'])
      check(source[key] === binding[key], `${field}.${key}`);
  }
};

export function validateRoutingEvalRecord(record) {
  exact(record, ['contract', 'version', 'case_origin', 'task_class', 'task_id', 'recommendation_ref',
    'recommended_tier', 'recommended_reasoning', 'result_ref', 'review_ref', 'attribution_ref',
    'actual_tier', 'actual_reasoning', 'actual_evidence_ref',
    'first_pass_success', 'automated_checks', 'review_verdict', 'review_defects', 'rework_count',
    'execution_time_ms', 'escalation_count', 'frontier_usage', 'comparison_refs', 'routing_outcome', 'overhead'], 'eval_record');
  check(record.contract === 'RoutingEvalRecordV1' && record.version === 1, 'eval_record.version');
  choice(record.case_origin, ['real', 'synthetic_boundary'], 'case_origin');
  ref(record.task_class, 'task_class'); ref(record.task_id, 'task_id'); ref(record.recommendation_ref, 'recommendation_ref');
  choice(record.recommended_tier, tiers, 'recommended_tier');
  choice(record.recommended_reasoning, reasoning, 'recommended_reasoning');
  for (const key of ['result_ref', 'review_ref', 'attribution_ref', 'actual_evidence_ref'])
    if (record[key] !== null) ref(record[key], key);
  choice(record.actual_tier, [...tiers, 'unknown'], 'actual_tier');
  choice(record.actual_reasoning, [...reasoning, 'unknown'], 'actual_reasoning');
  check((record.actual_tier === 'unknown' && record.actual_reasoning === 'unknown') || record.actual_evidence_ref !== null,
    'actual_evidence_ref');
  tri(record.first_pass_success, 'first_pass_success');
  check(Array.isArray(record.automated_checks), 'automated_checks');
  for (const item of record.automated_checks) {
    exact(item, ['criterion_id', 'status', 'evidence_ref'], 'automated_check');
    ref(item.criterion_id, 'automated_check.criterion_id');
    choice(item.status, ['passed', 'failed', 'not_run'], 'automated_check.status');
    if (item.evidence_ref !== null) ref(item.evidence_ref, 'automated_check.evidence_ref');
  }
  choice(record.review_verdict, ['ACCEPT', 'REVISE', 'ESCALATE', 'unknown'], 'review_verdict');
  check(Array.isArray(record.review_defects) && record.review_defects.every(value => typeof value === 'string' && value.trim()), 'review_defects');
  optionalCount(record.rework_count, 'rework_count'); optionalCount(record.execution_time_ms, 'execution_time_ms');
  optionalCount(record.escalation_count, 'escalation_count'); tri(record.frontier_usage, 'frontier_usage');
  check(Array.isArray(record.comparison_refs) && record.comparison_refs.every(value => typeof value === 'string' && value.trim()) &&
    new Set(record.comparison_refs).size === record.comparison_refs.length, 'comparison_refs');
  if (record.case_origin === 'synthetic_boundary')
    check(record.execution_time_ms === null && record.frontier_usage !== true, 'synthetic_boundary: observed usage');
  choice(record.routing_outcome, outcomes, 'routing_outcome');
  if (record.routing_outcome === 'underroute') check(record.attribution_ref !== null, 'underroute: attribution_ref');
  if (record.routing_outcome === 'overroute') check(record.comparison_refs.length >= 2, 'overroute: comparison_refs');
  exact(record.overhead, ['classification', 'dedicated_model_calls', 'usage'], 'overhead');
  choice(record.overhead.classification, overheads, 'overhead.classification');
  optionalCount(record.overhead.dedicated_model_calls, 'overhead.dedicated_model_calls');
  if (['no_extra_model_call', 'piggyback'].includes(record.overhead.classification))
    check(record.overhead.dedicated_model_calls === 0, 'overhead.dedicated_model_calls');
  if (record.overhead.classification === 'dedicated_analysis')
    check(record.overhead.dedicated_model_calls > 0, 'overhead.dedicated_model_calls');
  if (record.overhead.classification === 'unknown')
    check(record.overhead.dedicated_model_calls === null, 'overhead.dedicated_model_calls');
  if (record.overhead.usage !== null) {
    exact(record.overhead.usage, ['tokens', 'resource_amount', 'resource_unit', 'source_ref', 'source_kind'], 'overhead.usage');
    check(record.case_origin === 'real' && record.overhead.usage.source_kind === 'host_observed', 'overhead.usage.source_kind');
    ref(record.overhead.usage.source_ref, 'overhead.usage.source_ref');
    optionalCount(record.overhead.usage.tokens, 'overhead.usage.tokens');
    check(record.overhead.usage.resource_amount === null ||
      (Number.isFinite(record.overhead.usage.resource_amount) && record.overhead.usage.resource_amount >= 0), 'overhead.usage.resource_amount');
    check((record.overhead.usage.resource_amount === null && record.overhead.usage.resource_unit === null) ||
      (record.overhead.usage.resource_amount !== null && typeof record.overhead.usage.resource_unit === 'string' &&
        record.overhead.usage.resource_unit.trim()), 'overhead.usage.resource_unit');
  }
  return record;
}

export function classifyRoutingOutcome({ record, attribution = null, comparison = null }) {
  validateRoutingEvalRecord(record);
  if (attribution !== null) {
    validateFailureAttribution(attribution);
    if (attribution.category === 'CAPABILITY_LIMIT' &&
      record.actual_tier === record.recommended_tier &&
      record.actual_reasoning === record.recommended_reasoning && record.attribution_ref !== null &&
      attribution.evidence_refs.includes(record.attribution_ref) &&
      (record.rework_count > 0 || record.review_defects.length > 0 || record.first_pass_success === false))
      return 'underroute';
  }
  if (comparison !== null) {
    exact(comparison, ['scope', 'runs'], 'comparison');
    ref(comparison.scope, 'comparison.scope');
    check(Array.isArray(comparison.runs), 'comparison.runs');
    for (const run of comparison.runs) validateRoutingEvalRecord(run);
    const accepted = comparison.runs.length >= 2 && comparison.runs.every(run =>
      run.task_class === comparison.scope && run.task_id === record.task_id &&
      run.case_origin === record.case_origin && run.first_pass_success === true &&
      run.review_verdict === 'ACCEPT' && run.result_ref !== null && run.review_ref !== null &&
      tiers.indexOf(run.actual_tier) < tiers.indexOf(record.actual_tier));
    const distinct = new Set(comparison.runs.map(run => run.result_ref)).size === comparison.runs.length &&
      new Set(comparison.runs.map(run => run.review_ref)).size === comparison.runs.length;
    if (record.first_pass_success === true && record.review_verdict === 'ACCEPT' &&
      record.actual_tier === record.recommended_tier &&
      comparison.scope === record.task_class && accepted && distinct) return 'overroute';
  }
  return 'insufficient_evidence';
}

// Extracts only existing structured evidence; missing optional evidence stays unknown.
export function passiveShadowRecord({ task_class, task_id, recommendation, result = null, review = null,
  attribution = null, actual = null, rework_count = null, execution_time_ms = null,
  escalation_count = null, frontier_usage = 'unknown', overhead = 'no_extra_model_call',
  dedicated_model_calls = null, usage = null, result_ref = null,
  case_origin = 'real', comparison = null }) {
  validateRoutingRecommendation(recommendation, { allow_unresolved_inheritance: true });
  ref(task_class, 'task_class'); ref(task_id, 'task_id'); choice(overhead, overheads, 'overhead');
  sameTask(result, recommendation.binding, 'result'); sameTask(review, recommendation.binding, 'review');
  if (recommendation.binding.kind === 'packet') check(recommendation.binding.task_id === task_id, 'task_id: recommendation mismatch');
  if (attribution !== null) validateFailureAttribution(attribution);
  if (actual !== null) {
    exact(actual, ['tier', 'reasoning', 'evidence_ref'], 'actual');
    choice(actual.tier, tiers, 'actual.tier'); choice(actual.reasoning, reasoning, 'actual.reasoning');
    ref(actual.evidence_ref, 'actual.evidence_ref');
  }
  if (frontier_usage === true) check(actual?.tier === 'FRONTIER', 'frontier_usage: actual evidence required');
  const checks = result?.checks?.map(item => ({ criterion_id: item.criterion_id, status: item.status,
    evidence_ref: item.evidence || null })) ?? [];
  const verdict = review?.verdict ?? 'unknown';
  const defects = [...(review?.acceptance_results ?? []).filter(item => item.status === 'failed')
    .map(item => item.criterion_id),
  ...(review?.revision_instructions?.map(item => typeof item === 'string' ? item : item.instruction).filter(Boolean) ?? [])];
  const first = result === null || review === null || rework_count === null || checks.length === 0 ? 'unknown' :
    result.status === 'succeeded' && verdict === 'ACCEPT' && rework_count === 0 &&
    checks.length > 0 && checks.every(item => item.status === 'passed') ? true : false;
  const record = {
    contract: 'RoutingEvalRecordV1', version: 1, case_origin, task_class, task_id,
    recommendation_ref: recommendation.recommendation_id, recommended_tier: recommendation.tier,
    recommended_reasoning: recommendation.reasoning,
    result_ref: result_ref ?? review?.result_sha256 ?? null,
    review_ref: review?.review_id ?? null, attribution_ref: attribution?.evidence_refs[0] ?? null,
    actual_tier: actual?.tier ?? 'unknown', actual_reasoning: actual?.reasoning ?? 'unknown',
    actual_evidence_ref: actual?.evidence_ref ?? null, first_pass_success: first, automated_checks: checks,
    review_verdict: verdict, review_defects: defects, rework_count, execution_time_ms,
    escalation_count, frontier_usage, comparison_refs: comparison?.runs?.map(run => run.result_ref) ?? [],
    routing_outcome: 'insufficient_evidence',
    overhead: { classification: overhead, dedicated_model_calls: overhead === 'unknown' ? null :
      overhead === 'dedicated_analysis' ? dedicated_model_calls : 0,
    usage: usage === null ? null : structuredClone(usage) },
  };
  validateRoutingEvalRecord(record);
  record.routing_outcome = classifyRoutingOutcome({ record, attribution, comparison });
  return record;
}

// Plans one offline step at a time; it never executes a candidate or modifies policy/Registry.
export function progressiveEvalStep({ tier, reasoning: level, reasoning_adjustable, observation = null,
  frontier_authorization = null }) {
  choice(tier, tiers, 'tier'); choice(level, reasoning, 'reasoning');
  check(typeof reasoning_adjustable === 'boolean', 'reasoning_adjustable');
  if (tier === 'FRONTIER') check(frontier_authorization?.sparse === true &&
    typeof frontier_authorization.approval_ref === 'string' && frontier_authorization.approval_ref.trim() &&
    Array.isArray(frontier_authorization.capability_evidence_refs) &&
    frontier_authorization.capability_evidence_refs.length > 0, 'FRONTIER sparse authorization');
  if (observation === null) return { action: 'EVALUATE', candidate: { tier, reasoning: level } };
  exact(observation, ['record', 'attribution'], 'observation');
  validateRoutingEvalRecord(observation.record);
  check(observation.record.actual_tier === tier && observation.record.actual_reasoning === level, 'observation.candidate');
  if (observation.record.first_pass_success === true && observation.record.review_verdict === 'ACCEPT' &&
    observation.record.automated_checks.length > 0 && observation.record.automated_checks.every(item => item.status === 'passed'))
    return { action: 'STOP', reason: 'accepted_success' };
  if (observation.attribution === null) return { action: 'STOP', reason: 'attribution_required' };
  validateFailureAttribution(observation.attribution);
  check(observation.record.attribution_ref !== null &&
    observation.attribution.evidence_refs.includes(observation.record.attribution_ref), 'attribution: record mismatch');
  if (observation.attribution.category !== 'CAPABILITY_LIMIT')
    return { action: 'STOP', reason: 'non_capability_failure' };
  const next = nextCapabilityStep({ tier, reasoning: level, reasoning_adjustable });
  if (next !== null) return { action: 'EVALUATE', candidate: next };
  if (tier === 'STRONG' && level === 'HIGH' && frontier_authorization?.sparse === true &&
    typeof frontier_authorization.approval_ref === 'string' && frontier_authorization.approval_ref.trim() &&
    Array.isArray(frontier_authorization.capability_evidence_refs) && frontier_authorization.capability_evidence_refs.length > 0)
    return { action: 'EVALUATE', candidate: { tier: 'FRONTIER', reasoning: 'LOW' } };
  return { action: 'STOP', reason: tier === 'STRONG' ? 'frontier_sparse_authorization_required' : 'capability_ceiling' };
}

// Produces an explicit import candidate, not a Registry update or tier calibration.
export function scopedRegistryEvalCandidate({ record, scope, sample_refs, observed_at, valid_until = null }) {
  validateRoutingEvalRecord(record);
  ref(scope, 'scope');
  check(scope === record.task_class, 'scope: task class mismatch');
  check(record.first_pass_success === true && record.review_verdict === 'ACCEPT' &&
    record.actual_tier !== 'unknown' && record.actual_evidence_ref !== null, 'eval evidence: accepted actual required');
  check(Array.isArray(sample_refs) && sample_refs.length === 1 &&
    sample_refs[0] === record.result_ref && record.result_ref !== null, 'sample_refs: existing result required');
  timestamp(observed_at, 'observed_at');
  if (valid_until !== null) {
    timestamp(valid_until, 'valid_until');
    check(valid_until >= observed_at, 'valid_until');
  }
  const evidence = { ref: sample_refs[0], scope, tier: record.actual_tier, reasoning_support: 'unknown',
    capabilities: [], observed_at, valid_until, confidence: 'LOW' };
  return { contract: 'RoutingEvalEvidenceCandidateV1', version: 1, task_class: record.task_class,
    eval_scope: scope, sample_count: sample_refs.length, sample_refs: [...sample_refs],
    outcome_summary: 'accepted_success', case_origin: record.case_origin,
    fixture_only: record.case_origin === 'synthetic_boundary', registry_evidence: evidence,
    import_requires_explicit_review: true };
}
