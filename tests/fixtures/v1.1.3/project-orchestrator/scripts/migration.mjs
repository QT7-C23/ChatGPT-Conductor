import { isDeepStrictEqual } from 'node:util';
import { rules, object, text, trustedSource, requireThat, resultDigest, packetIdentity, validateSnapshot } from './contracts.mjs';

/** Explicit, pure migration boundary. Never executes work or manufactures an ACCEPT. */
export function migrateSnapshot(input) {
  try {
    object(input, ['snapshot', 'packet', 'result', 'review', 'confirmation'], 'migration');
    const { snapshot: source, packet, result, review, confirmation } = input;
    requireThat(source !== null && typeof source === 'object' && !Array.isArray(source), 'migration.snapshot');
    requireThat([1, 2].includes(source.schema_version), 'migration.source_schema');
    requireThat(!Object.hasOwn(source, 'lifecycle'), 'migration.lifecycle: already migrated or unknown newer lifecycle; do not reset');
    requireThat(rules.states.includes(source.state), 'migration.source_state');
    requireThat(Number.isSafeInteger(source.revision) && source.revision > 0, 'migration.source_revision');
    requireThat(Number.isSafeInteger(source.decision_version) && source.decision_version > 0, 'migration.decision_version');
    requireThat(Array.isArray(source.escalations) && source.escalations.length === 0, 'migration: resolve and archive legacy escalations explicitly before migration');
    object(confirmation, ['source_kind', 'approval_ref', 'executor_stopped', 'effects_reconciled', 'evidence_ref', 'pending_revision_instructions'], 'migration.confirmation');
    trustedSource(confirmation.source_kind); text(confirmation.approval_ref, 'migration.approval_ref'); text(confirmation.evidence_ref, 'migration.evidence_ref');
    for (const key of ['executor_stopped', 'effects_reconciled']) requireThat(typeof confirmation[key] === 'boolean', 'migration.' + key);
    requireThat(Array.isArray(confirmation.pending_revision_instructions), 'migration.pending_revision_instructions: explicitly reconcile outstanding reviews');
    confirmation.pending_revision_instructions.forEach(x => text(x, 'migration.pending_revision_instructions'));
    if (source.state === 'REVISE') requireThat(confirmation.pending_revision_instructions.length > 0, 'migration.pending_revision_instructions required for REVISE');
    const active = source.active_packet !== null;
    if (!['DISCUSS', 'PLAN'].includes(source.state)) requireThat(active, 'migration.active_packet required');
    if (active) {
      requireThat(confirmation.executor_stopped, 'migration.executor_stopped must be confirmed');
      requireThat(confirmation.effects_reconciled, 'migration.effects_reconciled must be confirmed');
      requireThat(packet !== null && typeof packet === 'object' && !Array.isArray(packet), 'migration.packet: trusted original packet required');
      requireThat(packet.schema_version === source.schema_version, 'migration.packet.schema_version');
      requireThat(!Object.hasOwn(packet, 'lifecycle'), 'migration.packet.lifecycle: unknown newer packet');
      for (const key of ['packet_id', 'packet_revision', 'task_id']) requireThat(packet[key] === source.active_packet[key], 'migration.packet.' + key);
      requireThat(packet.project_id === source.project_id && packet.decision_version === source.decision_version, 'migration.packet: reconcile project and decision baseline first');
      requireThat(isDeepStrictEqual(packet.locked_decisions, source.locked_decisions), 'migration.packet.locked_decisions');
      requireThat(resultDigest(packet) === source.active_packet.content_sha256, 'migration.packet: original digest mismatch');
    } else requireThat(packet === null && result === null && review === null, 'migration: inactive snapshot cannot silently adopt historical artifacts');
    if (['REVIEW', 'REVISE', 'COMPLETE'].includes(source.state)) requireThat(result !== null, 'migration.result: existing result and side effects must be reconciled');
    if (source.state === 'COMPLETE' || source.state === 'REVISE') requireThat(review !== null, 'migration.review: preserve historical review evidence');
    if (result !== null) {
      requireThat(active, 'migration.result requires original packet');
      for (const key of ['project_id', 'task_id', 'packet_id', 'packet_revision', 'decision_version', 'executor']) requireThat(result[key] === packet[key], 'migration.result.' + key);
      if (source.result_sha256 != null) requireThat(resultDigest(result) === source.result_sha256, 'migration.result digest mismatch');
    }
    if (review !== null) {
      requireThat(active && review.packet_id === packet.packet_id && review.packet_revision === packet.packet_revision, 'migration.review: wrong historical packet');
      if (source.review_record != null) requireThat(isDeepStrictEqual(review, source.review_record), 'migration.review: wrong historical review');
      if (source.state === 'REVISE' && Array.isArray(review.revision_instructions)) requireThat(isDeepStrictEqual(review.revision_instructions, confirmation.pending_revision_instructions), 'migration.pending_revision_instructions must preserve current review');
    }
    if (active && !['REVISE', 'COMPLETE'].includes(source.state) && Array.isArray(packet.revision_instructions)) requireThat(isDeepStrictEqual(packet.revision_instructions, confirmation.pending_revision_instructions), 'migration.pending_revision_instructions must preserve current packet');
    const baseline = active ? { ...packetIdentity({ ...packet, lifecycle: 1 }), content_sha256: resultDigest(packet) } : null;
    const snapshot = {
      schema_version: 2, project_id: source.project_id, revision: source.revision + 1,
      state: source.state === 'DISCUSS' ? 'DISCUSS' : 'PLAN', decision_version: source.decision_version,
      locked_decisions: structuredClone(source.locked_decisions), open_decisions: structuredClone(source.open_decisions),
      lifecycle: 2, active_packet: baseline, escalations: [], review_record: null, result_sha256: null,
      revision_reviews: [], plan_approvals: [],
      migration_record: {
        source_schema: source.schema_version, source_state: source.state, source_sha256: resultDigest(source),
        packet_sha256: packet === null ? null : resultDigest(packet), result_sha256: result === null ? null : resultDigest(result),
        review_sha256: review === null ? null : resultDigest(review), source_kind: confirmation.source_kind,
        approval_ref: confirmation.approval_ref, evidence_ref: confirmation.evidence_ref, authorization_inherited: false,
        target_lifecycle: 2, pending_revision_instructions: [...confirmation.pending_revision_instructions],
      },
    };
    validateSnapshot(snapshot);
    return { status: 'migrated', snapshot, next: 'Chat 必须重新核对授权和任务包；旧成果仅作输入证据，禁止盲目重放已完成副作用。' };
  } catch (error) {
    return { status: 'blocked', reasons: [error.message] };
  }
}
