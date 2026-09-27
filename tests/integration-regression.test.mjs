import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chooseWorkshop, advanceDiscovery, createProductBrief } from '../scripts/workshop.mjs';
import { recommendRouting, validateRoutingRecommendation, resolveRoutingCandidates } from '../scripts/adaptive-router.mjs';
import { resolveResourcePolicy, decideResourceRouting } from '../scripts/resource-policy.mjs';
import { attributeFailure, failureReassessmentHint } from '../scripts/failure-attribution.mjs';
import { loadRegistry, registryDigest, validateRuntimeOverlay } from '../scripts/model-capability-registry.mjs';
import { passiveShadowRecord, scopedRegistryEvalCandidate } from '../scripts/routing-eval.mjs';
import { transition } from '../scripts/router.mjs';
import { packetIdentity, resultDigest, checkSideEffect, validateSnapshot } from '../scripts/contracts.mjs';

const read = name => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
const profile = { reasoning_complexity: 'LOW', context_load: 'LOW', ambiguity: 'LOW',
  failure_cost: 'LOW', verifiability: 'HIGH', change_surface: 'LOW', prior_evidence: 'HIGH' };
const basis = packet => ({ scope_digest: sha(JSON.stringify(packet.scope)), task_digest: sha(packet.goal),
  runtime_capability_digest: null, registry_evidence_digest: null, policy_digest: null });
const binding = packet => ({ kind: 'packet', project_id: packet.project_id, task_id: packet.task_id,
  packet_id: packet.packet_id, packet_revision: packet.packet_revision,
  decision_version: packet.decision_version, executor: packet.executor,
  lifecycle: packet.lifecycle, packet_sha256: packetIdentity(packet).content_sha256 });
const recommend = (packet, changes = {}) => recommendRouting({ binding: binding(packet), basis: basis(packet),
  profile, checkpoint: 'pre_execution', ...changes });
const runtime = changes => ({ current_tier: 'FAST', current_reasoning: 'LOW',
  tier_availability: { FAST: 'available', BALANCED: 'unknown', STRONG: 'unknown', FRONTIER: 'unknown' },
  switch_supported: 'unknown', reasoning_adjustable: 'unknown', auto_route_authorized: false, ...changes });
const step = (snapshot, packet, event, extra = {}) => transition({ snapshot, packet,
  event, work_type: packet.work_type, ...extra });
const sample = () => ({ snapshot: read('project-state'), packet: read('execution-packet'),
  preflight: read('preflight'), result: read('result-packet'), review: read('review') });
const ready = fixture => step(fixture.snapshot, fixture.packet, 'prepare').snapshot;
const running = fixture => step(ready(fixture), fixture.packet, 'start', { preflight: fixture.preflight }).snapshot;
const completed = fixture => {
  const submitted = step(running(fixture), fixture.packet, 'submit', { result: fixture.result }).snapshot;
  fixture.review.result_sha256 = resultDigest(fixture.result);
  return step(submitted, fixture.packet, 'accept', { result: fixture.result, review: fixture.review }).snapshot;
};

test('A: defined small task follows one fast path through Packet, Review and passive Eval', () => {
  const f = sample();
  assert.equal(chooseWorkshop({ smallTask: true }).enter, false);
  const rec = recommend(f.packet);
  const policy = decideResourceRouting({ recommendation: rec, policy: resolveResourcePolicy(), runtime: runtime() });
  assert.equal(rec.routing_path, 'FAST_PATH');
  assert.equal(policy.tier, 'FAST');
  const packetBefore = packetIdentity(f.packet);
  const state = completed(f);
  assert.equal(state.state, 'COMPLETE');
  assert.deepEqual(state.active_packet, packetBefore);
  const evalRecord = passiveShadowRecord({ task_class: 'bounded_document', task_id: f.packet.task_id,
    recommendation: rec, result: f.result, review: f.review, rework_count: 0,
    case_origin: 'synthetic_boundary' });
  assert.equal(evalRecord.first_pass_success, true);
  assert.equal(evalRecord.actual_tier, 'unknown');
  assert.equal(evalRecord.overhead.dedicated_model_calls, 0);
  assert.equal(evalRecord.overhead.usage, null);
  assert.equal(rec.overhead.extra_model_call || policy.overhead.extra_model_call, false);
});

test('B: discovery must be ready and delivered before its Brief can enter PLAN; Brief grants no execution', () => {
  const f = sample();
  f.snapshot.state = 'DISCUSS';
  assert.equal(chooseWorkshop({ goalKnown: false, scopeKnown: false }).enter, true);
  const unknowns = [{ id: 'scope', question: 'Which users?', blocking: true, impact: 3 }];
  const discovery = advanceDiscovery({ unknowns });
  assert.equal(discovery.readiness, 'needs_answer');
  const sections = Object.fromEntries(['problem', 'usersScenario', 'desiredOutcome', 'scopeIn', 'scopeOut',
    'evidence', 'proposedApproach', 'alternatives', 'openQuestions', 'successCriteria', 'deliveryDepth']
    .map(key => [key, `fixture ${key}`]));
  assert.equal(createProductBrief({ sections, discovery, deliveryComplete: true }).status, 'draft');
  const planned = step(f.snapshot, f.packet, 'plan').snapshot;
  f.packet.authorization.status = 'pending';
  assert.throws(() => step(planned, f.packet, 'prepare'), /authorization/);
  const resolved = advanceDiscovery({ unknowns: [{ ...unknowns[0], answer: 'Internal users' }] });
  assert.equal(createProductBrief({ sections, discovery: resolved }).status, 'draft');
  const brief = createProductBrief({ sections, discovery: resolved, deliveryComplete: true });
  assert.equal(brief.status, 'ready');
  assert.match(brief.markdown, /not a decision or execution authorization/);
  assert.throws(() => step(planned, f.packet, 'prepare'), /authorization/);
  f.packet.authorization.status = 'granted';
  assert.equal(recommend(f.packet).checkpoint, 'pre_execution');
  assert.equal(step(planned, f.packet, 'prepare').snapshot.state, 'READY_TO_EXECUTE');
  assert.equal(chooseWorkshop({ mode: 'BYPASS' }).enter, false);
  f.packet.authorization.status = 'pending';
  assert.throws(() => step(planned, f.packet, 'prepare'), /authorization/);
});

test('C: capability need and execution risk remain independent across policy and Packet', () => {
  for (const [change, expected] of [
    [{ reasoning_complexity: 'HIGH' }, ['STRONG', 'LOW']],
    [{ failure_cost: 'HIGH' }, ['FAST', 'HIGH']],
  ]) {
    const f = sample();
    const rec = recommend(f.packet, { profile: { ...profile, ...change } });
    assert.deepEqual([rec.tier, rec.execution_risk], expected);
    assert.equal(decideResourceRouting({ recommendation: rec, policy: resolveResourcePolicy(),
      runtime: runtime() }).tier, rec.tier);
    assert.deepEqual(f.packet.required_capabilities, ['files']);
    assert.equal(completed(f).state, 'COMPLETE');
  }
});

test('D: external Recommendation changes and checkpoint inheritance do not revise Packet', () => {
  const f = sample();
  const packetBefore = packetIdentity(f.packet);
  const first = recommend(f.packet);
  const inherited = recommend(f.packet, { checkpoint: 'review', previous: first });
  assert.equal(inherited.inherited, true);
  assert.equal(inherited.routing_path, 'INHERITED');
  assert.equal(inherited.overhead.dedicated_analysis, false);
  const revised = recommend(f.packet, { profile: { ...profile, reasoning_complexity: 'HIGH' },
    checkpoint: 'significant_replan', previous: inherited });
  assert.equal(revised.inherited, false);
  assert.equal(revised.tier, 'STRONG');
  validateRoutingRecommendation(revised, { binding: binding(f.packet), basis: basis(f.packet) });
  assert.deepEqual(packetIdentity(f.packet), packetBefore);
  assert.equal(step(ready(f), f.packet, 'start', { preflight: f.preflight }).snapshot.state, 'EXECUTE');
});

test('E: changed required capabilities or scope still require a revised Packet and replan', () => {
  for (const change of [p => p.required_capabilities.push('tests'), p => p.scope.in.push('new scope')]) {
    const f = sample();
    const active = ready(f);
    const plan = { ...active, state: 'PLAN' };
    const old = packetIdentity(f.packet);
    change(f.packet);
    assert.throws(() => step(plan, f.packet, 'prepare'), /packet_revision/);
    f.packet.packet_revision++;
    if (f.packet.required_capabilities.includes('tests')) f.packet.capability_preflight_required = true;
    const attempted = step(plan, f.packet, 'prepare');
    assert.equal(attempted.action, 'replan_required');
    assert.deepEqual(attempted.snapshot.active_packet, old);
    const approval = { reviewer: 'CHAT', source_kind: 'user_instruction', approval_ref: 'fixture approval',
      from_packet_sha256: old.content_sha256, to_packet_sha256: packetIdentity(f.packet).content_sha256,
      replaces_review_id: null };
    const approved = step(plan, f.packet, 'replan', { approval }).snapshot;
    assert.equal(step(approved, f.packet, 'prepare').snapshot.state, 'READY_TO_EXECUTE');
  }
});

test('F: FRONTIER recommendation, approval, availability and use stay separate from side effects', () => {
  const f = sample();
  const frontier = recommend(f.packet, { profile: { ...profile, reasoning_complexity: 'HIGH',
    context_load: 'HIGH', ambiguity: 'HIGH', verifiability: 'LOW', change_surface: 'HIGH' },
  frontier_evidence_refs: ['fixture-capability-evidence'] });
  const policy = resolveResourcePolicy();
  const unavailable = runtime({ tier_availability: { FAST: 'available', BALANCED: 'available',
    STRONG: 'available', FRONTIER: 'unavailable' } });
  const noApproval = decideResourceRouting({ recommendation: frontier, policy, runtime: unavailable });
  assert.deepEqual([noApproval.frontier.recommended, noApproval.frontier.approved,
    noApproval.frontier.available, noApproval.frontier.selected, noApproval.frontier.actually_used],
  [true, false, 'unavailable', 'unknown', 'unknown']);
  const approval = { recommendation_id: frontier.recommendation_id, tier: 'FRONTIER',
    action: 'select_model', resource_limit: 'fixture cap', evidence_ref: 'fixture trusted approval' };
  const allowed = decideResourceRouting({ recommendation: frontier, policy, runtime: unavailable,
    frontier_approval: approval });
  assert.equal(allowed.frontier.approved, true);
  assert.equal(allowed.tier_action, 'RECOMMEND_ONLY');
  const executing = running(f);
  assert.deepEqual(checkSideEffect(f.packet, executing, { action: 'email_send', target: 'person@example.test' }),
    { allowed: false, status: 'require_escalation' });
});

test('G/I: Review REVISE alone does not escalate; evidence determines the recovery path', () => {
  const f = sample();
  const rec = recommend(f.packet);
  const review = { ...f.review, verdict: 'REVISE', revision_instructions: ['Fix failed check'],
    acceptance_results: [{ ...f.review.acceptance_results[0], status: 'failed' }] };
  const failed = { ...f.result, status: 'partial', checks: [{ ...f.result.checks[0], status: 'failed' }] };
  review.result_sha256 = resultDigest(failed);
  const submitted = step(running(f), f.packet, 'submit', { result: failed }).snapshot;
  assert.equal(step(submitted, f.packet, 'revise', { result: failed, review }).snapshot.state, 'REVISE');
  for (const [signal, category, action] of [
    ['SPEC_UNCLEAR', 'SPEC_AMBIGUITY', 'RETURN_WORKSHOP_PLAN'],
    ['CONTEXT_MISSING', 'MISSING_CONTEXT', 'SUPPLY_CONTEXT'],
    ['TOOL_FAILURE', 'TOOL_OR_ENVIRONMENT', 'RECOVER_ENVIRONMENT_PREFLIGHT'],
    ['TEST_SPEC_CONFLICT', 'TEST_OR_SPEC_CONFLICT', 'RETURN_PLAN_CHALLENGE'],
  ]) {
    const attribution = attributeFailure({ evidence: [{ ref: `fixture/${signal}`, signal }],
      result_status: 'partial', review_verdict: 'REVISE' });
    assert.deepEqual([attribution.category, attribution.recommended_action], [category, action]);
    assert.equal(failureReassessmentHint({ attribution, tier: rec.tier, reasoning: rec.reasoning,
      reasoning_adjustable: true }), null);
  }
  const unknown = attributeFailure({ result_status: 'partial', review_verdict: 'REVISE' });
  assert.equal(unknown.category, 'UNKNOWN');
  assert.equal(unknown.recommended_action, 'DIAGNOSE');
  assert.equal(failureReassessmentHint({ attribution: unknown, tier: rec.tier, reasoning: rec.reasoning,
    reasoning_adjustable: true }), null);
  const capability = attributeFailure({ evidence: [
    { ref: 'fixture/repeated', signal: 'REPEATED_CONSTRAINT_FAILURE' },
    { ref: 'fixture/spec', signal: 'SPEC_CLEAR' },
    { ref: 'fixture/environment', signal: 'ENVIRONMENT_HEALTHY' }],
  result_status: 'partial', review_verdict: 'REVISE' });
  assert.deepEqual(failureReassessmentHint({ attribution: capability, tier: rec.tier,
    reasoning: rec.reasoning, reasoning_adjustable: true }).next_capability,
  { tier: 'FAST', reasoning: 'MEDIUM' });
  const evalRecord = passiveShadowRecord({ task_class: 'bounded_document', task_id: f.packet.task_id,
    recommendation: rec, result: failed, review, attribution: unknown,
    case_origin: 'synthetic_boundary' });
  assert.equal(evalRecord.first_pass_success, 'unknown');
  assert.equal(evalRecord.routing_outcome, 'insufficient_evidence');
});

test('H: stale or unavailable Registry stays unresolved and cannot prove a capability limit', () => {
  const f = sample();
  const baseline = readFileSync(new URL('../contracts/model-capabilities.v1.json', import.meta.url), 'utf8');
  const empty = loadRegistry({ baseline: JSON.parse(baseline) });
  const rec = recommend(f.packet, { profile: { ...profile, reasoning_complexity: 'HIGH' },
    basis: { ...basis(f.packet), registry_evidence_digest: empty.digest } });
  const unresolved = resolveRoutingCandidates({ recommendation: rec, registry: empty,
    now: '2026-09-27T12:00:00.000Z' });
  assert.equal(unresolved.status, 'unresolved');
  assert.equal(unresolved.refresh_needed, true);
  const stale = { contract: 'ModelCapabilityRegistryV1', version: 1,
    registry_version: 'fixture-1', snapshot_id: 'fixture-stale', entries: [{
      id: 'fixture.model', provider_family: 'fixture', host_family: 'fixture',
      provider_facts: { tier: 'STRONG', reasoning_support: 'supported', capabilities: [],
        evidence_refs: ['fixture/provider'], verified_at: '2026-09-01T00:00:00.000Z',
        valid_until: '2026-09-10T00:00:00.000Z', confidence: 'HIGH' }, eval_evidence: [],
    }] };
  const local = loadRegistry({ baseline: JSON.parse(baseline), local: stale, selected: 'local',
    expected_local_digest: registryDigest(stale) });
  const staleRec = recommend(f.packet, { profile: { ...profile, reasoning_complexity: 'HIGH' },
    basis: { ...basis(f.packet), registry_evidence_digest: local.digest } });
  const staleResolution = resolveRoutingCandidates({ recommendation: staleRec, registry: local,
    now: '2026-09-27T12:00:00.000Z' });
  assert.equal(staleResolution.status, 'unresolved');
  assert.ok(staleResolution.reasons.includes('provider_stale'));
  assert.equal(staleResolution.refresh_needed, true);
  for (const signal of ['REGISTRY_STALE', 'REGISTRY_UNKNOWN', 'MODEL_UNAVAILABLE']) {
    const attribution = attributeFailure({ evidence: [{ ref: 'fixture/repeated', signal: 'REPEATED_CONSTRAINT_FAILURE' },
      { ref: 'fixture/spec', signal: 'SPEC_CLEAR' }, { ref: 'fixture/env', signal: 'ENVIRONMENT_HEALTHY' },
      { ref: `fixture/${signal}`, signal }] });
    assert.notEqual(attribution.category, 'CAPABILITY_LIMIT');
  }
});

test('H/L: runtime unknown is not preflight availability and unreadable quota stays unknown', () => {
  const f = sample();
  const overlay = { contract: 'ModelRuntimeOverlayV1', version: 1, host_session: 'fixture-session',
    observations: [{ id: 'fixture.model', available: 'unknown', selectable: 'unknown',
      reasoning_control: 'unknown', switching_support: 'unknown',
      quota: { readable: 'unknown', remaining: null, unit: null }, source_ref: 'fixture/host-observation',
      observed_at: '2026-09-27T12:00:00.000Z', valid_until: null }] };
  validateRuntimeOverlay(overlay);
  assert.equal(overlay.observations[0].quota.remaining, null);
  f.packet.required_capabilities.push('model_switch');
  f.packet.capability_preflight_required = true;
  f.preflight.checked_capabilities.push({ capability: 'model_switch', available: false,
    evidence: 'Host cannot confirm model switching' });
  f.preflight.recovery_conditions.push('Confirm switching in the current host session');
  const blocked = step(ready(f), f.packet, 'start', { preflight: f.preflight });
  assert.equal(blocked.action, 'preflight_blocked');
  assert.equal(blocked.snapshot.state, 'REVIEW');
  assert.deepEqual(blocked.result.missing_capabilities, ['model_switch']);
  assert.equal(blocked.result.side_effects_performed.length, 0);
  assert.equal(blocked.result.checks[0].status, 'not_run');
});

test('J: Eval scope mismatch cannot enter Registry; matching evidence remains an import candidate', () => {
  const f = sample();
  const rec = recommend(f.packet);
  const record = passiveShadowRecord({ task_class: 'bounded_document', task_id: f.packet.task_id,
    recommendation: rec, result: f.result, review: f.review, rework_count: 0,
    actual: { tier: 'FAST', reasoning: 'LOW', evidence_ref: 'fixture/host-actual' },
    case_origin: 'synthetic_boundary' });
  assert.throws(() => scopedRegistryEvalCandidate({ record, scope: 'different',
    sample_refs: [record.result_ref], observed_at: '2026-09-27T12:00:00.000Z' }), /scope/);
  const candidate = scopedRegistryEvalCandidate({ record, scope: 'bounded_document',
    sample_refs: [record.result_ref], observed_at: '2026-09-27T12:00:00.000Z' });
  assert.equal(candidate.fixture_only, true);
  assert.equal(candidate.import_requires_explicit_review, true);
  assert.equal(read('project-state').schema_version, 2);
  assert.equal(JSON.parse(readFileSync(new URL('../contracts/model-capabilities.v1.json', import.meta.url))).entries.length, 0);
});

test('K: old schema-2 state without extensions completes; damaged optional extension is isolated', () => {
  const f = sample();
  assert.equal(validateSnapshot(f.snapshot), f.snapshot);
  assert.equal(Object.hasOwn(f.snapshot, 'product_brief'), false);
  assert.equal(Object.hasOwn(f.packet, 'routing_recommendation'), false);
  const invalid = { contract: 'RoutingRecommendationV1' };
  assert.throws(() => validateRoutingRecommendation(invalid), /Contract violation/);
  assert.equal(completed(f).state, 'COMPLETE');
  assert.equal(validateSnapshot(f.snapshot), f.snapshot);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../contracts/routing.json', import.meta.url))).states,
    ['DISCUSS', 'PLAN', 'READY_TO_EXECUTE', 'EXECUTE', 'REVIEW', 'REVISE', 'COMPLETE']);
});
