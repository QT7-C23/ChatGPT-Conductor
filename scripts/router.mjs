import { isDeepStrictEqual } from 'node:util';
import { rules, requireThat, validateSnapshot, validateExecution, validateReady, validateResult, validateReview, validateChallenge, packetIdentity, validatePacketRevision, validatePreflight, preflightBlockedResult, resultDigest, boundaryDigest, currentRevisionInstructions, hasPlanApproval, makePlanApproval, hasExecutionApproval, validateExecutionApproval, validateRevisionReplacement, revisionReviews } from './contracts.mjs';
export { rules } from './contracts.mjs';

export function classify(workType) {
  requireThat(typeof workType === 'string', 'work_type must be a string');
  requireThat(Object.hasOwn(rules.work_types, workType), 'work_type');
  return rules.work_types[workType];
}

/** Pure routing boundary: input/output JSON only, no network, shell, storage or model calls. */
export function transition(request) {
  requireThat(request !== null && typeof request === 'object' && !Array.isArray(request), 'request');
  const allowed = ['snapshot', 'event', 'work_type', 'packet', 'result', 'review', 'challenge', 'preflight', 'approval'];
  requireThat(Object.keys(request).every(k => allowed.includes(k)), 'request: unexpected field');
  const { snapshot, event, work_type, packet, result, review } = request;
  validateSnapshot(snapshot);
  const owner = classify(work_type);
  requireThat(typeof event === 'string', 'event must be a string');
  requireThat(Object.hasOwn(rules.events, event), 'event');
  const rule = rules.events[event];
  requireThat(rule.from.includes(snapshot.state), `transition: ${snapshot.state} -> ${event}`);
  const next = structuredClone(snapshot);
  next.revision_reviews = structuredClone(revisionReviews(snapshot));
  next.state = rule.to;
  next.revision++;
  let surface = 'CHAT';
  let action = event;
  let blockedResult;
  if (event === 'replan' || event === 'reauthorize') {
    validateExecution(packet, snapshot);
    requireThat(work_type === packet.work_type, 'work_type does not match packet');
    validatePacketRevision(packet, snapshot.active_packet);
    next.plan_approvals.push(makePlanApproval(snapshot, packet, request.approval, event === 'reauthorize'));
  }
  if (['prepare', 'start'].includes(event)) {
    requireThat(work_type !== 'mixed', 'split: mixed deliverables need separate packets');
    requireThat(work_type !== 'unknown', 'clarify: work_type unknown');
    validateExecution(packet, snapshot);
    requireThat(packet.work_type === work_type, 'work_type does not match packet');
    if (event === 'prepare') {
      requireThat(snapshot.escalations.every(e => !e.challenge.blocking || e.resolution_ref !== null), 'challenge: resolution required');
      validatePacketRevision(packet, snapshot.active_packet);
      const instructions = currentRevisionInstructions(snapshot);
      if (instructions !== null) requireThat(isDeepStrictEqual(packet.revision_instructions, instructions), 'revision_instructions must carry current Chat review or explicit replan replacement');
      if (!hasExecutionApproval(packet, snapshot)) {
        next.state = 'PLAN'; validateSnapshot(next);
        return { surface: 'CHAT', action: 'reauthorization_required', snapshot: next, reason: '迁移后的执行包必须在 PLAN 取得绑定当前生命周期和完整拟议包的新执行批准。' };
      }
      const pendingApproval = snapshot.plan_approvals.at(-1);
      const awaitingApprovedPacket = pendingApproval?.lifecycle === snapshot.lifecycle && pendingApproval.from_packet_sha256 === (snapshot.active_packet?.content_sha256 ?? null);
      const boundaryChanged = snapshot.active_packet?.lifecycle === snapshot.lifecycle && boundaryDigest(packet) !== snapshot.active_packet.boundary_sha256;
      const unrecordedRequirements = instructions === null && packet.revision_instructions.length > 0;
      if ((boundaryChanged || awaitingApprovedPacket || unrecordedRequirements) && !hasPlanApproval(snapshot, packet)) {
        next.state = 'PLAN'; validateSnapshot(next);
        return { surface: 'CHAT', action: 'replan_required', snapshot: next, reason: '任务边界变化需要 PLAN 中绑定新包的明确 replan 批准；新包尚未生效。' };
      }
      validateReady(packet, snapshot);
      if (snapshot.active_packet?.lifecycle !== snapshot.lifecycle) {
        next.revision_reviews = [];
        next.plan_approvals = snapshot.plan_approvals.filter(a => a.lifecycle === snapshot.lifecycle).map(a => structuredClone(a));
      }
      next.active_packet = packetIdentity(packet);
      next.review_record = null;
      next.result_sha256 = null;
      action = 'handoff';
    } else {
      validateReady(packet, snapshot);
      requireThat(isDeepStrictEqual(packetIdentity(packet), snapshot.active_packet), 'active_packet: stale or changed packet');
      if (validatePreflight(request.preflight, packet).length > 0) {
        blockedResult = preflightBlockedResult(packet, request.preflight);
        validateResult(blockedResult, packet);
        next.result_sha256 = resultDigest(blockedResult);
        next.state = 'REVIEW'; action = 'preflight_blocked';
      }
    }
    surface = owner;
  }
  if (['submit', 'accept', 'revise', 'escalate'].includes(event)) {
    validateExecution(packet, snapshot);
    requireThat(isDeepStrictEqual(packetIdentity(packet), snapshot.active_packet), 'active_packet: stale or changed packet');
    requireThat(work_type === packet.work_type, 'work_type does not match packet');
    validateResult(result, packet);
    if (event === 'submit' || event === 'accept') validateExecutionApproval(packet, snapshot);
    if (event === 'submit') next.result_sha256 = resultDigest(result);
    if (event !== 'submit') {
      validateReview(review, packet, result);
      requireThat(resultDigest(result) === snapshot.result_sha256, 'result: stale or changed digest');
      requireThat(review.verdict === { accept: 'ACCEPT', revise: 'REVISE', escalate: 'ESCALATE' }[event], 'review.verdict does not match event');
      next.review_record = structuredClone(review);
      if (event === 'revise') {
        requireThat(!next.revision_reviews.some(r => r.review_id === review.review_id), 'revision_reviews: duplicate review_id');
        validateRevisionReplacement(review, snapshot);
        requireThat(review.supersedes_review_id === (snapshot.revision_reviews.findLast(r => r.verdict === 'REVISE')?.review_id ?? null), 'review.supersedes_review_id must identify current revision review');
        next.revision_reviews.push(structuredClone(review));
      }
      if (event === 'escalate' && review.revision_instructions.length > 0) {
        requireThat(!next.revision_reviews.some(r => r.review_id === review.review_id), 'revision_reviews: duplicate review_id');
        next.revision_reviews = revisionReviews(next);
      }
    }
    if (event === 'revise') surface = packet.executor;
    if (event === 'submit') next.escalations.push(...structuredClone(result.challenges).map(challenge => ({ challenge, resolution_ref: null })));
    if (result.challenges.some(c => c.blocking)) {
      requireThat(event === 'submit', 'challenge: must return to Chat before review');
      next.state = 'PLAN'; action = 'escalate';
    }
  }
  if (event === 'challenge' || event === 'escalate') {
    validateExecution(packet, snapshot);
    if (snapshot.active_packet !== null) requireThat(isDeepStrictEqual(packetIdentity(packet), snapshot.active_packet), 'active_packet: stale Challenge');
    validateChallenge(request.challenge, packet);
    if (event === 'escalate') requireThat(request.challenge.blocking, 'review.ESCALATE requires blocking Challenge');
    next.escalations.push({ challenge: structuredClone(request.challenge), resolution_ref: null });
    if (request.challenge.blocking) { action = 'escalate'; next.state = 'PLAN'; }
    else { action = 'challenge_noted'; next.state = snapshot.state; }
  }
  if (event === 'reopen') next.lifecycle++;
  if (blockedResult) surface = 'CHAT';
  validateSnapshot(next);
  return { surface, action, snapshot: next, ...(blockedResult ? { result: blockedResult } : {}) };
}
