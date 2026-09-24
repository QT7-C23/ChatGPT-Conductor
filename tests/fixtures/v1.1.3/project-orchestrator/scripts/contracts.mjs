import { isDeepStrictEqual } from 'node:util';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const rules = JSON.parse(readFileSync(new URL('../contracts/routing.json', import.meta.url), 'utf8'));
export const identityKeys = ['project_id', 'task_id', 'packet_id', 'packet_revision', 'decision_version', 'executor', 'lifecycle'];
export const packetLink = p => Object.fromEntries(identityKeys.map(key => [key, p[key]]));
export function requireThat(ok, field) {
  if (!ok) throw new Error(`Contract violation: ${field}`);
}
export function object(value, keys, field) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  requireThat(Object.keys(value).every(k => keys.includes(k)), `${field}: unexpected field`);
  for (const key of keys) requireThat(Object.hasOwn(value, key), `${field}.${key}: required`);
}
function objectWithOptional(value, keys, optional, field) {
  object(value, [...keys, ...optional.filter(key => value != null && Object.hasOwn(value, key))], field);
}
export function text(value, field) { requireThat(typeof value === 'string' && value.trim().length > 0, field); }
function integer(value, field) { requireThat(Number.isSafeInteger(value) && value > 0, field); }
function oneOf(value, values, field) { requireThat(values.includes(value), field); }
function list(value, field, validate, minimum = 0) {
  requireThat(Array.isArray(value) && value.length >= minimum, field);
  value.forEach((item, i) => validate(item, `${field}[${i}]`));
}
function unique(items, key, field) {
  requireThat(new Set(items.map(x => x[key])).size === items.length, `${field}: duplicate ${key}`);
}
function texts(value, field, minimum = 0) { list(value, field, text, minimum); }
function records(value, keys, field, minimum = 0) {
  list(value, field, (item, name) => {
    object(item, keys, name);
    for (const key of keys) text(item[key], `${name}.${key}`);
  }, minimum);
}
function equal(actual, expected, field) { requireThat(isDeepStrictEqual(actual, expected), field); }
function identity(value, expected, field) {
  for (const key of ['project_id', 'task_id', 'packet_id']) text(value[key], `${field}.${key}`);
  for (const key of ['packet_revision', 'decision_version', 'lifecycle']) integer(value[key], `${field}.${key}`);
  oneOf(value.executor, ['WORK', 'CODEX'], `${field}.executor`);
  if (expected) for (const key of identityKeys) equal(value[key], expected[key], `${field}.${key}`);
}
export function trustedSource(kind) { oneOf(kind, ['user_instruction', 'user_delegation'], 'authorization.source_kind'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
}
export const resultDigest = result => createHash('sha256').update(JSON.stringify(canonical(result))).digest('hex');
const boundaryKeys = ['executor', 'work_type', 'goal', 'scope', 'inputs', 'deliverables', 'acceptance', 'authorization', 'dependencies', 'required_capabilities', 'side_effects'];
export const boundaryDigest = packet => resultDigest(Object.fromEntries(boundaryKeys.map(key => [key, packet[key]])));
function digest(value, field) { requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), field); }
export function packetIdentity(packet) {
  return {
    packet_id: packet.packet_id, packet_revision: packet.packet_revision, task_id: packet.task_id,
    content_sha256: createHash('sha256').update(JSON.stringify(canonical(packet))).digest('hex'),
    decision_version: packet.decision_version,
    locked_decisions_sha256: lockedDigest(packet.locked_decisions),
    lifecycle: packet.lifecycle,
    boundary_sha256: boundaryDigest(packet),
  };
}
export function lockedDigest(decisions) {
  const ordered = [...decisions].sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(canonical(ordered))).digest('hex');
}
export function validatePacketRevision(packet, active) {
  if (active === null) return;
  requireThat(packet.lifecycle >= active.lifecycle, 'packet.lifecycle: stale');
  if (packet.lifecycle > active.lifecycle && packet.packet_id !== active.packet_id) {
    requireThat(packet.task_id !== active.task_id, 'new task requires a new task_id');
    equal(packet.packet_revision, 1, 'new packet_revision must start at 1');
  } else {
    equal(packet.packet_id, active.packet_id, 'active_packet.packet_id');
    equal(packet.task_id, active.task_id, 'active_packet.task_id');
    equal(packet.packet_revision, active.packet_revision + 1, 'packet_revision: next revision required');
  }
  const changed = lockedDigest(packet.locked_decisions) !== active.locked_decisions_sha256;
  equal(packet.decision_version, active.decision_version + Number(changed), 'decision_version: must track actual locked changes');
}
function locked(value) {
  records(value, ['id', 'decision', 'rationale', 'approval_ref'], 'locked_decisions');
  unique(value, 'id', 'locked_decisions');
}
function open(value) {
  list(value, 'open_decisions', (d, field) => {
    object(d, ['id', 'question', 'owner', 'blocking'], field);
    text(d.id, `${field}.id`); text(d.question, `${field}.question`);
    oneOf(d.owner, ['EXECUTOR', 'CHAT', 'USER'], `${field}.owner`);
    requireThat(typeof d.blocking === 'boolean', `${field}.blocking`);
  });
  unique(value, 'id', 'open_decisions');
}

export function validateSnapshot(s) {
  object(s, ['schema_version', 'project_id', 'revision', 'state', 'decision_version', 'locked_decisions', 'open_decisions', 'active_packet', 'escalations', 'review_record', 'result_sha256', 'lifecycle', 'revision_reviews', 'plan_approvals', 'migration_record'], 'snapshot');
  equal(s.schema_version, 2, 'schema_version: V1.1 requires schema 2; migrate old data explicitly');
  text(s.project_id, 'project_id'); integer(s.revision, 'revision'); integer(s.decision_version, 'decision_version');
  integer(s.lifecycle, 'snapshot.lifecycle: V1.1.1 requires explicit migration of older snapshots');
  oneOf(s.state, rules.states, 'state'); locked(s.locked_decisions); open(s.open_decisions);
  unique([...s.locked_decisions, ...s.open_decisions], 'id', 'decision IDs');
  if (s.active_packet !== null) {
    object(s.active_packet, ['packet_id', 'packet_revision', 'task_id', 'content_sha256', 'decision_version', 'locked_decisions_sha256', 'lifecycle', 'boundary_sha256'], 'active_packet');
    text(s.active_packet.packet_id, 'active_packet.packet_id');
    text(s.active_packet.task_id, 'active_packet.task_id');
    integer(s.active_packet.packet_revision, 'active_packet.packet_revision');
    integer(s.active_packet.lifecycle, 'active_packet.lifecycle');
    digest(s.active_packet.boundary_sha256, 'active_packet.boundary_sha256');
    requireThat(s.active_packet.lifecycle <= s.lifecycle, 'active_packet.lifecycle: future baseline');
    if (s.active_packet.lifecycle !== s.lifecycle) requireThat(['DISCUSS', 'PLAN'].includes(s.state), 'active_packet.lifecycle: stale baseline cannot execute');
    requireThat(typeof s.active_packet.content_sha256 === 'string' && /^[a-f0-9]{64}$/.test(s.active_packet.content_sha256), 'active_packet.content_sha256');
    integer(s.active_packet.decision_version, 'active_packet.decision_version');
    requireThat(typeof s.active_packet.locked_decisions_sha256 === 'string' && /^[a-f0-9]{64}$/.test(s.active_packet.locked_decisions_sha256), 'active_packet.locked_decisions_sha256');
  }
  list(s.escalations, 'escalations', (entry, field) => {
    object(entry, ['challenge', 'resolution_ref'], field);
    validateChallenge(entry.challenge);
    equal(entry.challenge.project_id, s.project_id, `${field}.challenge.project_id`);
    if (entry.resolution_ref !== null) text(entry.resolution_ref, `${field}.resolution_ref`);
  });
  if (['READY_TO_EXECUTE', 'EXECUTE', 'REVIEW', 'REVISE', 'COMPLETE'].includes(s.state)) {
    requireThat(s.active_packet !== null, 'active_packet required for active/completed task');
  }
  if (s.review_record !== null) {
    reviewShape(s.review_record);
    equal(s.review_record.project_id, s.project_id, 'review_record.project_id');
    requireThat(s.active_packet !== null, 'review_record requires active_packet');
    for (const key of ['packet_id', 'task_id', 'packet_revision', 'decision_version', 'lifecycle']) equal(s.review_record[key], s.active_packet[key], `review_record.${key}`);
    equal(s.review_record.result_sha256, s.result_sha256, 'review_record.result_sha256');
  }
  if (s.state === 'COMPLETE') requireThat(s.review_record?.verdict === 'ACCEPT', 'COMPLETE requires Chat Review ACCEPT');
  if (s.result_sha256 !== null) requireThat(typeof s.result_sha256 === 'string' && /^[a-f0-9]{64}$/.test(s.result_sha256), 'result_sha256');
  if (['REVIEW', 'REVISE', 'COMPLETE'].includes(s.state)) requireThat(s.result_sha256 !== null, 'result_sha256 required for review');
  list(s.revision_reviews, 'revision_reviews', (review, field) => {
    reviewShape(review); oneOf(review.verdict, ['REVISE', 'ESCALATE'], field + '.verdict');
    if (review.verdict === 'ESCALATE') requireThat(review.revision_instructions.length > 0 && Object.hasOwn(review, 'inherited_requirement'), field + ': retained ESCALATE requires instructions and inherited context');
    equal(review.project_id, s.project_id, field + '.project_id');
    requireThat(s.active_packet !== null && review.lifecycle === s.active_packet.lifecycle && review.packet_id === s.active_packet.packet_id && review.task_id === s.active_packet.task_id && review.packet_revision <= s.active_packet.packet_revision, field + ': stale revision history');
  });
  unique(s.revision_reviews.filter(r => r.verdict === 'REVISE'), 'review_id', 'revision_reviews');
  const reviewIdentities = s.revision_reviews.map(r => JSON.stringify([r.review_id, ...identityKeys.map(k => r[k])]));
  requireThat(new Set(reviewIdentities).size === reviewIdentities.length, 'revision_reviews: duplicate review identity');
  let previousRevise = null;
  s.revision_reviews.forEach((review, i) => {
    if (review.verdict === 'REVISE') {
      equal(review.supersedes_review_id, previousRevise, 'revision_reviews.supersedes_review_id');
      previousRevise = review.review_id;
    }
    if (i) requireThat(review.packet_revision > s.revision_reviews[i - 1].packet_revision, 'revision_reviews.packet_revision');
  });
  if (s.state === 'REVISE') equal(s.review_record, s.revision_reviews.at(-1), 'REVISE requires retained revision review');
  list(s.plan_approvals, 'plan_approvals', approval => {
    planApprovalShape(approval);
    requireThat(approval.lifecycle === s.lifecycle || approval.lifecycle === s.active_packet?.lifecycle, 'plan_approvals.lifecycle');
    requireThat(approval.state_revision < s.revision, 'plan_approvals.state_revision');
    if (approval.replaces_review_id !== null) requireThat(s.revision_reviews.some(r => r.review_id === approval.replaces_review_id), 'plan_approvals.replaces_review_id');
    if (approval.kind === 'execution') equal(approval.project_id, s.project_id, 'execution_approval.project_id');
  });
  unique(s.plan_approvals.filter(a => a.kind === 'execution'), 'approval_id', 'execution_approvals');
  if (s.migration_record !== null) {
    object(s.migration_record, ['source_schema', 'source_state', 'source_sha256', 'packet_sha256', 'result_sha256', 'review_sha256', 'source_kind', 'approval_ref', 'evidence_ref', 'authorization_inherited', 'target_lifecycle', 'pending_revision_instructions'], 'migration_record');
    oneOf(s.migration_record.source_schema, [1, 2], 'migration_record.source_schema');
    oneOf(s.migration_record.source_state, rules.states, 'migration_record.source_state');
    for (const key of ['source_sha256', 'packet_sha256', 'result_sha256', 'review_sha256']) if (key === 'source_sha256' || s.migration_record[key] !== null) digest(s.migration_record[key], 'migration_record.' + key);
    trustedSource(s.migration_record.source_kind); text(s.migration_record.approval_ref, 'migration_record.approval_ref'); text(s.migration_record.evidence_ref, 'migration_record.evidence_ref');
    equal(s.migration_record.authorization_inherited, false, 'migration_record.authorization_inherited');
    integer(s.migration_record.target_lifecycle, 'migration_record.target_lifecycle');
    requireThat(s.migration_record.target_lifecycle <= s.lifecycle, 'migration_record.target_lifecycle');
    texts(s.migration_record.pending_revision_instructions, 'migration_record.pending_revision_instructions');
    if (s.state === 'COMPLETE') requireThat(s.plan_approvals.some(a => a.kind === 'execution' && a.lifecycle === s.lifecycle && a.to_packet_sha256 === s.active_packet.content_sha256), 'COMPLETE requires current execution_approval');
  }
  return s;
}

/** Chat applies an actual user decision; project data never acquires authority here. */
export function applyDecisionUpdate(snapshot, update) {
  validateSnapshot(snapshot);
  object(update, ['locked_decisions', 'open_decisions', 'source_kind', 'approval_ref'], 'decision_update');
  trustedSource(update.source_kind); text(update.approval_ref, 'decision_update.approval_ref');
  requireThat(['DISCUSS', 'PLAN'].includes(snapshot.state), 'decision_update: return to PLAN first');
  locked(update.locked_decisions); open(update.open_decisions);
  const changed = lockedDigest(snapshot.locked_decisions) !== lockedDigest(update.locked_decisions);
  if (changed && snapshot.active_packet !== null) {
    requireThat(snapshot.decision_version === snapshot.active_packet.decision_version,
      'decision_update: publish pending locked revision before another change');
  }
  const next = structuredClone(snapshot);
  next.decision_version += Number(changed);
  next.locked_decisions = structuredClone(update.locked_decisions);
  next.open_decisions = structuredClone(update.open_decisions);
  next.revision++;
  validateSnapshot(next);
  return next;
}

export function validateExecution(p, s) {
  validateSnapshot(s);
  object(p, ['schema_version', 'project_id', 'task_id', 'packet_id', 'packet_revision', 'decision_version', 'executor', 'work_type', 'goal', 'scope', 'inputs', 'deliverables', 'acceptance', 'locked_decisions', 'open_decisions', 'authorization', 'dependencies', 'required_capabilities', 'known_capabilities', 'capability_preflight_required', 'revision_instructions', 'side_effects', 'lifecycle'], 'packet');
  equal(p.schema_version, 2, 'packet.schema_version');
  for (const key of ['project_id', 'task_id', 'packet_id', 'goal']) text(p[key], `packet.${key}`);
  integer(p.packet_revision, 'packet.packet_revision');
  equal(p.project_id, s.project_id, 'packet.project_id');
  equal(p.lifecycle, s.lifecycle, 'packet.lifecycle: stale lifecycle');
  equal(p.decision_version, s.decision_version, 'packet.decision_version');
  oneOf(p.work_type, ['general', 'code'], 'packet.work_type');
  equal(p.executor, rules.work_types[p.work_type], 'packet.executor');
  locked(p.locked_decisions); open(p.open_decisions);
  equal(p.locked_decisions, s.locked_decisions, 'packet.locked_decisions: silent override');
  equal(p.open_decisions, s.open_decisions, 'packet.open_decisions');
  object(p.scope, ['in', 'out'], 'scope');
  texts(p.scope.in, 'scope.in', 1); texts(p.scope.out, 'scope.out');
  list(p.inputs, 'inputs', (item, field) => {
    object(item, ['ref', 'description', 'available'], field);
    text(item.ref, `${field}.ref`); text(item.description, `${field}.description`);
    requireThat(typeof item.available === 'boolean', `${field}.available`);
  });
  records(p.deliverables, ['id', 'description'], 'deliverables', 1);
  records(p.acceptance, ['id', 'criterion', 'verify'], 'acceptance', 1);
  unique(p.deliverables, 'id', 'deliverables'); unique(p.acceptance, 'id', 'acceptance');
  object(p.authorization, ['status', 'source', 'source_kind'], 'authorization');
  oneOf(p.authorization.status, ['granted', 'pending'], 'authorization.status');
  text(p.authorization.source, 'authorization.source');
  trustedSource(p.authorization.source_kind);
  list(p.dependencies, 'dependencies', (d, field) => {
    object(d, ['task_id', 'status'], field); text(d.task_id, `${field}.task_id`);
    oneOf(d.status, ['complete', 'pending'], `${field}.status`);
    requireThat(d.task_id !== p.task_id, `${field}: self dependency`);
  });
  unique(p.dependencies, 'task_id', 'dependencies');
  texts(p.required_capabilities, 'required_capabilities');
  texts(p.known_capabilities, 'known_capabilities');
  for (const key of ['required_capabilities', 'known_capabilities']) requireThat(new Set(p[key]).size === p[key].length, `${key}: duplicate`);
  requireThat(typeof p.capability_preflight_required === 'boolean', 'capability_preflight_required');
  texts(p.revision_instructions, 'revision_instructions');
  validateSideEffects(p.side_effects);
  return p;
}

export function validateReady(p, s) {
  validateExecution(p, s);
  validateExecutionApproval(p, s);
  requireThat(s.escalations.every(e => !e.challenge.blocking || e.resolution_ref !== null), 'challenge: resolution required');
  requireThat(p.authorization.status === 'granted', 'authorization: execution not granted');
  requireThat(!p.open_decisions.some(d => d.blocking), 'open_decisions: blocking question');
  requireThat(p.inputs.every(i => i.available), 'inputs: unavailable material');
  requireThat(p.dependencies.every(d => d.status === 'complete'), 'dependencies: unfinished task');
  requireThat(p.capability_preflight_required || p.required_capabilities.every(c => p.known_capabilities.includes(c)), 'capabilities: unknown capabilities require preflight');
}

export function validateChallenge(c, p) {
  object(c, [...identityKeys, 'blocking', 'decision_id', 'reason', 'evidence', 'proposal', 'impact', 'affected_tasks'], 'challenge');
  identity(c, p, 'challenge');
  requireThat(typeof c.blocking === 'boolean', 'challenge.blocking');
  for (const key of ['decision_id', 'reason', 'evidence', 'proposal', 'impact']) text(c[key], `challenge.${key}`);
  texts(c.affected_tasks, 'challenge.affected_tasks', 1);
  requireThat(c.affected_tasks.includes(c.task_id), 'challenge.affected_tasks must include task_id');
  if (p) requireThat(p.locked_decisions.some(d => d.id === c.decision_id) || c.decision_id === 'SCOPE', 'challenge.decision_id');
}

export function validateResult(r, p) {
  object(r, ['schema_version', ...identityKeys, 'status', 'summary', 'locked_decisions', 'open_decisions_resolved', 'artifacts', 'checks', 'challenges', 'limitations', 'capability_preflight', 'missing_capabilities', 'recovery_conditions', 'side_effects_performed'], 'result');
  equal(r.schema_version, 2, 'result.schema_version');
  for (const key of [...identityKeys, 'locked_decisions']) {
    equal(r[key], p[key], `result.${key}: does not match packet`);
  }
  oneOf(r.status, ['succeeded', 'partial', 'blocked'], 'result.status');
  text(r.summary, 'result.summary');
  records(r.open_decisions_resolved, ['id', 'choice', 'rationale'], 'open_decisions_resolved');
  unique(r.open_decisions_resolved, 'id', 'open_decisions_resolved');
  for (const decision of r.open_decisions_resolved) {
    requireThat(p.open_decisions.some(d => d.id === decision.id && d.owner === 'EXECUTOR'), 'open_decisions_resolved.owner');
  }
  records(r.artifacts, ['id', 'ref', 'description'], 'artifacts');
  unique(r.artifacts, 'id', 'artifacts');
  for (const a of r.artifacts) requireThat(p.deliverables.some(d => d.id === a.id), 'artifacts.id');
  records(r.checks, ['criterion_id', 'status', 'evidence'], 'checks');
  unique(r.checks, 'criterion_id', 'checks');
  for (const c of r.checks) {
    oneOf(c.status, ['passed', 'failed', 'not_run'], 'checks.status');
    requireThat(p.acceptance.some(a => a.id === c.criterion_id), 'checks.criterion_id');
  }
  requireThat(p.acceptance.every(a => r.checks.some(c => c.criterion_id === a.id)), 'checks: missing criterion');
  list(r.challenges, 'challenges', c => validateChallenge(c, p));
  texts(r.limitations, 'limitations');
  const missing = validatePreflight(r.capability_preflight, p);
  texts(r.missing_capabilities, 'missing_capabilities'); texts(r.recovery_conditions, 'recovery_conditions');
  equal([...r.missing_capabilities].sort(), [...missing].sort(), 'missing_capabilities must match preflight');
  if (missing.length > 0) requireThat(r.status !== 'succeeded' && r.recovery_conditions.length > 0, 'missing_capabilities: cannot succeed; recovery conditions required');
  records(r.side_effects_performed, ['action', 'target', 'evidence'], 'side_effects_performed');
  for (const effect of r.side_effects_performed) requireThat(effectPermission(p.side_effects, effect).allowed, 'side_effects_performed: unauthorized effect');
  if (r.status === 'succeeded') {
    requireThat(p.deliverables.every(d => r.artifacts.some(a => a.id === d.id)), 'artifacts: missing deliverable');
    requireThat(r.checks.every(c => c.status === 'passed') && !r.challenges.some(c => c.blocking), 'result.status: incomplete success');
  }
  return r;
}

function reviewShape(review) {
  objectWithOptional(review, ['schema_version', 'review_id', ...identityKeys, 'reviewer', 'acceptance_results', 'locked_decision_compliance', 'verdict', 'revision_instructions', 'evidence', 'result_sha256', 'supersedes_review_id'], ['supersedes_requirement_id', 'inherited_requirement'], 'review');
  equal(review.schema_version, 2, 'review.schema_version');
  text(review.review_id, 'review.review_id'); identity(review, null, 'review');
  digest(review.result_sha256, 'review.result_sha256');
  if (review.supersedes_review_id !== null) text(review.supersedes_review_id, 'review.supersedes_review_id');
  if (review.verdict !== 'REVISE') equal(review.supersedes_review_id, null, 'review.supersedes_review_id only applies to REVISE');
  if (Object.hasOwn(review, 'supersedes_requirement_id')) {
    text(review.supersedes_requirement_id, 'review.supersedes_requirement_id');
    equal(review.verdict, 'REVISE', 'review.supersedes_requirement_id only applies to REVISE');
  }
  if (Object.hasOwn(review, 'inherited_requirement')) {
    equal(review.verdict, 'ESCALATE', 'review.inherited_requirement only applies to retained ESCALATE');
    const inherited = review.inherited_requirement;
    if (inherited !== null) {
      object(inherited, ['id', 'source', 'lifecycle', 'instructions'], 'review.inherited_requirement');
      text(inherited.id, 'review.inherited_requirement.id');
      oneOf(inherited.source, ['review', 'plan', 'migration'], 'review.inherited_requirement.source');
      equal(inherited.lifecycle, review.lifecycle, 'review.inherited_requirement.lifecycle');
      texts(inherited.instructions, 'review.inherited_requirement.instructions');
    }
  }
  equal(review.reviewer, 'CHAT', 'review.reviewer');
  oneOf(review.verdict, ['ACCEPT', 'REVISE', 'ESCALATE'], 'review.verdict');
  records(review.acceptance_results, ['criterion_id', 'status', 'evidence'], 'review.acceptance_results', 1);
  records(review.locked_decision_compliance, ['decision_id', 'status', 'evidence'], 'review.locked_decision_compliance');
  unique(review.acceptance_results, 'criterion_id', 'review.acceptance_results');
  unique(review.locked_decision_compliance, 'decision_id', 'review.locked_decision_compliance');
  for (const c of review.acceptance_results) oneOf(c.status, ['passed', 'failed', 'not_run'], 'review.acceptance_results.status');
  for (const c of review.locked_decision_compliance) oneOf(c.status, ['compliant', 'violated', 'not_checked'], 'review.locked_decision_compliance.status');
  texts(review.revision_instructions, 'review.revision_instructions');
  if (review.verdict === 'REVISE') requireThat(review.revision_instructions.length > 0, 'review.revision_instructions required');
  if (review.verdict === 'ACCEPT') {
    requireThat(review.acceptance_results.every(c => c.status === 'passed') && review.locked_decision_compliance.every(c => c.status === 'compliant'), 'review.ACCEPT requires all evidence passing');
    requireThat(review.revision_instructions.length === 0, 'review.ACCEPT cannot request revision');
  }
  text(review.evidence, 'review.evidence');
}
export function validateReview(review, packet, result) {
  reviewShape(review);
  requireThat(!Object.hasOwn(review, 'inherited_requirement'), 'review.inherited_requirement: derived by router, not an input field');
  identity(review, packet, 'review');
  equal(review.result_sha256, resultDigest(result), 'review.result_sha256: stale or changed result digest');
  equal(review.acceptance_results.map(c => c.criterion_id).sort(), packet.acceptance.map(c => c.id).sort(), 'review.acceptance_results: cover all criteria');
  equal(review.locked_decision_compliance.map(c => c.decision_id).sort(), packet.locked_decisions.map(c => c.id).sort(), 'review.locked_decision_compliance: cover all locks');
  if (review.verdict === 'ACCEPT') requireThat(result.status === 'succeeded' && !result.challenges.some(c => c.blocking), 'complete: result not accepted');
  return review;
}

const approvalKeys = ['reviewer', 'source_kind', 'approval_ref', 'from_packet_sha256', 'to_packet_sha256', 'replaces_review_id'];
function approvalShape(approval) {
  equal(approval.reviewer, 'CHAT', 'plan_approval.reviewer'); trustedSource(approval.source_kind);
  text(approval.approval_ref, 'plan_approval.approval_ref');
  if (approval.from_packet_sha256 !== null) digest(approval.from_packet_sha256, 'plan_approval.from_packet_sha256');
  digest(approval.to_packet_sha256, 'plan_approval.to_packet_sha256');
  if (approval.replaces_review_id !== null) text(approval.replaces_review_id, 'plan_approval.replaces_review_id');
  if (Object.hasOwn(approval, 'replaces_requirement_id')) {
    text(approval.replaces_requirement_id, 'plan_approval.replaces_requirement_id');
    equal(approval.replaces_review_id, null, 'plan_approval: use one requirement reference');
  }
}
function planApprovalShape(approval) {
  const execution = Object.hasOwn(approval, 'kind');
  objectWithOptional(approval, [...approvalKeys, 'state_revision', 'lifecycle', 'revision_instructions', ...(execution ? ['kind', 'approval_id', ...identityKeys.filter(k => k !== 'lifecycle')] : [])], ['replaces_requirement_id'], 'plan_approval');
  approvalShape(approval); integer(approval.state_revision, 'plan_approval.state_revision'); integer(approval.lifecycle, 'plan_approval.lifecycle');
  texts(approval.revision_instructions, 'plan_approval.revision_instructions');
  if (execution) { equal(approval.kind, 'execution', 'plan_approval.kind'); text(approval.approval_id, 'execution_approval.approval_id'); identity(approval, null, 'execution_approval'); }
}
const replacementId = approval => approval.replaces_requirement_id ?? (approval.replaces_review_id === null ? null : 'review:' + approval.replaces_review_id);
function rawReview(review) {
  const { inherited_requirement, ...raw } = review;
  return raw;
}
/** Also promotes a still-live V1.1.2 ESCALATE into the same retained history. */
export function revisionReviews(snapshot) {
  const review = snapshot.review_record;
  if (review?.lifecycle !== snapshot.lifecycle || review.verdict !== 'ESCALATE' || review.revision_instructions.length === 0 || snapshot.revision_reviews.some(r => isDeepStrictEqual(rawReview(r), review))) return snapshot.revision_reviews;
  const inherited = currentRevisionRequirement({ ...snapshot, review_record: null });
  return [...snapshot.revision_reviews, { ...structuredClone(review), inherited_requirement: structuredClone(inherited) }];
}
/** Current requirements are derived from retained Chat receipts, not packet omissions. */
export function currentRevisionRequirement(snapshot) {
  if (snapshot.review_record?.lifecycle === snapshot.lifecycle && snapshot.review_record.verdict === 'ACCEPT') return null;
  const reviews = revisionReviews(snapshot);
  const review = reviews.findLast(r => r.lifecycle === snapshot.lifecycle);
  const migration = snapshot.migration_record;
  const instructions = review?.verdict === 'ESCALATE' ? [...new Set([...(review.inherited_requirement?.instructions ?? []), ...review.revision_instructions])] : review?.revision_instructions;
  const reviewId = review && (review.verdict === 'ESCALATE' ? 'review-esc:' + resultDigest(rawReview(review)) : 'review:' + review.review_id);
  let current = review ? { id: reviewId, source: 'review', lifecycle: review.lifecycle, instructions }
    : migration?.target_lifecycle === snapshot.lifecycle && migration.pending_revision_instructions.length > 0
      ? { id: 'migration:' + migration.source_sha256, source: 'migration', lifecycle: snapshot.lifecycle, instructions: migration.pending_revision_instructions } : null;
  for (const approval of snapshot.plan_approvals.filter(a => a.lifecycle === snapshot.lifecycle)) {
    const replaces = replacementId(approval);
    if ((replaces !== null && replaces === current?.id) || (current === null && replaces === null && approval.revision_instructions.length > 0)) {
      current = { id: 'plan:' + resultDigest(approval), source: 'plan', lifecycle: approval.lifecycle, instructions: approval.revision_instructions };
    }
  }
  return current;
}
export function currentRevisionInstructions(snapshot) {
  return currentRevisionRequirement(snapshot)?.instructions ?? null;
}
export function hasPlanApproval(snapshot, packet) {
  const approval = snapshot.plan_approvals.at(-1);
  return snapshot.state === 'PLAN' && approval?.lifecycle === snapshot.lifecycle && approval.from_packet_sha256 === (snapshot.active_packet?.content_sha256 ?? null) && approval.to_packet_sha256 === packetIdentity(packet).content_sha256;
}
export function makePlanApproval(snapshot, packet, approval, execution = false) {
  objectWithOptional(approval, [...approvalKeys, ...(execution ? ['approval_id', ...identityKeys] : [])], ['replaces_requirement_id'], 'plan_approval'); approvalShape(approval);
  if (execution) {
    requireThat(snapshot.migration_record !== null, 'reauthorize requires migrated project');
    identity(approval, packet, 'execution_approval'); text(approval.approval_id, 'execution_approval.approval_id');
    requireThat(!snapshot.plan_approvals.some(a => a.approval_id === approval.approval_id), 'execution_approval.approval_id: duplicate');
  }
  equal(approval.from_packet_sha256, snapshot.active_packet?.content_sha256 ?? null, 'plan_approval.from_packet_sha256');
  equal(approval.to_packet_sha256, packetIdentity(packet).content_sha256, 'plan_approval.to_packet_sha256');
  const required = currentRevisionRequirement(snapshot);
  if (required !== null && !isDeepStrictEqual(required.instructions, packet.revision_instructions)) {
    const pendingMigration = snapshot.migration_record?.target_lifecycle === snapshot.lifecycle && snapshot.migration_record.pending_revision_instructions.length > 0 && !revisionReviews(snapshot).some(r => r.lifecycle === snapshot.lifecycle && r.verdict === 'REVISE');
    requireThat(required.source !== 'migration' && !pendingMigration, 'migration revision_instructions need a fresh Chat Review before replacement');
    equal(replacementId(approval), required.id, 'plan_approval.replaces_requirement_id: reference current requirement');
  } else equal(replacementId(approval), null, 'plan_approval.replaces_requirement_id: no replacement');
  return { ...structuredClone(approval), ...(execution ? { kind: 'execution' } : {}), state_revision: snapshot.revision, lifecycle: snapshot.lifecycle, revision_instructions: [...packet.revision_instructions] };
}
export function hasExecutionApproval(packet, snapshot) {
  if (snapshot.migration_record === null) return true;
  return snapshot.plan_approvals.some(a => a.kind === 'execution' && identityKeys.every(k => a[k] === packet[k]) && a.to_packet_sha256 === packetIdentity(packet).content_sha256);
}
export function validateExecutionApproval(packet, snapshot) {
  requireThat(hasExecutionApproval(packet, snapshot), 'execution_approval: current lifecycle and exact packet require fresh Chat reauthorization');
}
export function validateRevisionReplacement(review, snapshot) {
  const required = currentRevisionRequirement(snapshot);
  const reference = review.supersedes_requirement_id ?? (review.supersedes_review_id === null ? null : 'review:' + review.supersedes_review_id);
  equal(reference, required?.id ?? null, 'review.supersedes_requirement_id: reference current requirement');
}

export function validatePreflight(report, packet) {
  object(report, [...identityKeys, 'checked_capabilities', 'recovery_conditions'], 'preflight');
  identity(report, packet, 'preflight');
  list(report.checked_capabilities, 'preflight.checked_capabilities', (c, field) => {
    object(c, ['capability', 'available', 'evidence'], field);
    text(c.capability, `${field}.capability`); text(c.evidence, `${field}.evidence`);
    requireThat(typeof c.available === 'boolean', `${field}.available`);
  });
  unique(report.checked_capabilities, 'capability', 'preflight.checked_capabilities');
  requireThat(packet.required_capabilities.every(cap => report.checked_capabilities.some(c => c.capability === cap)), 'preflight: must check each required capability');
  texts(report.recovery_conditions, 'preflight.recovery_conditions');
  const missing = packet.required_capabilities.filter(cap => !report.checked_capabilities.find(c => c.capability === cap).available);
  if (missing.length > 0) requireThat(report.recovery_conditions.length > 0, 'preflight.recovery_conditions required');
  return missing;
}
export function preflightBlockedResult(packet, report) {
  const missing = validatePreflight(report, packet);
  return {
    schema_version: 2, ...packetLink(packet), status: 'blocked', summary: '能力预检失败，未开始执行任务。',
    locked_decisions: structuredClone(packet.locked_decisions), open_decisions_resolved: [], artifacts: [],
    checks: packet.acceptance.map(c => ({ criterion_id: c.id, status: 'not_run', evidence: `预检缺少能力：${missing.join(', ')}` })),
    challenges: [], limitations: ['执行环境能力不足，交回 Chat 处理。'], capability_preflight: structuredClone(report),
    missing_capabilities: missing, recovery_conditions: [...report.recovery_conditions], side_effects_performed: [],
  };
}

const effectActions = ['local_files_write', 'repository_modify', 'email_send', 'pr_create', 'deploy', 'data_delete', 'production_modify', 'external_send'];
function validateSideEffects(policy) {
  object(policy, ['allowed', 'require_escalation', 'forbidden'], 'side_effects');
  const seen = new Set();
  for (const category of ['allowed', 'require_escalation', 'forbidden']) {
    const keys = ['action', 'target', category === 'allowed' ? 'authorization_ref' : 'reason'];
    records(policy[category], keys, `side_effects.${category}`);
    for (const rule of policy[category]) {
      oneOf(rule.action, effectActions, 'side_effects.action');
      if (category === 'allowed') requireThat(rule.target !== '*', 'side_effects.allowed requires exact target');
      const key = JSON.stringify([rule.action, rule.target]);
      requireThat(!seen.has(key), 'side_effects: duplicate/conflicting rule'); seen.add(key);
    }
  }
}
function effectPermission(policy, effect) {
  validateSideEffects(policy);
  oneOf(effect.action, effectActions, 'side_effect.action'); text(effect.target, 'side_effect.target');
  for (const status of ['forbidden', 'require_escalation', 'allowed']) {
    if (policy[status].some(rule => rule.action === effect.action && (rule.target === '*' || rule.target === effect.target))) {
      return { allowed: status === 'allowed', status };
    }
  }
  return { allowed: false, status: 'require_escalation' };
}
export function checkSideEffect(packet, snapshot, effect) {
  validateExecution(packet, snapshot);
  validateExecutionApproval(packet, snapshot);
  equal(packetIdentity(packet), snapshot.active_packet, 'active_packet: stale or changed packet');
  equal(snapshot.state, 'EXECUTE', 'side_effect: task must be executing');
  object(effect, ['action', 'target'], 'side_effect');
  return effectPermission(packet.side_effects, effect);
}
