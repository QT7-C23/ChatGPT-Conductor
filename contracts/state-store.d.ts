/** Future adapter contract only. V1 has no database, MCP client or backend runtime. */
export type Stage = 'DISCUSS' | 'PLAN' | 'READY_TO_EXECUTE' | 'EXECUTE' | 'REVIEW' | 'REVISE' | 'COMPLETE';
export interface LockedDecision {
  id: string;
  decision: string;
  rationale: string;
  approval_ref: string;
}
export interface OpenDecision {
  id: string;
  question: string;
  owner: 'EXECUTOR' | 'CHAT' | 'USER';
  blocking: boolean;
}
export interface ProjectState {
  schema_version: 2;
  project_id: string;
  revision: number;
  state: Stage;
  decision_version: number;
  lifecycle: number;
  locked_decisions: LockedDecision[];
  open_decisions: OpenDecision[];
  active_packet: { packet_id: string; packet_revision: number; task_id: string; content_sha256: string; decision_version: number; locked_decisions_sha256: string; lifecycle: number; boundary_sha256: string } | null;
  escalations: { challenge: Challenge; resolution_ref: string | null }[];
  review_record: ChatReviewRecord | null;
  result_sha256: string | null;
  revision_reviews: RetainedRevisionReview[];
  plan_approvals: PlanApproval[];
  migration_record: MigrationRecord | null;
}
export interface PacketLink {
  lifecycle: number;
  project_id: string;
  task_id: string;
  packet_id: string;
  packet_revision: number;
  decision_version: number;
  executor: 'WORK' | 'CODEX';
}
export interface Challenge extends PacketLink {
  blocking: boolean;
  decision_id: string;
  reason: string;
  evidence: string;
  proposal: string;
  impact: string;
  affected_tasks: string[];
}
export interface ChatReviewRecord extends PacketLink {
  schema_version: 2;
  review_id: string;
  reviewer: 'CHAT';
  acceptance_results: { criterion_id: string; status: 'passed' | 'failed' | 'not_run'; evidence: string }[];
  locked_decision_compliance: { decision_id: string; status: 'compliant' | 'violated' | 'not_checked'; evidence: string }[];
  verdict: 'ACCEPT' | 'REVISE' | 'ESCALATE';
  revision_instructions: string[];
  evidence: string;
  result_sha256: string;
  supersedes_review_id: string | null;
  /** Exact current plan/migration/ESCALATE requirement id; only valid for REVISE. */
  supersedes_requirement_id?: string;
}
/** Runtime history keeps raw Review evidence plus derived additive context for ESCALATE. */
export type RetainedRevisionReview = (ChatReviewRecord & { verdict: 'REVISE' }) | (ChatReviewRecord & {
  verdict: 'ESCALATE';
  inherited_requirement: ActiveRevisionRequirement | null;
});
export interface ApprovalRecord {
  reviewer: 'CHAT';
  source_kind: 'user_instruction' | 'user_delegation';
  approval_ref: string;
  from_packet_sha256: string | null;
  to_packet_sha256: string;
  replaces_review_id: string | null;
  replaces_requirement_id?: string;
  state_revision: number;
  lifecycle: number;
  revision_instructions: string[];
}
export interface ReplanApproval extends ApprovalRecord { kind?: never; }
export interface ExecutionApproval extends ApprovalRecord, PacketLink {
  kind: 'execution';
  approval_id: string;
}
export type PlanApproval = ReplanApproval | ExecutionApproval;
export interface ActiveRevisionRequirement {
  id: string;
  source: 'review' | 'plan' | 'migration';
  lifecycle: number;
  instructions: string[];
}
export interface MigrationRecord {
  source_schema: 1 | 2;
  source_state: Stage;
  source_sha256: string;
  packet_sha256: string | null;
  result_sha256: string | null;
  review_sha256: string | null;
  source_kind: 'user_instruction' | 'user_delegation';
  approval_ref: string;
  evidence_ref: string;
  authorization_inherited: false;
  target_lifecycle: number;
  pending_revision_instructions: string[];
}
export interface CapabilityPreflight extends PacketLink {
  checked_capabilities: { capability: string; available: boolean; evidence: string }[];
  recovery_conditions: string[];
}
export type SideEffectAction = 'local_files_write' | 'repository_modify' | 'email_send' | 'pr_create' | 'deploy' | 'data_delete' | 'production_modify' | 'external_send';
export interface SideEffects {
  allowed: { action: SideEffectAction; target: string; authorization_ref: string }[];
  require_escalation: { action: SideEffectAction; target: string; reason: string }[];
  forbidden: { action: SideEffectAction; target: string; reason: string }[];
}
export interface ProjectStateStore {
  read(projectId: string): Promise<ProjectState | null>;
  /** Atomic compare-and-set: next.revision === expectedRevision + 1; no last-writer-wins. */
  compareAndSet(projectId: string, expectedRevision: number, next: ProjectState): Promise<
    { ok: true; revision: number } | { ok: false; reason: 'conflict' | 'not_found' }
  >;
}
