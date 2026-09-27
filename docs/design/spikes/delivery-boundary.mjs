// M1 protocol experiment: UTF-8 text parts only, not a transport or approval engine.
import { createHash } from 'node:crypto';
import { object, requireThat, resultDigest } from '../../../scripts/contracts.mjs';

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = value => Number.isSafeInteger(value) && value > 0;

/** Caller supplies independently verified receipt sources; this checks their bindings. */
export function inspectDelivery(manifest, received, confirmations) {
  object(manifest, ['contract', 'version', 'artifact_id', 'artifact_revision', 'parts', 'marker'], 'manifest');
  requireThat(manifest.contract === 'DeliveryManifestV1' && manifest.version === 1, 'manifest.version');
  requireThat(id(manifest.artifact_id) && revision(manifest.artifact_revision), 'manifest.identity');
  requireThat(Array.isArray(manifest.parts) && manifest.parts.length > 0, 'manifest.parts');
  for (const part of manifest.parts) {
    object(part, ['id', 'sha256'], 'part');
    requireThat(id(part.id) && sha(part.sha256), 'part.identity');
  }
  requireThat(new Set(manifest.parts.map(part => part.id)).size === manifest.parts.length, 'duplicate part');
  requireThat(manifest.marker === null || typeof manifest.marker === 'string', 'manifest.marker');
  requireThat(received !== null && typeof received === 'object' && !Array.isArray(received), 'received');
  for (const [partId, content] of Object.entries(received)) {
    requireThat(manifest.parts.some(part => part.id === partId) && typeof content === 'string', 'received.part');
  }
  requireThat(Array.isArray(confirmations), 'confirmations');
  const receipts = new Map();
  for (const confirmation of confirmations) {
    object(confirmation, ['artifact_id', 'artifact_revision', 'part_id', 'sha256', 'evidence_ref'], 'confirmation');
    requireThat(id(confirmation.artifact_id) && revision(confirmation.artifact_revision)
      && id(confirmation.part_id) && sha(confirmation.sha256)
      && typeof confirmation.evidence_ref === 'string' && confirmation.evidence_ref.trim().length > 0, 'confirmation.fields');
    const key = JSON.stringify([confirmation.artifact_id, confirmation.artifact_revision, confirmation.part_id]);
    requireThat(!receipts.has(key), 'duplicate confirmation');
    receipts.set(key, confirmation);
  }
  const confirmed = [];
  for (const part of manifest.parts) {
    const key = JSON.stringify([manifest.artifact_id, manifest.artifact_revision, part.id]);
    const receipt = receipts.get(key);
    if (!receipt || receipt.sha256 !== part.sha256 || !Object.hasOwn(received, part.id)
      || digest(received[part.id]) !== part.sha256) break;
    confirmed.push(part.id);
  }
  const { marker, ...body } = manifest;
  const expectedMarker = `ARTIFACT COMPLETE ${manifest.artifact_id}@${manifest.artifact_revision} ${resultDigest(body)}`;
  return {
    confirmed_parts: confirmed,
    resume_from: manifest.parts[confirmed.length]?.id ?? null,
    delivery_complete: confirmed.length === manifest.parts.length && marker === expectedMarker,
  };
}
