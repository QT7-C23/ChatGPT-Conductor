import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DistributionError, validateManifest, validateReleaseDescriptor, canonicalJson } from './contracts.mjs';
import { createTransport, authenticateWithGh, LIMITS } from './transport.mjs';
export { LIMITS } from './transport.mjs';
export const REPOSITORY = Object.freeze({ host: 'github.com', full_name: 'QT7-C23/ChatGPT-Conductor', id: '1382745738' });
const api = 'https://api.github.com/repos/QT7-C23/ChatGPT-Conductor';
const capabilities = new WeakMap();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new DistributionError('SOURCE_IDENTITY', message); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const id = value => { if (!((typeof value === 'number' && Number.isSafeInteger(value)) || typeof value === 'string') || !/^[1-9]\d*$/.test(String(value))) fail('Invalid GitHub identifier'); return String(value); };
function publication(release) {
  id(release.id);
  if (release.draft !== false || release.immutable !== true || typeof release.prerelease !== 'boolean' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.tag_name)) fail('Release is not an immutable publication');
}
function checkBytes(bytes, expected, limit) {
  if (!Buffer.isBuffer(bytes) || bytes.length > limit || (expected && (bytes.length !== expected.bytes || sha(bytes) !== expected.sha256))) fail('Asset size or digest mismatch');
}
function bundle(data, payloadPath = null) {
  const output = freeze({ descriptor: structuredClone(data.descriptor), manifest: structuredClone(data.manifest), changelog: data.changelog, payloadPath, evidence: structuredClone(data.evidence) });
  capabilities.set(output, { ...data, payloadPath }); return output;
}
export function requireAuthenticatedBundle(value, { payload = false } = {}) {
  const data = capabilities.get(value);
  if (!data || (payload && !data.payloadPath)) throw new DistributionError('UNAUTHENTICATED_BUNDLE', 'Authenticated source capability required');
  return value;
}
export function createReleaseSource({ transport = createTransport(), authenticate = authenticateWithGh, credentialSupplier = async () => null } = {}) {
  async function fetchBytes(url, limit, binary = false) {
    const token = await credentialSupplier();
    const headers = { accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const bytes = await transport(url, { limit, headers }); checkBytes(bytes, null, limit); return bytes;
  }
  const json = async url => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fetchBytes(url, LIMITS.manifest)));
  async function identity() {
    const repository = await json(api);
    if (id(repository.id) !== REPOSITORY.id || repository.full_name !== REPOSITORY.full_name) fail('Repository identity changed');
  }
  async function pages(endpoint) {
    const all = []; const seen = new Set();
    for (let page = 1; ; page++) {
      const items = await json(`${endpoint}?per_page=100&page=${page}`);
      if (!Array.isArray(items)) fail('Invalid GitHub pagination');
      for (const item of items) { const key = id(item.id); if (seen.has(key)) fail('Repeated GitHub pagination identity'); seen.add(key); all.push(item); }
      if (items.length < 100) return all;
    }
  }
  async function commit(tag) {
    let object = (await json(`${api}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
    const seen = new Set();
    for (let depth = 0; depth < 32; depth++) {
      if (!object || !/^[0-9a-f]{40}$/.test(object.sha) || seen.has(object.sha)) fail('Invalid or cyclic tag');
      seen.add(object.sha);
      if (object.type === 'commit') return object.sha;
      if (object.type !== 'tag') fail('Tag does not resolve to a commit');
      object = (await json(`${api}/git/tags/${object.sha}`)).object;
    }
    fail('Tag resolution exceeded depth');
  }
  async function assetBytes(asset, directory, tag, limit, expected = null) {
    if (!asset || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size > limit) fail('Missing or oversized release asset');
    const bytes = await fetchBytes(`${api}/releases/assets/${id(asset.id)}`, limit, true);
    checkBytes(bytes, expected, limit);
    if (bytes.length !== asset.size || (asset.digest != null && asset.digest !== `sha256:${sha(bytes)}`)) fail('GitHub asset digest mismatch');
    if (typeof asset.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(asset.name) || ['.','..'].includes(asset.name)) fail('Unsafe asset name');
    const file = path.join(directory, asset.name); await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    await authenticate({ tag, file }); return { bytes, file };
  }
  async function authenticateRelease(releaseId) {
    await identity();
    const release = await json(`${api}/releases/${id(releaseId)}`); publication(release);
    if (id(release.id) !== id(releaseId)) fail('Release ID changed');
    const resolved = await commit(release.tag_name);
    await authenticate({ tag: release.tag_name });
    const assets = await pages(`${api}/releases/${id(release.id)}/assets`);
    if (new Set(assets.map(a => a.name)).size !== assets.length) fail('Duplicate asset names');
    const directory = await mkdtemp(path.join(tmpdir(), 'conductor-auth-'));
    const raw = await assetBytes(assets.find(a => a.name === 'release-manifest.json'), directory, release.tag_name, LIMITS.manifest);
    const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.bytes)));
    if (manifest.release_id !== id(release.id) || manifest.tag !== release.tag_name || manifest.source_commit !== resolved || (manifest.channel === 'preview') !== release.prerelease) fail('Manifest release identity mismatch');
    const descriptor = validateReleaseDescriptor({ repository: manifest.repository, tag: manifest.tag, source_commit: resolved, release_id: manifest.release_id, version: manifest.version, manifest_sha256: sha(raw.bytes), payload_sha256: manifest.payload.sha256, changelog_sha256: manifest.changelog.sha256, immutable: true, draft: false, prerelease: release.prerelease, channel: manifest.channel, skill_id: manifest.skill_id });
    const notes = await assetBytes(assets.find(a => a.name === manifest.changelog.name), directory, manifest.tag, LIMITS.changelog, manifest.changelog);
    const changelog = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(notes.bytes);
    return bundle({ descriptor, manifest, changelog, assets, directory, evidence: { method: 'github-release-attestation', manifestPath: raw.file, changelogPath: notes.file } });
  }
  async function acquirePayload(value) {
    requireAuthenticatedBundle(value);
    const data = capabilities.get(value);
    if (!data.assets) fail('Cached bundle must be reauthenticated online to acquire assets');
    const result = await assetBytes(data.assets.find(a => a.name === data.manifest.payload.name), data.directory, data.manifest.tag, LIMITS.zip, data.manifest.payload);
    return bundle(data, result.file);
  }
  async function recheck(value) {
    requireAuthenticatedBundle(value);
    const fresh = await authenticateRelease(value.descriptor.release_id);
    if (canonicalJson(fresh.descriptor) !== canonicalJson(value.descriptor)) fail('Release changed after approval');
    return fresh;
  }
  async function discover() {
    try { await identity(); return { status: 'available', releases: (await pages(`${api}/releases`)).map(r => { publication(r); return freeze({ release_id: id(r.id), tag: r.tag_name, prerelease: r.prerelease }); }) }; }
    catch (error) { if (error.code === 'SOURCE_UNAVAILABLE') return { status: 'unavailable', releases: [], reason: error.message, retryAfter: error.retryAfter ?? null }; throw error; }
  }
  return Object.freeze({ discover, authenticateRelease, acquirePayload, recheck });
}
// The trusted deployment store must authenticate its own persisted journal/record and select
// the exact expected descriptor. This port is never populated from CLI/manifest fields.
export async function restoreAuthenticatedCache({ store, release }) {
  validateReleaseDescriptor(release);
  const cached = await store.readAuthenticatedRelease(release);
  if (!cached || canonicalJson(cached.descriptor) !== canonicalJson(release)) fail('Cached identity mismatch');
  for (const file of [cached.manifestPath, cached.changelogPath, cached.payloadPath]) {
    const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) fail('Unsafe cache file');
  }
  const manifestInfo = await lstat(cached.manifestPath);
  if (manifestInfo.size > LIMITS.manifest) fail('Cached manifest exceeds limit');
  const raw = await readFile(cached.manifestPath);
  if (sha(raw) !== release.manifest_sha256) fail('Cached manifest changed');
  const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
  if (manifest.release_id !== release.release_id || manifest.source_commit !== release.source_commit || manifest.tag !== release.tag || manifest.payload.sha256 !== release.payload_sha256 || manifest.changelog.sha256 !== release.changelog_sha256) fail('Cached manifest identity mismatch');
  for (const [file, expected, limit] of [[cached.payloadPath, manifest.payload, LIMITS.zip], [cached.changelogPath, manifest.changelog, LIMITS.changelog]]) {
    if ((await lstat(file)).size > limit) fail('Cached asset exceeds limit');
    checkBytes(await readFile(file), expected, limit);
  }
  const changelog = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(cached.changelogPath));
  return bundle({ descriptor: release, manifest, changelog, evidence: { method: 'trusted-local-record', manifestPath: cached.manifestPath, changelogPath: cached.changelogPath } }, cached.payloadPath);
}
