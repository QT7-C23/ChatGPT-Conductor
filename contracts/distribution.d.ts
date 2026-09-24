export type Channel = 'stable' | 'preview';
export type Scope = 'user' | 'project';
export type Operation = 'install' | 'update' | 'rollback' | 'migrate';
export interface Repository { host: 'github.com'; full_name: 'QT7-C23/ChatGPT-Conductor'; id: '1382745738' }
export interface FileIdentity { path: string; bytes: number; sha256: string }
export interface AssetIdentity { name: string; bytes: number; sha256: string }
export interface ReleaseDescriptor {
  repository: Repository; tag: string; source_commit: string; release_id: string; version: string;
  manifest_sha256: string; payload_sha256: string; changelog_sha256: string;
  immutable: true; draft: false; prerelease: boolean; channel: Channel; skill_id: 'chatgpt-conductor' | 'project-orchestrator';
}
export interface MigrationDescriptor {
  id: string; from_profile: string; to_profile: 'po-1.1.3'; from_software_versions: string[];
  target_software_version: string; kind: 'legacy-data' | 'layout'; handler_id: 'po-legacy-snapshot-v1' | 'conductor-layout-v1';
  preconditions: string[]; state_effect: string; authorization_effect: string; rollback_mode: string; impact_summary: string;
}
export interface ManifestV1 {
  manifest_version: 1; product: 'chatgpt-conductor'; version: string; channel: Channel; repository: Repository;
  tag: string; source_commit: string; release_id: string; skill_id: 'chatgpt-conductor' | 'project-orchestrator';
  payload: AssetIdentity & { archive_root: string; files: FileIdentity[] }; changelog: AssetIdentity;
  runtime: { node_majors: number[]; platforms: ('win32-x64' | 'linux-x64')[]; min_manager_version: string };
  data_contract: { schema_version: 2; profile: 'po-1.1.3'; read_profiles: string[]; write_profile: 'po-1.1.3' };
  upgrade_from: string[]; migrations: MigrationDescriptor[]; verification: { profile: 'conductor-node-verify-v1' };
  baseline_provenance: null | { source_archive_sha256: string; source_version: string; source_prefix: string; source_file_inventory_sha256: string };
}
export interface ProjectBindings { packet_path: string | null; result_path: string | null; historical_source_path?: string; historical_review_path?: string; reference_roots: string[]; evidence: { ref: string; root_path: string; path: string; resolution: 'relative' | 'absolute' | 'bound' }[] }
export interface ProjectInventory { bindings?: ProjectBindings; project_id: string; root_path: string; state_path: string; directories: string[]; files: FileIdentity[]; schema_version: 1 | 2; profile: 'po-1.1.3' | 'po-legacy-schema1' | 'po-legacy-schema2' }
export interface InstallationRecord {
  installation_version: 1; install_id: string; manager_version: string; generation: number; channel: Channel; scope: Scope;
  active_path: string; control_path: string; release: ReleaseDescriptor; projects: ProjectInventory[];
  last_transaction_id: string | null; last_snapshot_path: string | null;
}
export interface OperationPlan {
  offline?: { freshness: 'stale-offline'; revocation: 'unknown' };
  registration?: { before_projects: ProjectInventory[]; added_project_ids: string[] };
  layout?: { from: string; to: string };
  adoption?: { source: 'manual-v1.1.3'; registry_absent: true };
  data_change?: {
    stage_path: string; after_projects: ProjectInventory[];
    resources: { path: string; kind: 'file' | 'directory'; before_sha256: string | null; after_sha256: string | null }[];
    migrations: { project_id: string; destination: string; packet_path: string | null; result_path: string | null; review_path: string | null; confirmation_path: string }[];
    selected_snapshot: (FileIdentity & { transaction_id: string; created_at: string }) | null;
    loss_window: { from: string; to: string } | null;
  };
  operation: Operation; install_id: string; scope: Scope; active_path: string; target_active_path: string; control_path: string;
  generation: number; current_release: ReleaseDescriptor | null; target_release: ReleaseDescriptor; current_files: FileIdentity[];
  channel: Channel; projects: ProjectInventory[]; software_only: boolean; migration_ids: string[]; impact: string;
  changelog: { body: string; sha256: string }; writes: string[]; recovery: string[];
  snapshot: { path: string; capacity_bytes: number }; checks: string[]; quiescence: string[]; requires_maintenance: boolean;
  expires_at: string; plan_id: string; blockers: string[]; status: 'ready' | 'blocked';
}
export interface ApprovalReceipt {
  plan_id: string; plan_sha256: string; operation: Operation; install_id: string; projects: string[];
  approval_source: string; user_approved: true; writers_stopped: boolean; issued_at: string; expires_at: string; use_id: string;
}
export interface JournalV1 {
  journal_version: 1; transaction_id: string; plan: OperationPlan; approval: ApprovalReceipt; plan_sha256: string; approval_sha256: string;
  manager_release: ReleaseDescriptor; before_generation: number; after_generation: number; paths: string[];
  before_resources: FileIdentity[]; after_resources: FileIdentity[]; snapshots: FileIdentity[];
  phase: 'PLANNED' | 'APPROVED' | 'PREPARED' | 'SNAPSHOTTED' | 'STAGED' | 'VERIFIED' | 'COMMITTING' | 'COMMITTED' | 'SUCCEEDED' | 'ABORTED' | 'RECOVERING' | 'RESTORED' | 'RECOVERY_REQUIRED';
  sequence: number; actions: { sequence: number; kind: 'replace' | 'move' | 'write' | 'snapshot' | 'verify'; source: string | null; destination: string; before_sha256: string | null; after_sha256: string | null; intent: boolean; completed: boolean }[];
  verification: string[]; result: string | null;
}
export declare class DistributionError extends Error { code: string; constructor(code: string, message: string) }
export declare function canonicalJson(value: unknown): string;
export declare function canonicalSha256(value: unknown): string;
export declare function validateManifest(value: unknown): ManifestV1;
export declare function validateReleaseDescriptor(value: unknown): ReleaseDescriptor;
export declare function validateInstallationRecord(value: unknown): InstallationRecord;
export declare function validateProjectInventory(value: unknown): ProjectInventory;
export declare function validateOperationPlan(value: unknown): OperationPlan;
export declare function validateApprovalReceipt(value: unknown): ApprovalReceipt;
export declare function validateJournal(value: unknown): JournalV1;
export declare function compareSemVer(a: string, b: string): number;
export declare function selectRelease(releases: ReleaseDescriptor[], options?: { channel?: Channel; current?: ReleaseDescriptor | null; dirty?: boolean }): { status: 'unavailable' | 'available' | 'no_op' | 'blocked'; target: ReleaseDescriptor | null; candidates: ReleaseDescriptor[]; reason?: string };
export declare function buildOperationPlan(input: Omit<OperationPlan, 'status'>): OperationPlan;
export declare function validateApprovalForPlan(plan: OperationPlan, receipt: ApprovalReceipt, now?: string): ApprovalReceipt;
