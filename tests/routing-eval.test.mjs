import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { recommendRouting } from '../scripts/adaptive-router.mjs';
import { attributeFailure } from '../scripts/failure-attribution.mjs';
import { loadRegistry, registryDigest, resolveRegistryCandidates } from '../scripts/model-capability-registry.mjs';
import { passiveShadowRecord, validateRoutingEvalRecord, classifyRoutingOutcome,
  progressiveEvalStep, scopedRegistryEvalCandidate } from '../scripts/routing-eval.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const now = '2026-09-27T12:00:00.000Z';
const before = '2026-09-01T00:00:00.000Z';
const after = '2026-10-01T00:00:00.000Z';
const recommendation = (profile_changes = {}) => recommendRouting({
  binding: { kind: 'packet', project_id: 'demo', task_id: 'T1', packet_id: 'EP-T1',
    packet_revision: 1, decision_version: 1, executor: 'WORK', lifecycle: 1, packet_sha256: hash('packet') },
  basis: { scope_digest: hash('scope'), task_digest: hash('task'), runtime_capability_digest: null,
    registry_evidence_digest: null, policy_digest: null },
  profile: { reasoning_complexity: 'LOW', context_load: 'LOW', ambiguity: 'LOW', failure_cost: 'LOW',
    verifiability: 'HIGH', change_surface: 'LOW', prior_evidence: 'HIGH', ...profile_changes }, checkpoint: 'pre_execution',
});
const result = () => structuredClone(JSON.parse(readFileSync(new URL('../examples/result-packet.json', import.meta.url))));
const review = () => structuredClone(JSON.parse(readFileSync(new URL('../examples/review.json', import.meta.url))));
const base = (patch = {}) => passiveShadowRecord({ task_class: 'clear_document_edit', task_id: 'T1',
  recommendation: recommendation(), result: result(), review: review(), rework_count: 0,
  actual: { tier: 'FAST', reasoning: 'LOW', evidence_ref: 'synthetic/actual-model' },
  case_origin: 'synthetic_boundary', ...patch });
const failure = (signal = 'TOOL_FAILURE') => attributeFailure({ evidence: [{ ref: 'failure/1', signal }] });
const capability = () => attributeFailure({ evidence: [
  { ref: 'review/repeated', signal: 'REPEATED_CONSTRAINT_FAILURE' },
  { ref: 'spec/clear', signal: 'SPEC_CLEAR' },
  { ref: 'preflight/healthy', signal: 'ENVIRONMENT_HEALTHY' },
] });

test('A: Passive Shadow extracts existing Result and Review without a dedicated call', () => {
  const record = base();
  assert.equal(record.recommendation_ref, recommendation().recommendation_id);
  assert.equal(record.review_ref, 'CR-T1-1');
  assert.equal(record.result_ref, review().result_sha256);
  assert.equal(record.first_pass_success, true);
  assert.deepEqual(record.automated_checks.map(item => item.status), ['passed']);
  assert.equal(record.overhead.classification, 'no_extra_model_call');
  assert.equal(record.overhead.dedicated_model_calls, 0);
  assert.equal(record.overhead.usage, null);
  assert.equal(record.routing_outcome, 'insufficient_evidence');
});

test('B/L: optional Eval evidence can be missing without changing Result or COMPLETE', () => {
  const rec = recommendation();
  const record = passiveShadowRecord({ task_class: 'clear_document_edit', task_id: 'T1', recommendation: rec });
  assert.equal(record.first_pass_success, 'unknown');
  assert.equal(record.actual_tier, 'unknown');
  assert.equal(record.review_verdict, 'unknown');
  assert.equal(record.execution_time_ms, null);
  assert.equal(record.overhead.usage, null);
  const state = JSON.parse(readFileSync(new URL('../contracts/routing.json', import.meta.url)));
  assert.deepEqual(state.states, ['DISCUSS', 'PLAN', 'READY_TO_EXECUTE', 'EXECUTE', 'REVIEW', 'REVISE', 'COMPLETE']);
  const existingResult = result();
  assert.equal(existingResult.schema_version, 2);
  assert.equal(Object.hasOwn(existingResult, 'routing_eval'), false);
});

test('C: accepted success stops Progressive Eval after its first candidate', () => {
  const record = base();
  assert.deepEqual(progressiveEvalStep({ tier: 'FAST', reasoning: 'LOW', reasoning_adjustable: true }),
    { action: 'EVALUATE', candidate: { tier: 'FAST', reasoning: 'LOW' } });
  assert.deepEqual(progressiveEvalStep({ tier: 'FAST', reasoning: 'LOW', reasoning_adjustable: true,
    observation: { record, attribution: null } }), { action: 'STOP', reason: 'accepted_success' });
});

test('D: non-capability failure stops; attributed capability failure advances reasoning first', () => {
  const failed = attribution => base({ result: { ...result(), status: 'partial' },
    review: { ...review(), verdict: 'REVISE' }, rework_count: 1, attribution });
  assert.deepEqual(progressiveEvalStep({ tier: 'FAST', reasoning: 'LOW', reasoning_adjustable: true,
    observation: { record: failed(failure()), attribution: failure() } }),
  { action: 'STOP', reason: 'non_capability_failure' });
  assert.deepEqual(progressiveEvalStep({ tier: 'FAST', reasoning: 'LOW', reasoning_adjustable: true,
    observation: { record: failed(capability()), attribution: capability() } }),
  { action: 'EVALUATE', candidate: { tier: 'FAST', reasoning: 'MEDIUM' } });
  assert.deepEqual(progressiveEvalStep({ tier: 'FAST', reasoning: 'LOW', reasoning_adjustable: false,
    observation: { record: failed(capability()), attribution: capability() } }),
  { action: 'EVALUATE', candidate: { tier: 'BALANCED', reasoning: 'LOW' } });
});

test('E: FRONTIER is absent without explicit sparse authorization and evidence', () => {
  const failed = base({ actual: { tier: 'STRONG', reasoning: 'HIGH', evidence_ref: 'host/actual' },
    result: { ...result(), status: 'partial' }, review: { ...review(), verdict: 'REVISE' },
    rework_count: 1, attribution: capability() });
  const request = { tier: 'STRONG', reasoning: 'HIGH', reasoning_adjustable: true,
    observation: { record: failed, attribution: capability() } };
  assert.deepEqual(progressiveEvalStep(request), { action: 'STOP', reason: 'frontier_sparse_authorization_required' });
  const frontier_authorization = { sparse: true, approval_ref: 'synthetic/approval',
    capability_evidence_refs: ['synthetic/capability'] };
  assert.deepEqual(progressiveEvalStep({ ...request, frontier_authorization }),
    { action: 'EVALUATE', candidate: { tier: 'FRONTIER', reasoning: 'LOW' } });
  assert.throws(() => progressiveEvalStep({ tier: 'FRONTIER', reasoning: 'LOW', reasoning_adjustable: true }),
    /FRONTIER sparse authorization/);
});

test('F/G/H: conservative routing outcomes need attribution or repeated comparison', () => {
  const accepted = base();
  assert.equal(classifyRoutingOutcome({ record: accepted }), 'insufficient_evidence');
  assert.equal(classifyRoutingOutcome({ record: accepted, comparison: { scope: accepted.task_class,
    runs: [accepted] } }), 'insufficient_evidence');
  const high = base({ recommendation: recommendation({ reasoning_complexity: 'HIGH' }),
    actual: { tier: 'STRONG', reasoning: 'HIGH', evidence_ref: 'synthetic/actual' } });
  const compared = { scope: high.task_class, runs: [base({ result_ref: 'trial/1',
    review: { ...review(), review_id: 'review/1' } }), base({ result_ref: 'trial/2',
    review: { ...review(), review_id: 'review/2' } })] };
  assert.equal(classifyRoutingOutcome({ record: high, comparison: compared }), 'overroute');
  const failed = base({ result: { ...result(), status: 'partial' }, attribution: capability(),
    review: { ...review(), verdict: 'REVISE', revision_instructions: ['Fix failed constraint'] }, rework_count: 1 });
  assert.equal(classifyRoutingOutcome({ record: failed }), 'insufficient_evidence');
  assert.equal(classifyRoutingOutcome({ record: failed, attribution: capability() }), 'underroute');
  assert.equal(classifyRoutingOutcome({ record: failed, attribution: failure() }), 'insufficient_evidence');
});

test('I/H: scoped Eval creates an import candidate and cannot silently alter Registry', () => {
  const accepted = base();
  const candidate = scopedRegistryEvalCandidate({ record: accepted, scope: accepted.task_class,
    sample_refs: [accepted.result_ref], observed_at: now, valid_until: after });
  assert.equal(candidate.sample_count, 1);
  assert.equal(candidate.import_requires_explicit_review, true);
  assert.equal(candidate.fixture_only, true);
  assert.equal(candidate.registry_evidence.scope, accepted.task_class);
  assert.equal(candidate.registry_evidence.confidence, 'LOW');
  assert.throws(() => scopedRegistryEvalCandidate({ record: accepted, scope: 'different_scope',
    sample_refs: [accepted.result_ref], observed_at: now }), /scope: task class mismatch/);
  const baseline = JSON.parse(readFileSync(new URL('../contracts/model-capabilities.v1.json', import.meta.url)));
  assert.deepEqual(baseline.entries, []);
  const entry = { id: 'synthetic.option', provider_family: 'synthetic', host_family: 'synthetic',
    provider_facts: { tier: 'FAST', reasoning_support: 'supported', capabilities: [],
      evidence_refs: ['synthetic/provider'], verified_at: before, valid_until: after, confidence: 'HIGH' },
    eval_evidence: [candidate.registry_evidence] };
  const local = { contract: 'ModelCapabilityRegistryV1', version: 1, registry_version: 'synthetic-1',
    snapshot_id: 'synthetic-1', entries: [entry] };
  const registry = loadRegistry({ baseline, local, selected: 'local', expected_local_digest: registryDigest(local) });
  const args = { registry, tier: 'FAST', reasoning: 'LOW', now };
  const unrelated = resolveRegistryCandidates({ ...args, eval_scope: 'different_scope' });
  const matched = resolveRegistryCandidates({ ...args, eval_scope: accepted.task_class });
  assert.equal(unrelated.candidates[0].eval_evidence.length, 0);
  assert.equal(matched.candidates[0].eval_evidence.length, 1);
  assert.equal(entry.provider_facts.tier, 'FAST');
});

test('J: overhead classes preserve unknown usage and reject fabricated precision', () => {
  for (const [classification, count] of [['no_extra_model_call', 0], ['piggyback', 0],
    ['dedicated_analysis', 1], ['unknown', null]]) {
    const record = base({ overhead: classification, dedicated_model_calls: count });
    assert.equal(record.overhead.classification, classification);
    assert.equal(record.overhead.dedicated_model_calls, count);
    assert.equal(record.overhead.usage, null);
  }
  assert.throws(() => base({ overhead: 'dedicated_analysis' }), /dedicated_model_calls/);
  assert.throws(() => base({ case_origin: 'synthetic_boundary', usage: { tokens: 400,
    resource_amount: null, resource_unit: null, source_ref: 'invented', source_kind: 'host_observed' } }), /source_kind/);
  assert.throws(() => validateRoutingEvalRecord({ ...base(), chain_of_thought: 'hidden' }), /eval_record/);
});

test('K: representative set covers required classes without target-tier answers', () => {
  const tasks = JSON.parse(readFileSync(new URL('./fixtures/routing-eval-tasks.json', import.meta.url)));
  assert.ok(tasks.length >= 12 && tasks.length <= 20);
  assert.equal(new Set(tasks.map(item => item.id)).size, tasks.length);
  assert.ok(tasks.filter(item => item.origin === 'repository_history').length >= 12);
  assert.ok(tasks.filter(item => item.origin === 'synthetic_boundary').length >= 2);
  for (const task of tasks) {
    for (const field of ['task_class', 'input', 'constraints', 'acceptance', 'boundary', 'source_ref'])
      assert.ok(typeof task[field] === 'string' && task[field].trim());
    assert.equal(Object.hasOwn(task, 'correct_tier'), false);
    assert.doesNotMatch(task.acceptance, /(?:FAST|BALANCED|STRONG|FRONTIER) is correct/i);
    if (task.origin === 'repository_history')
      assert.match(task.source_ref, /^[a-f0-9]{7,40}:[A-Za-z0-9./-]+$/);
  }
});

test('M: Eval source has no network, model invocation, watcher or state mutation', () => {
  const source = readFileSync(new URL('../scripts/routing-eval.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:fetch\s*\(|https?:\/\/|spawn|execFile|watch\s*\(|writeFile|createServer|setInterval)/);
  assert.doesNotMatch(source, /(?:project-state|schema_version\s*=\s*3)/);
});
