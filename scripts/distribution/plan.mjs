import { DistributionError, canonicalSha256, validateApprovalReceipt, validateOperationPlan } from './contracts.mjs';
import { compareSemVer } from './version.mjs';

export function buildOperationPlan(input) {
  const blockers = [...input.blockers];
  if (input.operation === 'install' && input.current_release !== null) blockers.push('Install target already exists');
  if (input.operation !== 'install' && input.current_release === null) blockers.push('Current installation identity is required');
  if (input.current_release) {
    const order = compareSemVer(input.target_release.version, input.current_release.version);
    if (input.operation === 'update' && order <= 0) blockers.push('Update requires a newer release');
    if (input.operation === 'rollback' && order >= 0) blockers.push('Rollback requires an older release');
    if (input.operation === 'migrate' && canonicalSha256(input.target_release) !== canonicalSha256(input.current_release)) blockers.push('Migration must keep software identity');
  }
  const plan = { ...input, blockers, status: blockers.length ? 'blocked' : 'ready' };
  validateOperationPlan(plan);
  return plan;
}

export function validateApprovalForPlan(plan, receipt, now = new Date().toISOString()) {
  try {
    validateOperationPlan(plan);
    validateApprovalReceipt(receipt);
    const time = Date.parse(now);
    if (!Number.isFinite(time) || plan.status !== 'ready' || (plan.requires_maintenance && !receipt.writers_stopped) || time < Date.parse(receipt.issued_at) || time >= Date.parse(receipt.expires_at) || time >= Date.parse(plan.expires_at) || Date.parse(receipt.issued_at) >= Date.parse(receipt.expires_at)) throw new Error('Approval is not currently valid');
    if (receipt.plan_id !== plan.plan_id || receipt.plan_sha256 !== canonicalSha256(plan) || receipt.operation !== plan.operation || receipt.install_id !== plan.install_id || receipt.projects.slice().sort().join('\0') !== plan.projects.map(x => x.project_id).sort().join('\0')) throw new Error('Approval scope or plan differs');
    return receipt;
  } catch { throw new DistributionError('INVALID_APPROVAL', 'Approval does not bind this ready plan'); }
}
