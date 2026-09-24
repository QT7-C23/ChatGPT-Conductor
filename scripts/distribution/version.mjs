import { DistributionError, canonicalSha256, compareSemVer, validateReleaseDescriptor } from './contracts.mjs';
export { compareSemVer } from './contracts.mjs';

export function selectRelease(releases, { channel = 'stable', current = null, dirty = false } = {}) {
  if (!Array.isArray(releases) || !['stable', 'preview'].includes(channel)) throw new DistributionError('INVALID_CONTRACT', 'Invalid release query');
  if (current) validateReleaseDescriptor(current);
  const seen = new Map();
  for (const release of releases) {
    validateReleaseDescriptor(release);
    const earlier = seen.get(release.version);
    if (earlier && canonicalSha256(earlier) !== canonicalSha256(release)) throw new DistributionError('RELEASE_CONFLICT', 'Same version has multiple release identities');
    seen.set(release.version, release);
  }
  const candidates = [...seen.values()].filter(x => channel === 'preview' || x.channel === 'stable').sort((a, b) => compareSemVer(b.version, a.version));
  const target = candidates[0] ?? null;
  if (!target) return { status: 'unavailable', target: null, candidates };
  if (current) {
    const order = compareSemVer(target.version, current.version);
    if (order === 0 && canonicalSha256(target) !== canonicalSha256(current)) throw new DistributionError('RELEASE_CONFLICT', 'Installed version identity changed');
    if (order < 0) return { status: 'blocked', reason: 'Target is a downgrade; use rollback', target, candidates };
    if (order === 0) return dirty ? { status: 'blocked', reason: 'Installed files differ from release identity', target, candidates } : { status: 'no_op', target, candidates };
  }
  return { status: 'available', target, candidates };
}
