// Pure Workshop decisions. The host interprets language and supplies facts; this module has no I/O or governance writes.
export const evidenceClasses = Object.freeze([
  'VERIFIED_OFFICIAL', 'VERIFIED_PRIMARY', 'THIRD_PARTY',
  'USER_PROVIDED', 'INFERENCE', 'UNKNOWN',
]);

export function chooseWorkshop({ mode = 'AUTO', smallTask = false, goalKnown = false,
  scopeKnown = false, outcomeKnown = false, productChoiceOpen = false } = {}) {
  if (!['AUTO', 'FORCE', 'BYPASS'].includes(mode)) throw new Error('Unknown Workshop mode');
  if (mode === 'BYPASS') return { enter: false, depth: 'none', reason: 'explicit_bypass' };
  if (mode === 'FORCE') return { enter: true, depth: smallTask ? 'light' : 'standard', reason: 'explicit_force' };
  if (smallTask) return { enter: false, depth: 'none', reason: 'defined_small_task' };
  const needsDiscovery = !goalKnown || !scopeKnown || !outcomeKnown || productChoiceOpen;
  return needsDiscovery
    ? { enter: true, depth: 'standard', reason: 'decision_gap' }
    : { enter: false, depth: 'none', reason: 'defined_task' };
}

export function advanceDiscovery({ unknowns = [], evidence = [] } = {}) {
  for (const item of evidence) {
    if (!evidenceClasses.includes(item.classification)) throw new Error('Unknown evidence classification');
  }
  const pending = unknowns.filter(item => !item.answer?.trim());
  const blocking = pending.filter(item => item.blocking);
  const nonBlocking = pending.filter(item => !item.blocking).map(item => item.id);
  const next = blocking.reduce((best, item) => !best || (item.impact ?? 0) > (best.impact ?? 0) ? item : best, null);
  if (!next) return { readiness: 'ready', next: null, nonBlocking };
  const verified = evidence.some(item => item.supports === next.id &&
    ['VERIFIED_OFFICIAL', 'VERIFIED_PRIMARY'].includes(item.classification));
  if (next.externalFactNeeded && next.decisionImpact && !verified) {
    return { readiness: 'needs_research', next: { id: next.id, question: next.question,
      researchNeed: next.externalFactNeeded }, nonBlocking };
  }
  if (next.userUnsure && next.owner === 'EXECUTOR' && next.withinScope && next.recommendation) {
    return { readiness: 'needs_technical_choice', next: { id: next.id,
      recommendation: next.recommendation, explanation: next.explanation ?? '' }, nonBlocking };
  }
  if (next.userUnsure) return { readiness: 'needs_decision', next: { id: next.id,
    question: next.question, explanation: next.explanation ?? '',
    alternatives: next.alternatives ?? [], recommendation: next.recommendation ?? '' },
    nonBlocking };
  return { readiness: 'needs_answer', next: { id: next.id, question: next.question },
    nonBlocking };
}

const sectionNames = [
  ['problem', 'Problem'], ['usersScenario', 'Users / Scenario'],
  ['desiredOutcome', 'Desired Outcome'], ['scopeIn', 'Scope In'], ['scopeOut', 'Scope Out'],
  ['evidence', 'Evidence'], ['proposedApproach', 'Proposed Approach'],
  ['alternatives', 'Alternatives'], ['keyDecisions', 'Key Decisions'],
  ['openQuestions', 'Open Questions'], ['successCriteria', 'Success Criteria'],
  ['deliveryDepth', 'Delivery Depth'],
];

export function createProductBrief({ sections, discovery, deliveryComplete = false,
  superseded = false, confirmedDecisions = [] }) {
  if (!sections || !discovery) throw new Error('Brief needs sections and discovery');
  for (const decision of confirmedDecisions) {
    if (!decision?.text?.trim() || !decision?.trustedApprovalRef?.trim() ||
      !['user_instruction', 'user_delegation'].includes(decision.sourceKind)) {
      throw new Error('Confirmed decision needs a trusted approval reference');
    }
  }
  const required = sectionNames.map(([key]) => key).filter(key => key !== 'keyDecisions');
  const filled = required.every(key => typeof sections[key] === 'string' && sections[key].trim());
  const status = superseded ? 'superseded'
    : discovery.readiness === 'ready' && deliveryComplete && filled ? 'ready' : 'draft';
  const content = { ...sections,
    keyDecisions: confirmedDecisions.length
      ? confirmedDecisions.map(d => `- ${d.text} (approval: ${d.trustedApprovalRef})`).join('\n')
      : 'No confirmed decisions recorded.',
  };
  const body = sectionNames.map(([key, title]) => `## ${title}\n${content[key] || 'Pending.'}`).join('\n\n');
  return { status, markdown: `<!-- ProductBriefV1; status: ${status} -->\n# Product Brief\n\n${body}\n\n` +
    'Recommendation is not a decision or execution authorization. A ready Brief is input to PLAN only.\n' };
}
