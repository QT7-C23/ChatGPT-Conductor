// Local delivery protocol only. Sources and receipt chronology are verified by the calling host.
import { object, requireThat, resultDigest, text, trustedSource } from './contracts.mjs';

export const DEFAULT_DELIVERY_POLICY = Object.freeze({ heuristic: 'characters_and_sections',
  long_chars: 12000, long_sections: 24, max_chars: 6000, max_sections: 12, reserve_chars: 512 });
const kinds = ['spec', 'prd', 'architecture_review', 'product_brief', 'execution_plan', 'router_explanation'];
const normalize = content => content.replaceAll('\r\n', '\n');
const contentDigest = content => resultDigest(normalize(content));
const id = (value, field) => requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), field);
const integer = (value, field) => requireThat(Number.isSafeInteger(value) && value > 0, field);
const sha = (value, field) => requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), field);
const unique = (values, field) => requireThat(new Set(values).size === values.length, `${field}: duplicate identity`);
const partDigest = segments => resultDigest(segments);
const manifestBody = manifest => {
  const { digest, completion_marker, ...body } = manifest;
  return body;
};
const finalMarker = manifest => `ARTIFACT COMPLETE ${manifest.artifact_id}@${manifest.artifact_revision} ${manifest.digest}`;
const segmentMarker = (manifest, part, segment) =>
  `SEGMENT COMPLETE ${manifest.artifact_id}@${manifest.artifact_revision} ${part.id}/${segment.id} ${segment.sha256}`;

const segmentSize = (manifest, part, segment) => segment.chars + segmentMarker(manifest, part, segment).length + 2;

function validatePolicy(policy) {
  object(policy, Object.keys(DEFAULT_DELIVERY_POLICY), 'delivery.policy');
  requireThat(policy.heuristic === 'characters_and_sections', 'delivery.policy.heuristic');
  for (const key of ['long_chars', 'long_sections', 'max_chars', 'max_sections', 'reserve_chars'])
    integer(policy[key], `delivery.policy.${key}`);
  requireThat(policy.reserve_chars < policy.max_chars, 'delivery.policy.reserve_chars');
}

/** Input sections are authored semantic units; a large atomic section is flagged, never sliced. */
export function planDelivery({ artifact_id, artifact_revision = 1, artifact_kind = 'spec', sections, policy = {} }) {
  requireThat(policy !== null && typeof policy === 'object' && !Array.isArray(policy) &&
    Object.keys(policy).every(key => Object.hasOwn(DEFAULT_DELIVERY_POLICY, key)), 'delivery.policy');
  const budget = { ...DEFAULT_DELIVERY_POLICY, ...policy };
  validatePolicy(budget);
  requireThat(Array.isArray(sections) && sections.length > 0, 'delivery.sections');
  let totalChars = 0;
  for (const section of sections) {
    object(section, ['id', 'content'], 'delivery.section'); id(section.id, 'delivery.section.id');
    text(section.content, 'delivery.section.content'); totalChars += normalize(section.content).length;
  }
  unique(sections.map(section => section.id), 'delivery.sections');
  // Short fast path performs no hashing, creates no identity/marker or persistence object.
  if (totalChars < budget.long_chars && sections.length < budget.long_sections)
    return { manifest: null, emissions: [] };
  id(artifact_id, 'delivery.artifact_id'); integer(artifact_revision, 'delivery.artifact_revision');
  requireThat(kinds.includes(artifact_kind), 'delivery.artifact_kind');
  const parts = []; let group = []; let chars = 0;
  const flush = () => {
    if (group.length) parts.push({ id: `part-${parts.length + 1}`, sha256: partDigest(group), segments: group });
    group = []; chars = 0;
  };
  for (const section of sections) {
    const segment = { id: `segment-${section.id}`, section_id: section.id,
      sha256: contentDigest(section.content), chars: normalize(section.content).length, oversize: false };
    const sizeForCurrentPart = () => segmentSize({ artifact_id, artifact_revision }, { id: `part-${parts.length + 1}` }, segment);
    if (group.length && (group.length >= budget.max_sections || chars + sizeForCurrentPart() > budget.max_chars - budget.reserve_chars)) flush();
    const size = sizeForCurrentPart();
    segment.oversize = size > budget.max_chars - budget.reserve_chars;
    group.push(segment); chars += size;
  }
  flush();
  const body = { contract: 'DeliveryManifestV1', version: 1, artifact_id, artifact_revision, artifact_kind,
    policy: budget, parts };
  const manifest = { ...body, digest: resultDigest(body), completion_marker: '' };
  manifest.completion_marker = finalMarker(manifest);
  validateDeliveryManifest(manifest);
  const content = new Map(sections.map(section => [section.id, section.content]));
  const emissions = parts.flatMap(part => part.segments.map(segment => ({ part_id: part.id,
    segment_id: segment.id, section_id: segment.section_id, content: content.get(segment.section_id),
    sha256: segment.sha256, marker: segmentMarker(manifest, part, segment) })));
  return { manifest, emissions };
}

/** Formal machine boundary before recovery, receipts or content approval are consumed. */
export function validateDeliveryManifest(manifest) {
  object(manifest, ['contract', 'version', 'artifact_id', 'artifact_revision', 'artifact_kind', 'policy',
    'parts', 'digest', 'completion_marker'], 'delivery.manifest');
  requireThat(manifest.contract === 'DeliveryManifestV1' && manifest.version === 1, 'delivery.manifest.version');
  id(manifest.artifact_id, 'delivery.artifact_id'); integer(manifest.artifact_revision, 'delivery.artifact_revision');
  requireThat(kinds.includes(manifest.artifact_kind), 'delivery.artifact_kind');
  validatePolicy(manifest.policy);
  requireThat(Array.isArray(manifest.parts) && manifest.parts.length > 0, 'delivery.parts');
  const segmentIds = []; const sectionIds = [];
  for (const part of manifest.parts) {
    object(part, ['id', 'sha256', 'segments'], 'delivery.part'); id(part.id, 'delivery.part.id'); sha(part.sha256, 'delivery.part.sha256');
    requireThat(Array.isArray(part.segments) && part.segments.length > 0, 'delivery.part.segments');
    for (const segment of part.segments) {
      object(segment, ['id', 'section_id', 'sha256', 'chars', 'oversize'], 'delivery.segment');
      id(segment.id, 'delivery.segment.id'); id(segment.section_id, 'delivery.segment.section_id');
      sha(segment.sha256, 'delivery.segment.sha256'); integer(segment.chars, 'delivery.segment.chars');
      requireThat(segment.oversize === (segmentSize(manifest, part, segment) > manifest.policy.max_chars - manifest.policy.reserve_chars), 'delivery.segment.oversize');
      segmentIds.push(segment.id); sectionIds.push(segment.section_id);
    }
    requireThat(part.sha256 === partDigest(part.segments), 'delivery.part.sha256: content changed');
    requireThat(part.segments.length <= manifest.policy.max_sections, 'delivery.part.section budget');
    const size = part.segments.reduce((sum, segment) => sum + segmentSize(manifest, part, segment), 0);
    requireThat(size <= manifest.policy.max_chars - manifest.policy.reserve_chars ||
      (part.segments.length === 1 && part.segments[0].oversize), 'delivery.part.character budget');
  }
  unique(manifest.parts.map(part => part.id), 'delivery.parts'); unique(segmentIds, 'delivery.segments'); unique(sectionIds, 'delivery.sections');
  sha(manifest.digest, 'delivery.digest');
  requireThat(manifest.digest === resultDigest(manifestBody(manifest)), 'delivery.digest: plan changed');
  requireThat(manifest.completion_marker === finalMarker(manifest), 'delivery.completion_marker');
  return manifest;
}

const bindingKeys = ['artifact_id', 'artifact_revision', 'manifest_digest'];
function validateBinding(value, manifest, field) {
  requireThat(value.artifact_id === manifest.artifact_id && value.artifact_revision === manifest.artifact_revision &&
    value.manifest_digest === manifest.digest, `${field}.binding: stale or changed content`);
}

function inspectValid(manifest, events) {
  validateDeliveryManifest(manifest);
  requireThat(Array.isArray(events), 'delivery.events');
  const partMap = new Map(manifest.parts.map(part => [part.id, part]));
  const states = new Map(manifest.parts.flatMap(part => part.segments.map(segment => [segment.id,
    { id: segment.id, section_id: segment.section_id, status: 'planned' }])));
  let markerSeen = false; const seenEvidence = new Map();
  for (const event of events) {
    requireThat(['delivered', 'confirmed', 'truncated', 'completion'].includes(event?.kind), 'delivery.event.kind');
    const receipt = ['delivered', 'confirmed'].includes(event.kind);
    const fields = ['kind', ...bindingKeys, 'source', 'evidence_ref', ...(receipt ?
      ['part_id', 'segment_id', 'section_id', 'content', 'sha256', 'marker'] :
      event.kind === 'truncated' ? ['part_id', 'segment_id'] : ['marker'])];
    object(event, fields, 'delivery.event'); validateBinding(event, manifest, 'delivery.event');
    const sources = event.kind === 'delivered' || event.kind === 'completion' ? ['emission', 'host', 'user'] : ['host', 'user'];
    requireThat(sources.includes(event.source), 'delivery.event.source: independent receipt required');
    text(event.evidence_ref, 'delivery.event.evidence_ref');
    const evidenceKey = resultDigest([event.source, event.evidence_ref]);
    const eventDigest = resultDigest(event);
    if (seenEvidence.has(evidenceKey)) {
      requireThat(seenEvidence.get(evidenceKey) === eventDigest, 'delivery.event: evidence reference reused');
      continue; // Exact replay cannot resurrect evidence invalidated by a later truncation report.
    }
    seenEvidence.set(evidenceKey, eventDigest);
    if (event.kind === 'completion') {
      text(event.marker, 'delivery.event.marker');
      markerSeen = event.marker === manifest.completion_marker && [...states.values()].every(s => ['delivered', 'confirmed'].includes(s.status));
      continue;
    }
    const part = partMap.get(event.part_id); requireThat(part, 'delivery.event.part_id');
    if (event.kind === 'truncated') {
      const index = event.segment_id === null ? 0 : part.segments.findIndex(segment => segment.id === event.segment_id);
      requireThat(index >= 0, 'delivery.event.segment_id');
      for (const segment of part.segments.slice(index)) states.get(segment.id).status = 'incomplete';
      markerSeen = false;
      continue;
    }
    const segment = part.segments.find(s => s.id === event.segment_id);
    requireThat(segment && segment.section_id === event.section_id && segment.sha256 === event.sha256, 'delivery.event.segment binding');
    requireThat(typeof event.content === 'string' && contentDigest(event.content) === segment.sha256 &&
      normalize(event.content).length === segment.chars, 'delivery.event.content');
    requireThat(event.marker === segmentMarker(manifest, part, segment), 'delivery.event.segment marker');
    const state = states.get(segment.id);
    if (event.kind === 'confirmed') state.status = 'confirmed';
    else if (state.status !== 'confirmed') state.status = 'delivered';
  }
  const parts = manifest.parts.map(part => {
    const segments = part.segments.map(segment => ({ ...states.get(segment.id) }));
    const delivered = segments.every(s => ['delivered', 'confirmed'].includes(s.status));
    const confirmed = segments.every(s => s.status === 'confirmed');
    return { id: part.id, delivered, confirmed, complete: delivered, approval_eligible: confirmed, segments };
  });
  const allDelivered = parts.every(part => part.delivered);
  const incomplete = parts.some(part => part.segments.some(segment => segment.status === 'incomplete'));
  const complete = allDelivered && markerSeen;
  return { available: true, complete, status: complete ? 'complete' : allDelivered ? 'unknown' : 'incomplete',
    visibility: incomplete ? 'incomplete' : parts.every(part => part.confirmed) ? 'confirmed' : 'unknown',
    completion_marker_seen: markerSeen, parts };
}

/** Isolate damaged/missing delivery data; never read or classify ProjectState here. */
export function inspectDelivery(manifest, events = []) {
  if (manifest == null) return { available: false, complete: false, status: 'unknown', reason: 'delivery_manifest_missing', parts: [] };
  try { return inspectValid(manifest, events); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Contract violation:')) throw error;
    return { available: false, complete: false, status: 'unknown', reason: 'delivery_recovery_unavailable',
      diagnostic: error.message, parts: [] };
  }
}

/** Plans text recovery only; emitted/confirmed content and external actions are never replayed. */
export function resumeDelivery(manifest, events = [], { from_part_id = null } = {}) {
  const delivery = inspectDelivery(manifest, events);
  if (!delivery.available) return { action: 'rebuild_delivery_plan', reason: delivery.reason, resume_from: null, segments: [] };
  const pending = delivery.parts.flatMap(part => part.segments.filter(s => ['planned', 'incomplete'].includes(s.status))
    .map(segment => ({ part_id: part.id, segment_id: segment.id, section_id: segment.section_id })));
  if (from_part_id !== null) {
    const requested = delivery.parts.findIndex(part => part.id === from_part_id);
    requireThat(requested >= 0, 'delivery.resume.part_id');
    const first = pending.length ? delivery.parts.findIndex(part => part.id === pending[0].part_id) : -1;
    if (first >= 0 && requested > first) return { action: 'resolve_earlier_gap', reason: 'earlier_gap', resume_from: pending[0], segments: pending };
  }
  return { action: pending.length ? 'emit_missing' : delivery.complete ? 'none' : 'completion_marker',
    resume_from: pending[0] ?? null, segments: pending,
    completion_marker: delivery.complete ? null : manifest.completion_marker,
    unconfirmed_segments: delivery.parts.flatMap(part => part.segments.filter(s => s.status === 'delivered')
      .map(segment => ({ part_id: part.id, segment_id: segment.id, section_id: segment.section_id }))) };
}

/** An ambiguous utterance has no implicit future scope. A host may supply its exact visible referent. */
export function approveDelivery(manifest, events, request) {
  const delivery = inspectDelivery(manifest, events);
  const eligible = delivery.parts.filter(part => part.approval_eligible).map(part => part.id);
  const denied = reason => ({ accepted: false, reason, eligible_part_ids: eligible, scope: null });
  if (!delivery.available) return denied(delivery.reason);
  if (!Array.isArray(request?.part_ids) || request.part_ids.length === 0) return denied('ambiguous_scope');
  object(request, [...bindingKeys, 'part_ids', 'source_kind', 'approval_ref'], 'delivery.approval');
  validateBinding(request, manifest, 'delivery.approval'); trustedSource(request.source_kind);
  text(request.approval_ref, 'delivery.approval.approval_ref');
  unique(request.part_ids, 'delivery.approval.parts');
  if (!request.part_ids.every(part => eligible.includes(part))) return denied('scope_not_completely_delivered_and_confirmed');
  const scope = { ...Object.fromEntries(bindingKeys.map(key => [key, request[key]])),
    parts: manifest.parts.filter(part => request.part_ids.includes(part.id)).map(part => ({ id: part.id, sha256: part.sha256 })),
    source_kind: request.source_kind, approval_ref: request.approval_ref };
  return { accepted: true, scope };
}

export function validateDeliveryApproval(scope, manifest, events) {
  validateDeliveryManifest(manifest);
  object(scope, [...bindingKeys, 'parts', 'source_kind', 'approval_ref'], 'delivery.approval scope');
  validateBinding(scope, manifest, 'delivery.approval scope');
  requireThat(Array.isArray(scope.parts) && scope.parts.length > 0, 'delivery.approval scope.parts');
  for (const part of scope.parts) {
    object(part, ['id', 'sha256'], 'delivery.approval scope.part');
    requireThat(manifest.parts.some(expected => expected.id === part.id && expected.sha256 === part.sha256), 'delivery.approval scope.content binding');
  }
  const approved = approveDelivery(manifest, events, { ...Object.fromEntries(bindingKeys.map(key => [key, scope[key]])),
    part_ids: scope.parts.map(part => part.id), source_kind: scope.source_kind, approval_ref: scope.approval_ref });
  requireThat(approved.accepted, 'delivery.approval scope: no longer completely delivered and confirmed');
  return scope;
}
