// Local evidence resolution only. The host owns file I/O, source verification and runtime observation.
import { createHash } from 'node:crypto';

const tiers = ['FAST', 'BALANCED', 'STRONG', 'FRONTIER', 'unknown'];
const levels = ['LOW', 'MEDIUM', 'HIGH'];
const confidence = ['LOW', 'MEDIUM', 'HIGH', 'unknown'];
const tri = [true, false, 'unknown'];
const fail = field => { throw new Error(`Contract violation: ${field}`); };
const check = (condition, field) => { if (!condition) fail(field); };
const object = (value, keys, field) => {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  check(Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)), `${field}: unexpected or missing field`);
};
const string = (value, field) => check(typeof value === 'string' && value.trim().length > 0, field);
const refs = (value, field) => check(Array.isArray(value) && value.every(ref => typeof ref === 'string' && ref.trim()) && new Set(value).size === value.length, field);
const timestamp = (value, field) => check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value, field);
const optionalTime = (value, field) => { if (value !== null) timestamp(value, field); };
const known = (value, choices, field) => check(choices.includes(value), field);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const registryDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function evidence(fact, field, evalRecord = false) {
  object(fact, evalRecord ? ['ref', 'scope', 'tier', 'reasoning_support', 'capabilities', 'observed_at', 'valid_until', 'confidence'] :
    ['tier', 'reasoning_support', 'capabilities', 'evidence_refs', 'verified_at', 'valid_until', 'confidence'], field);
  known(fact.tier, tiers, `${field}.tier`);
  known(fact.reasoning_support, ['supported', 'unsupported', 'unknown'], `${field}.reasoning_support`);
  refs(fact.capabilities, `${field}.capabilities`);
  known(fact.confidence, confidence, `${field}.confidence`);
  if (evalRecord) { string(fact.ref, `${field}.ref`); string(fact.scope, `${field}.scope`); timestamp(fact.observed_at, `${field}.observed_at`); }
  else { refs(fact.evidence_refs, `${field}.evidence_refs`); optionalTime(fact.verified_at, `${field}.verified_at`); }
  optionalTime(fact.valid_until, `${field}.valid_until`);
  const start = evalRecord ? fact.observed_at : fact.verified_at;
  check(start === null || fact.valid_until === null || fact.valid_until >= start, `${field}.valid_until`);
  if (fact.tier !== 'unknown' || fact.reasoning_support !== 'unknown' || fact.capabilities.length)
    check(evalRecord || fact.evidence_refs.length > 0, `${field}.evidence_refs`);
}

export function validateRegistrySnapshot(snapshot) {
  object(snapshot, ['contract', 'version', 'registry_version', 'snapshot_id', 'entries'], 'registry');
  check(snapshot.contract === 'ModelCapabilityRegistryV1' && snapshot.version === 1, 'registry.version');
  string(snapshot.registry_version, 'registry.registry_version');
  string(snapshot.snapshot_id, 'registry.snapshot_id');
  check(Array.isArray(snapshot.entries), 'registry.entries');
  const ids = new Set();
  for (const entry of snapshot.entries) {
    object(entry, ['id', 'provider_family', 'host_family', 'provider_facts', 'eval_evidence'], 'registry.entry');
    string(entry.id, 'registry.entry.id');
    string(entry.provider_family, 'registry.entry.provider_family');
    string(entry.host_family, 'registry.entry.host_family');
    check(!ids.has(entry.id), 'registry.entry.id: duplicate'); ids.add(entry.id);
    evidence(entry.provider_facts, `registry.entry.${entry.id}.provider_facts`);
    check(Array.isArray(entry.eval_evidence), 'registry.entry.eval_evidence');
    const evalRefs = new Set();
    for (const item of entry.eval_evidence) {
      evidence(item, `registry.entry.${entry.id}.eval_evidence`, true);
      check(!evalRefs.has(item.ref), 'registry.eval_evidence.ref: duplicate'); evalRefs.add(item.ref);
    }
  }
  return snapshot;
}

// A local update is a complete, explicitly selected snapshot, never a patch to bundled facts.
export function loadRegistry({ baseline, local = null, selected = 'baseline', expected_local_digest = null }) {
  validateRegistrySnapshot(baseline);
  known(selected, ['baseline', 'local'], 'registry.selected');
  check(selected !== 'local' || local !== null, 'registry.local: missing');
  if (local !== null) validateRegistrySnapshot(local);
  if (selected === 'local') {
    check(typeof expected_local_digest === 'string' && /^[a-f0-9]{64}$/.test(expected_local_digest), 'registry.expected_local_digest');
    check(registryDigest(local) === expected_local_digest, 'registry.local: digest mismatch');
  }
  const snapshot = selected === 'local' ? local : baseline;
  return { snapshot: structuredClone(snapshot), source: selected, snapshot_id: snapshot.snapshot_id,
    registry_version: snapshot.registry_version, digest: registryDigest(snapshot),
    baseline_ref: { snapshot_id: baseline.snapshot_id, registry_version: baseline.registry_version, digest: registryDigest(baseline) },
    local_ref: local === null ? null : { snapshot_id: local.snapshot_id, registry_version: local.registry_version, digest: registryDigest(local) } };
}

export function validateRuntimeOverlay(overlay) {
  if (overlay === null) return null;
  object(overlay, ['contract', 'version', 'host_session', 'observations'], 'overlay');
  check(overlay.contract === 'ModelRuntimeOverlayV1' && overlay.version === 1, 'overlay.version');
  string(overlay.host_session, 'overlay.host_session');
  check(Array.isArray(overlay.observations), 'overlay.observations');
  const ids = new Set();
  for (const item of overlay.observations) {
    object(item, ['id', 'available', 'selectable', 'reasoning_control', 'switching_support', 'quota',
      'source_ref', 'observed_at', 'valid_until'], 'overlay.observation');
    string(item.id, 'overlay.observation.id');
    check(!ids.has(item.id), 'overlay.observation.id: duplicate'); ids.add(item.id);
    for (const key of ['available', 'selectable', 'reasoning_control', 'switching_support']) known(item[key], tri, `overlay.${key}`);
    object(item.quota, ['readable', 'remaining', 'unit'], 'overlay.quota');
    known(item.quota.readable, tri, 'overlay.quota.readable');
    if (item.quota.readable === true) {
      check(Number.isFinite(item.quota.remaining) && item.quota.remaining >= 0, 'overlay.quota.remaining');
      string(item.quota.unit, 'overlay.quota.unit');
    } else check(item.quota.remaining === null && item.quota.unit === null, 'overlay.quota: unreadable must be unknown');
    string(item.source_ref, 'overlay.source_ref');
    timestamp(item.observed_at, 'overlay.observed_at');
    optionalTime(item.valid_until, 'overlay.valid_until');
    check(item.valid_until === null || item.valid_until >= item.observed_at, 'overlay.valid_until');
  }
  return overlay;
}

export function factFreshness(fact, now, observedField = 'verified_at') {
  timestamp(now, 'now');
  const observed = fact[observedField];
  return observed === null || fact.valid_until === null ? 'unknown' :
    now < observed ? 'unknown' : now > fact.valid_until ? 'stale' : 'fresh';
}

const runtimeUnknown = () => ({ available: 'unknown', selectable: 'unknown', reasoning_control: 'unknown',
  switching_support: 'unknown', quota: { readable: 'unknown', remaining: null, unit: null }, freshness: 'unknown' });
const lower = (a, b) => a === 'LOW' || b === 'LOW' ? 'LOW' : a === 'MEDIUM' || b === 'MEDIUM' ? 'MEDIUM' : 'HIGH';

// Resolves an M3 tier/reasoning need to candidate options. It never chooses or switches a model.
export function resolveRegistryCandidates({ registry, tier, reasoning, now, overlay = null, host_session = null,
  eval_scope = null }) {
  check(registry !== null && typeof registry === 'object' && registry.snapshot, 'registry: loadRegistry result required');
  validateRegistrySnapshot(registry.snapshot);
  known(registry.source, ['baseline', 'local'], 'registry.source');
  check(registry.snapshot_id === registry.snapshot.snapshot_id &&
    registry.registry_version === registry.snapshot.registry_version, 'registry.metadata: mismatch');
  check(registry.digest === registryDigest(registry.snapshot), 'registry.digest: stale cache');
  for (const [name, ref] of [['baseline_ref', registry.baseline_ref], ['local_ref', registry.local_ref]]) {
    if (name === 'local_ref' && ref === null) continue;
    object(ref, ['snapshot_id', 'registry_version', 'digest'], `registry.${name}`);
    string(ref.snapshot_id, `registry.${name}.snapshot_id`);
    string(ref.registry_version, `registry.${name}.registry_version`);
    check(typeof ref.digest === 'string' && /^[a-f0-9]{64}$/.test(ref.digest), `registry.${name}.digest`);
  }
  const selectedRef = registry.source === 'local' ? registry.local_ref : registry.baseline_ref;
  check(selectedRef !== null && selectedRef.snapshot_id === registry.snapshot_id &&
    selectedRef.registry_version === registry.registry_version && selectedRef.digest === registry.digest,
  'registry.selected_ref: mismatch');
  known(tier, tiers.filter(value => value !== 'unknown'), 'tier');
  known(reasoning, levels, 'reasoning');
  timestamp(now, 'now');
  check(eval_scope === null || (typeof eval_scope === 'string' && eval_scope.trim()), 'eval_scope');
  validateRuntimeOverlay(overlay);
  if (overlay !== null) check(overlay.host_session === host_session, 'overlay.host_session: mismatch');
  const candidates = [], reasons = new Set();
  let refresh_needed = false;
  for (const entry of registry.snapshot.entries) {
    const facts = entry.provider_facts;
    const freshness = factFreshness(facts, now);
    const observation = overlay?.observations.find(item => item.id === entry.id);
    const live = observation && factFreshness(observation, now, 'observed_at') === 'fresh' ?
      { available: observation.available, selectable: observation.selectable,
        reasoning_control: observation.reasoning_control, switching_support: observation.switching_support,
        quota: structuredClone(observation.quota), freshness: 'fresh' } : runtimeUnknown();
    if (observation && live.freshness !== 'fresh') { reasons.add('runtime_stale'); refresh_needed = true; }
    if (facts.tier === 'unknown' || facts.reasoning_support === 'unknown' || facts.confidence === 'unknown') {
      reasons.add('provider_unknown'); refresh_needed = true; continue;
    }
    if (facts.tier !== tier) continue;
    if (freshness !== 'fresh') { reasons.add(freshness === 'stale' ? 'provider_stale' : 'provider_freshness_unknown'); refresh_needed = true; continue; }
    if (facts.confidence === 'LOW') { reasons.add('provider_low_confidence'); refresh_needed = true; continue; }
    if (reasoning !== 'LOW' && facts.reasoning_support !== 'supported') { reasons.add('reasoning_unsupported'); continue; }
    const relevantEval = entry.eval_evidence.filter(item => eval_scope !== null && item.scope === eval_scope && item.tier === tier);
    if (relevantEval.some(item => factFreshness(item, now, 'observed_at') === 'stale')) {
      reasons.add('eval_stale'); refresh_needed = true;
    }
    const conflicting = relevantEval.some(item => factFreshness(item, now, 'observed_at') === 'fresh' &&
      (item.reasoning_support === 'unsupported' && reasoning !== 'LOW'));
    if (conflicting) { reasons.add('eval_conflict'); continue; }
    candidates.push({ id: entry.id, provider_family: entry.provider_family, host_family: entry.host_family,
      confidence: relevantEval.some(item => factFreshness(item, now, 'observed_at') === 'stale') ? 'LOW' : facts.confidence,
      provider: { tier: facts.tier, reasoning_support: facts.reasoning_support, capabilities: [...facts.capabilities],
        evidence_refs: [...facts.evidence_refs], freshness },
      eval_evidence: structuredClone(relevantEval), runtime: live });
  }
  const usable = candidates.filter(item => item.confidence !== 'LOW' && item.runtime.available === true &&
    item.runtime.selectable === true && (reasoning === 'LOW' || item.runtime.reasoning_control === true));
  if (!candidates.length) { reasons.add('no_supported_candidate'); refresh_needed = true; }
  else if (!usable.length) {
    reasons.add('runtime_unconfirmed_or_unavailable');
    if (candidates.some(item => item.runtime.available === 'unknown' || item.runtime.selectable === 'unknown' ||
      (reasoning !== 'LOW' && item.runtime.reasoning_control === 'unknown'))) refresh_needed = true;
  }
  return { contract: 'RegistryResolutionV1', version: 1, registry_ref: {
    source: registry.source, snapshot_id: registry.snapshot_id, registry_version: registry.registry_version,
    digest: registry.digest, baseline_ref: structuredClone(registry.baseline_ref), local_ref: structuredClone(registry.local_ref) },
  tier, reasoning, candidates, usable_ids: usable.map(item => item.id), status: usable.length ? 'resolved' : 'unresolved',
  confidence: usable.length ? usable.reduce((value, item) => lower(value, item.confidence), 'HIGH') : 'LOW',
  refresh_needed, reasons: [...reasons].sort(), overhead: { extra_model_call: false, network_call: false, automatic_refresh: false } };
}
