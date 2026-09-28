import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planDelivery, validateDeliveryManifest, inspectDelivery, resumeDelivery,
  approveDelivery, validateDeliveryApproval, DEFAULT_DELIVERY_POLICY } from '../scripts/delivery-manifest.mjs';
import { createProductBrief } from '../scripts/workshop.mjs';
import { prepareRoutingExplanation, recommendRouting } from '../scripts/adaptive-router.mjs';
import { resultDigest, validateSnapshot, validateExecution, packetIdentity, checkSideEffect } from '../scripts/contracts.mjs';
import { transition } from '../scripts/router.mjs';
import { migrateSnapshot } from '../scripts/migration.mjs';

const json = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const fixture = json('./fixtures/delivery-incident.json');
const sections = count => Array.from({ length: count }, (_, i) => ({ id: `section-${i + 1}`,
  content: `## §${i + 1}\nBoundary ${i + 1}: retain the confirmed scope and evidence.\n` }));
const incident = (changes = {}) => planDelivery({ artifact_id: fixture.artifact_id,
  artifact_kind: 'architecture_review', sections: sections(fixture.section_count),
  policy: { max_sections: fixture.sections_per_part, max_chars: 12000 }, ...changes });
const binding = manifest => ({ artifact_id: manifest.artifact_id,
  artifact_revision: manifest.artifact_revision, manifest_digest: manifest.digest });
const receipt = (plan, emission, kind = 'confirmed', source = 'user') => ({ kind,
  ...binding(plan.manifest), ...emission, source,
  evidence_ref: `${kind}:${source}:${emission.segment_id}` });
const receipts = (plan, emissions = plan.emissions, kind = 'confirmed', source = 'user') =>
  emissions.map(emission => receipt(plan, emission, kind, source));
const completion = (plan, marker = plan.manifest.completion_marker, source = 'user') => ({
  kind: 'completion', ...binding(plan.manifest), marker, source, evidence_ref: `end:${source}:${marker}` });
const report = (plan, segment_id = null) => ({ kind: 'truncated', ...binding(plan.manifest),
  part_id: 'part-2', segment_id, source: 'user', evidence_ref: 'user:truncated-part-2' });
const approval = (plan, part_ids) => ({ ...binding(plan.manifest), part_ids,
  source_kind: 'user_instruction', approval_ref: 'user:accept-visible-parts' });
const briefSections = value => Object.fromEntries(['problem', 'usersScenario', 'desiredOutcome',
  'scopeIn', 'scopeOut', 'evidence', 'proposedApproach', 'alternatives', 'openQuestions',
  'successCriteria', 'deliveryDepth'].map(key => [key, `${key}: ${value}`]));

test('A: short output has no manifest, digest, markers or mandatory persistence', () => {
  assert.deepEqual(planDelivery({ sections: sections(2) }), { manifest: null, emissions: [] });
  assert.equal(planDelivery({ sections: sections(2), artifact_id: 'short' }).manifest, null);
});

test('B: long structured output packs whole sections using explicitly heuristic budgets', () => {
  const plan = incident();
  assert.equal(plan.manifest.parts.length, 4);
  assert.equal(plan.emissions.length, 160);
  assert.equal(plan.manifest.policy.heuristic, 'characters_and_sections');
  assert.deepEqual(plan.manifest.parts[1].segments.map(s => s.section_id),
    sections(160).slice(40, 80).map(s => s.id));
  assert.deepEqual(plan.emissions.map(e => e.content), sections(160).map(s => s.content));
  assert.doesNotMatch(JSON.stringify(plan.manifest), /Boundary 61|token|usage/);
  assert.doesNotThrow(() => validateDeliveryManifest(plan.manifest));
});

test('B: one oversize semantic section is retained and flagged, never cut arbitrarily', () => {
  const plan = planDelivery({ artifact_id: 'oversize', sections: [{ id: 'atomic', content: 'x'.repeat(13000) }] });
  assert.equal(plan.emissions[0].content.length, 13000);
  assert.equal(plan.manifest.parts[0].segments[0].oversize, true);
});

test('C: only three of four delivered parts cannot complete even with a final marker', () => {
  const plan = incident();
  const events = receipts(plan, plan.emissions.filter(e => e.part_id !== 'part-4'));
  assert.equal(inspectDelivery(plan.manifest, [...events, completion(plan)]).complete, false);
  assert.equal(inspectDelivery(plan.manifest, events).parts[3].delivered, false);
});

test('D: all parts without exact completion marker remain unknown; parts plus marker complete', () => {
  const plan = incident(); const events = receipts(plan);
  assert.equal(inspectDelivery(plan.manifest, events).status, 'unknown');
  assert.equal(inspectDelivery(plan.manifest, [...events, completion(plan, 'I am done')]).complete, false);
  assert.equal(inspectDelivery(plan.manifest, [...events, completion(plan)]).complete, true);
  assert.equal(inspectDelivery(plan.manifest, [...events, completion(plan)]).visibility, 'confirmed');
  assert.equal(resumeDelivery(plan.manifest, events).action, 'completion_marker');
  assert.equal(resumeDelivery(plan.manifest, events).segments.length, 0);
});

test('D: emitted content plus exact markers can establish local completeness, never UI visibility', () => {
  const plan = incident(); const events = receipts(plan, plan.emissions, 'delivered', 'emission');
  const result = inspectDelivery(plan.manifest, [...events, completion(plan, undefined, 'emission')]);
  assert.equal(result.complete, true); assert.equal(result.visibility, 'unknown');
  assert.equal(result.parts[0].confirmed, false);
  assert.equal(approveDelivery(plan.manifest, events, approval(plan, ['part-1'])).accepted, false);
});

test('D: early marker is not credited retroactively when missing parts later arrive', () => {
  const plan = incident();
  assert.equal(inspectDelivery(plan.manifest, [completion(plan), ...receipts(plan)]).complete, false);
});

test('E: real-incident abstraction resumes Part 2 at §61 without replaying §1–60', () => {
  const plan = incident(); const events = receipts(plan, plan.emissions.slice(0, 60));
  const resumed = resumeDelivery(plan.manifest, events);
  assert.deepEqual(resumed.resume_from, { part_id: 'part-2', segment_id: 'segment-section-61', section_id: 'section-61' });
  assert.equal(resumed.segments.length, 100);
  assert.ok(resumed.segments.every(s => s.part_id !== 'part-1'));
  assert.equal(inspectDelivery(plan.manifest, events).parts[0].confirmed, true);
});

test('E: delivered text after a gap is preserved; explicit part cannot skip an earlier gap', () => {
  const plan = incident(); const events = receipts(plan, [...plan.emissions.slice(0, 60), ...plan.emissions.slice(80, 120)]);
  const resumed = resumeDelivery(plan.manifest, events);
  assert.ok(resumed.segments.every(s => s.part_id !== 'part-3'));
  assert.equal(resumeDelivery(plan.manifest, events, { from_part_id: 'part-4' }).reason, 'earlier_gap');
});

test('F: user truncation report invalidates the affected suffix and the former final marker', () => {
  const plan = incident(); const events = [...receipts(plan), completion(plan)];
  const interrupted = [...events, report(plan, 'segment-section-61')];
  const result = inspectDelivery(plan.manifest, interrupted);
  assert.equal(result.complete, false); assert.equal(result.visibility, 'incomplete');
  assert.equal(result.parts[1].segments[19].status, 'confirmed');
  assert.equal(result.parts[1].segments[20].status, 'incomplete');
  assert.equal(result.parts[0].confirmed, true);
  assert.equal(resumeDelivery(plan.manifest, interrupted).segments.length, 20);
  const restored = [...interrupted, ...receipts(plan, plan.emissions.slice(60, 80)).map(e => ({ ...e, evidence_ref: `new:${e.evidence_ref}` }))];
  assert.equal(inspectDelivery(plan.manifest, restored).complete, false);
  assert.equal(inspectDelivery(plan.manifest, [...restored, { ...completion(plan), evidence_ref: 'new-end' }]).complete, true);
});

test('F: report without precise section conservatively resumes that part; replayed receipt cannot undo report', () => {
  const plan = incident(); const original = receipts(plan);
  const events = [...original, completion(plan), report(plan), original[40]];
  assert.equal(resumeDelivery(plan.manifest, events).resume_from.section_id, 'section-41');
  assert.equal(inspectDelivery(plan.manifest, events).parts[1].confirmed, false);
});

test('G: accepted Part 1/2 plus incomplete Part 3 never expands ambiguous approval to Part 3/4', () => {
  const plan = incident(); const events = receipts(plan, plan.emissions.slice(0, 80));
  const accepted = approveDelivery(plan.manifest, events, approval(plan, ['part-1', 'part-2']));
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.scope.parts.map(p => p.id), ['part-1', 'part-2']);
  assert.equal(approveDelivery(plan.manifest, events, { source_kind: 'user_instruction', approval_ref: '可以' }).reason, 'ambiguous_scope');
  assert.equal(approveDelivery(plan.manifest, events, approval(plan, ['part-4'])).accepted, false);
  assert.deepEqual(approveDelivery(plan.manifest, events, approval(plan, ['part-3', 'part-4'])).eligible_part_ids, ['part-1', 'part-2']);
});

test('H: content or artifact revision change invalidates old approval, marker and receipts', () => {
  const plan = incident(); const events = receipts(plan);
  const scope = approveDelivery(plan.manifest, events, approval(plan, ['part-1'])).scope;
  const revisedSections = sections(160); revisedSections[0].content += 'Revised boundary.';
  const revised = incident({ sections: revisedSections, artifact_revision: 2 });
  assert.notEqual(revised.manifest.digest, plan.manifest.digest);
  assert.throws(() => validateDeliveryApproval(scope, revised.manifest, receipts(revised)), /binding/);
  assert.equal(inspectDelivery(revised.manifest, [...events, completion(plan)]).complete, false);
  const sameRevision = incident({ sections: revisedSections });
  assert.throws(() => validateDeliveryApproval(scope, sameRevision.manifest, receipts(sameRevision)), /binding/);
});

test('H: report invalidates an approval covering its segment but preserves approvals of unaffected parts', () => {
  const plan = incident(); const events = receipts(plan);
  const first = approveDelivery(plan.manifest, events, approval(plan, ['part-1'])).scope;
  const second = approveDelivery(plan.manifest, events, approval(plan, ['part-2'])).scope;
  const interrupted = [...events, report(plan)];
  assert.doesNotThrow(() => validateDeliveryApproval(first, plan.manifest, interrupted));
  assert.throws(() => validateDeliveryApproval(second, plan.manifest, interrupted), /delivered/);
});

test('I: delivery receipt and content approval create no Packet or side-effect authorization', () => {
  const state = json('../examples/project-state.json'); const packet = json('../examples/execution-packet.json');
  const before = structuredClone({ state, packet }); const plan = incident();
  const events = [...receipts(plan), completion(plan)];
  const accepted = approveDelivery(plan.manifest, events, approval(plan, ['part-1']));
  assert.equal(accepted.accepted, true);
  assert.equal(Object.hasOwn(accepted.scope, 'authorization'), false);
  assert.deepEqual({ state, packet }, before);
  packet.authorization.status = 'pending';
  assert.throws(() => transition({ snapshot: state, packet, event: 'prepare', work_type: packet.work_type }), /authorization/);
  packet.authorization.status = 'granted';
  const prepared = transition({ snapshot: state, packet, event: 'prepare', work_type: packet.work_type });
  const running = transition({ snapshot: prepared.snapshot, packet, event: 'start', work_type: packet.work_type,
    preflight: json('../examples/preflight.json') });
  assert.equal(checkSideEffect(packet, running.snapshot, { action: 'production_modify', target: 'production' }).allowed, false);
});

test('J: incomplete long Brief stays draft even with legacy deliveryComplete=true; short Brief needs no manifest', () => {
  const args = { sections: briefSections('x'.repeat(1400)), discovery: { readiness: 'ready' }, deliveryComplete: true };
  const brief = createProductBrief(args);
  assert.equal(brief.status, 'draft'); assert.equal(brief.decision_ready, false);
  assert.ok(brief.delivery.manifest);
  const plan = brief.delivery;
  const partial = createProductBrief({ ...args, delivery: { manifest: plan.manifest, events: receipts(plan, plan.emissions.slice(0, 3)) } });
  assert.equal(partial.status, 'draft'); assert.equal(partial.decision_ready, false);
  const done = createProductBrief({ ...args, delivery: { manifest: plan.manifest, events: [...receipts(plan), completion(plan)] } });
  assert.equal(done.status, 'ready'); assert.equal(done.decision_ready, true);
  const short = createProductBrief({ sections: briefSections('short'), discovery: { readiness: 'ready' }, deliveryComplete: true });
  assert.equal(short.status, 'ready'); assert.equal(short.delivery.manifest, null);
});

test('J: unrelated, damaged or stale delivery evidence cannot ready the current Brief', () => {
  const args = { sections: briefSections('x'.repeat(1400)), discovery: { readiness: 'ready' }, deliveryComplete: true };
  const plan = incident();
  assert.equal(createProductBrief({ ...args, delivery: { manifest: plan.manifest, events: [...receipts(plan), completion(plan)] } }).status, 'draft');
  assert.equal(createProductBrief({ ...args, delivery: { manifest: { broken: true }, events: [] } }).status, 'draft');
  const brief = createProductBrief(args); const actual = brief.delivery;
  const changed = createProductBrief({ ...args, sections: { ...args.sections, problem: 'Changed ' + args.sections.problem },
    delivery: { manifest: actual.manifest, events: [...receipts(actual), completion(actual)] } });
  assert.equal(changed.status, 'draft');
  const emitted = createProductBrief({ ...args, delivery: { manifest: actual.manifest,
    events: [...receipts(actual, actual.emissions, 'delivered', 'emission'), completion(actual, undefined, 'emission')] } });
  assert.equal(emitted.status, 'draft', 'unknown UI visibility is insufficient for confirmed Brief decisions');
});

test('K: compact Router recommendation creates no manifest; explicit long explanation can opt in', () => {
  const recommendation = recommendRouting({ binding: { kind: 'draft', project_id: 'p', input_digest: resultDigest('input') },
    basis: { scope_digest: resultDigest('scope'), task_digest: resultDigest('task'), runtime_capability_digest: null,
      registry_evidence_digest: null, policy_digest: null },
    profile: { reasoning_complexity: 'LOW', context_load: 'LOW', ambiguity: 'LOW', failure_cost: 'LOW',
      verifiability: 'HIGH', change_surface: 'LOW', prior_evidence: 'HIGH' }, checkpoint: 'pre_execution' });
  const before = structuredClone(recommendation);
  assert.equal(prepareRoutingExplanation({ recommendation }).delivery.manifest, null);
  assert.equal(prepareRoutingExplanation({ recommendation, sections: sections(160) }).delivery.manifest, null);
  assert.ok(prepareRoutingExplanation({ recommendation, extended: true, sections: sections(160) }).delivery.manifest);
  assert.equal(prepareRoutingExplanation({ recommendation, extended: true, sections: sections(2) }).delivery.manifest, null);
  assert.deepEqual(recommendation, before);
});

test('L: missing/corrupt manifest isolates recovery failure from old schema-2 projects and migration', () => {
  const state = json('../examples/project-state.json'); const packet = json('../examples/execution-packet.json');
  const before = structuredClone(state); const identity = packetIdentity(packet);
  for (const manifest of [null, { broken: true }, { ...incident().manifest, version: 2 }]) {
    const result = inspectDelivery(manifest, []);
    assert.equal(result.available, false); assert.equal(result.complete, false);
    assert.equal(resumeDelivery(manifest, []).action, 'rebuild_delivery_plan');
    assert.doesNotThrow(() => validateSnapshot(state)); assert.doesNotThrow(() => validateExecution(packet, state));
  }
  assert.deepEqual(state, before); assert.deepEqual(packetIdentity(packet), identity);
  const migration = json('../examples/migration-request.json');
  assert.equal(migrateSnapshot(migration).status, 'migrated');
});

test('M: delivery is deterministic local composition with no network/model/watcher/tokenizer or usage estimates', () => {
  const before = sections(160); const frozen = structuredClone(before);
  assert.deepEqual(incident({ sections: before }), incident({ sections: before })); assert.deepEqual(before, frozen);
  const module = readFileSync(new URL('../scripts/delivery-manifest.mjs', import.meta.url), 'utf8');
  const imports = [...module.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.deepEqual(imports, ['./contracts.mjs']);
  assert.doesNotMatch(module, /\b(fetch|setInterval|watch|tokenizer|spawn|exec|https?)\s*\(/);
  assert.doesNotMatch(JSON.stringify(incident().manifest), /usage|token|model_call|quota/);
  assert.equal(DEFAULT_DELIVERY_POLICY.heuristic, 'characters_and_sections');
});

test('contract rejects extra fields, duplicate ids, invalid budgets, digests and unsupported versions', () => {
  const plan = incident();
  for (const mutate of [m => { m.version = 2; }, m => { m.authorization = true; },
    m => { m.parts[1].id = m.parts[0].id; }, m => { m.parts[0].segments[0].sha256 = 'bad'; },
    m => { m.parts[0].sha256 = 'a'.repeat(64); }, m => { m.parts.pop(); },
    m => { m.policy.max_chars = -1; }]) {
    const manifest = structuredClone(plan.manifest); mutate(manifest);
    assert.throws(() => validateDeliveryManifest(manifest), /Contract violation/);
  }
  assert.throws(() => planDelivery({ sections: [{ id: 'a', content: 'a' }, { id: 'a', content: 'b' }] }), /duplicate/);
  assert.throws(() => planDelivery({ sections: sections(2), policy: { max_chars: 10, reserve_chars: 10 } }), /policy/);
});

test('content identity normalizes only line endings and detects wording changes', () => {
  const left = incident(); const right = incident({ sections: sections(160).map(s => ({ ...s, content: s.content.replaceAll('\n', '\r\n') })) });
  assert.equal(left.manifest.digest, right.manifest.digest);
  assert.deepEqual(left.manifest.parts, right.manifest.parts);
  const changed = sections(160); changed[0].content += ' ';
  assert.notEqual(incident({ sections: changed }).manifest.digest, left.manifest.digest);
});

test('bad content, segment marker, stale identity and model self-claims cannot confirm a segment', () => {
  const plan = incident(); const valid = receipt(plan, plan.emissions[0]);
  for (const event of [{ ...valid, content: 'wrong' }, { ...valid, marker: 'I emitted it' },
    { ...valid, artifact_revision: 2 }, { ...valid, source: 'model' }, { ...valid, source: 'emission' }]) {
    const result = inspectDelivery(plan.manifest, [event]);
    assert.equal(result.complete, false); assert.equal(result.available, false);
  }
});

test('JSON snapshot round trip preserves recovery and receipt validation without persistence writes', () => {
  const plan = incident(); const events = receipts(plan, plan.emissions.slice(0, 60));
  const saved = JSON.parse(JSON.stringify({ manifest: plan.manifest, events }));
  assert.deepEqual(resumeDelivery(saved.manifest, saved.events), resumeDelivery(plan.manifest, events));
  assert.equal(Object.hasOwn(saved.manifest, 'project_state'), false);
});

test('heuristic budget reserves actual segment markers in addition to final/header allowance', () => {
  const plan = planDelivery({ artifact_id: 'budget', sections: sections(25).map(s => ({ ...s, content: 'x'.repeat(400) })),
    policy: { max_chars: 1600, reserve_chars: 512 } });
  for (const part of plan.manifest.parts) {
    const actualSize = plan.emissions.filter(e => e.part_id === part.id)
      .reduce((size, e) => size + e.content.length + e.marker.length + 2, 0);
    assert.ok(actualSize + plan.manifest.policy.reserve_chars <= plan.manifest.policy.max_chars);
  }
});

test('host confirmation is content receipt, not user content approval; malformed evidence remains isolated', () => {
  const plan = incident(); const events = [...receipts(plan, plan.emissions, 'confirmed', 'host'), completion(plan, undefined, 'host')];
  assert.equal(inspectDelivery(plan.manifest, events).complete, true);
  assert.equal(Object.hasOwn(inspectDelivery(plan.manifest, events), 'approved'), false);
  const conflict = { ...events[0], content: 'different', evidence_ref: events[0].evidence_ref };
  assert.equal(inspectDelivery(plan.manifest, [...events, conflict]).available, false);
  assert.throws(() => approveDelivery(plan.manifest, events, { ...approval(plan, ['part-1']), source_kind: 'model' }), /source_kind/);
});

test('short fast path remains below both thresholds and threshold equality opts into planning', () => {
  assert.equal(planDelivery({ sections: sections(23) }).manifest, null);
  assert.ok(planDelivery({ artifact_id: 'count', sections: sections(24) }).manifest);
  assert.ok(planDelivery({ artifact_id: 'size', sections: [{ id: 'one', content: 'x'.repeat(12000) }] }).manifest);
});
