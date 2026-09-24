import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson, canonicalSha256, validateManifest, validateReleaseDescriptor, validateInstallationRecord, validateOperationPlan, validateApprovalReceipt, validateJournal } from '../scripts/distribution/contracts.mjs';
import { compareSemVer, selectRelease } from '../scripts/distribution/version.mjs';
import { buildOperationPlan, validateApprovalForPlan } from '../scripts/distribution/plan.mjs';

const h = 'a'.repeat(64);
const repo = { host: 'github.com', full_name: 'QT7-C23/ChatGPT-Conductor', id: '1382745738' };
const manifest = (version = '1.2.0') => ({ manifest_version: 1, product: 'chatgpt-conductor', version, channel: version.includes('-') ? 'preview' : 'stable', repository: repo, tag: `v${version}`, source_commit: 'b'.repeat(40), release_id: '123', skill_id: 'chatgpt-conductor', payload: { name: `chatgpt-conductor-${version}.zip`, bytes: 3, sha256: h, archive_root: 'chatgpt-conductor', files: [{ path: 'SKILL.md', bytes: 3, sha256: h }] }, changelog: { name: 'CHANGELOG.md', bytes: 3, sha256: h }, runtime: { node_majors: [22, 24], platforms: ['win32-x64', 'linux-x64'], min_manager_version: '1.2.0' }, data_contract: { schema_version: 2, profile: 'po-1.1.3', read_profiles: ['po-1.1.3'], write_profile: 'po-1.1.3' }, upgrade_from: ['1.1.3'], migrations: [], verification: { profile: 'conductor-node-verify-v1' }, baseline_provenance: null });
const descriptor = (version = '1.2.0') => ({ repository: repo, tag: `v${version}`, source_commit: 'b'.repeat(40), release_id: '123', version, manifest_sha256: h, payload_sha256: h, changelog_sha256: h, immutable: true, draft: false, prerelease: version.includes('-'), channel: version.includes('-') ? 'preview' : 'stable', skill_id: version === '1.1.3' ? 'project-orchestrator' : 'chatgpt-conductor' });
const project = { project_id: 'p', root_path: '/data', state_path: '/data/state.json', directories: ['/data'], files: [{ path: '/data/state.json', bytes: 3, sha256: h }], schema_version: 2, profile: 'po-1.1.3' };

test('canonical digest sorts keys and rejects ambiguous numbers', () => {
  assert.equal(canonicalJson({ z: [2, 1], a: 1 }), '{"a":1,"z":[2,1]}');
  assert.equal(canonicalSha256({ z: [2, 1], a: 1 }), canonicalSha256({ a: 1, z: [2, 1] }));
  assert.throws(() => canonicalJson({ x: 1.5 }), { code: 'INVALID_CONTRACT' });
});

test('manifest is strict at every boundary', () => {
  assert.equal(validateManifest(manifest()).version, '1.2.0');
  for (const bad of [ { ...manifest(), surprise: true }, { ...manifest(), manifest_version: 2 }, { ...manifest(), repository: { ...repo, id: '999' } }, { ...manifest(), channel: 'preview' }, { ...manifest(), release_id: 123 }, { ...manifest(), runtime: { ...manifest().runtime, node_majors: [1] } }, { ...manifest(), payload: { ...manifest().payload, bytes: 1.2 } }, { ...manifest(), data_contract: { ...manifest().data_contract, profile: 'unknown' } }, { ...manifest(), payload: { ...manifest().payload, files: [...manifest().payload.files, manifest().payload.files[0]] } } ]) assert.throws(() => validateManifest(bad), { code: 'INVALID_CONTRACT' });
});

test('release identity and channel contradictions fail closed', () => {
  assert.equal(validateReleaseDescriptor(descriptor()).version, '1.2.0');
  for (const bad of [{ ...descriptor(), immutable: false }, { ...descriptor(), draft: true }, { ...descriptor(), prerelease: true }, { ...descriptor(), tag: 'v1.2.1' }, { ...descriptor(), release_id: 123 }, { ...descriptor(), repository: { ...repo, full_name: 'Other/Repo' } }]) assert.throws(() => validateReleaseDescriptor(bad), { code: 'INVALID_CONTRACT' });
});

test('SemVer selection sorts numerical prereleases and detects duplicate identities', () => {
  assert.ok(compareSemVer('1.2.0-rc.10', '1.2.0-rc.2') > 0);
  assert.ok(compareSemVer('1.2.0-alpha-2', '1.2.0-alpha-1') > 0);
  assert.equal(selectRelease([descriptor('1.2.0-alpha-1'), descriptor('1.2.0-alpha-2')], { channel: 'preview' }).target.version, '1.2.0-alpha-2');
  assert.ok(compareSemVer('1.2.0', '1.2.0-rc.10') > 0);
  assert.equal(selectRelease([descriptor('1.2.0-rc.10'), descriptor('1.2.0-rc.2'), descriptor('1.2.0')]).target.version, '1.2.0');
  assert.equal(selectRelease([descriptor('1.2.0-rc.10'), descriptor('1.2.0-rc.2')]).status, 'unavailable');
  assert.equal(selectRelease([descriptor('1.2.0-rc.10'), descriptor('1.2.0-rc.2')], { channel: 'preview' }).target.version, '1.2.0-rc.10');
  assert.throws(() => selectRelease([descriptor(), { ...descriptor(), payload_sha256: 'c'.repeat(64) }]), { code: 'RELEASE_CONFLICT' });
  assert.equal(selectRelease([descriptor()], { current: descriptor() }).status, 'no_op');
  assert.equal(selectRelease([descriptor()], { current: descriptor(), dirty: true }).status, 'blocked');
  assert.throws(() => selectRelease([{ ...descriptor(), payload_sha256: 'c'.repeat(64) }], { current: descriptor() }), { code: 'RELEASE_CONFLICT' });
});

test('plan binds state and approval; blocked plans cannot apply', () => {
  const notesHash = createHash('sha256').update('Release notes').digest('hex');
  const input = { operation: 'update', install_id: 'install-1', scope: 'project', active_path: '/skills/chatgpt-conductor', target_active_path: '/skills/chatgpt-conductor', control_path: '/skills/.conductor/install-1', generation: 1, current_release: descriptor('1.1.3'), target_release: { ...descriptor(), changelog_sha256: notesHash }, current_files: [{ path: '/skills/chatgpt-conductor/SKILL.md', bytes: 3, sha256: h }], channel: 'stable', projects: [project], software_only: false, migration_ids: [], impact: 'Code files change; project data stays unchanged.', changelog: { body: 'Release notes', sha256: notesHash }, writes: ['/skills/chatgpt-conductor', '/skills/.conductor/install-1/installation.json'], recovery: ['/skills/chatgpt-conductor', '/data/state.json'], snapshot: { path: '/data/snapshot', capacity_bytes: 1024 }, checks: ['release', 'snapshot'], quiescence: ['stop writers'], requires_maintenance: true, expires_at: '2026-09-25T00:00:00.000Z', plan_id: 'plan-1', blockers: [] };
  const plan = buildOperationPlan(input);
  assert.equal(validateOperationPlan(plan).status, 'ready');
  const receipt = { plan_id: plan.plan_id, plan_sha256: canonicalSha256(plan), operation: plan.operation, install_id: plan.install_id, projects: ['p'], approval_source: 'trusted-host', user_approved: true, writers_stopped: true, issued_at: '2026-09-24T00:00:00.000Z', expires_at: '2026-09-24T23:00:00.000Z', use_id: 'once-1' };
  assert.equal(validateApprovalReceipt(receipt).use_id, 'once-1');
  assert.equal(validateApprovalForPlan(plan, receipt, '2026-09-24T12:00:00.000Z').use_id, 'once-1');
  assert.throws(() => validateApprovalForPlan({ ...plan, impact: 'altered' }, receipt, '2026-09-24T12:00:00.000Z'), { code: 'INVALID_APPROVAL' });
  assert.throws(() => validateApprovalForPlan(plan, receipt, '2026-09-25T00:00:00.000Z'), { code: 'INVALID_APPROVAL' });
  assert.throws(() => validateApprovalForPlan(plan, { ...receipt, projects: ['p', 'q'] }, '2026-09-24T12:00:00.000Z'), { code: 'INVALID_APPROVAL' });
  assert.throws(() => validateApprovalForPlan(plan, { ...receipt, writers_stopped: false }, '2026-09-24T12:00:00.000Z'), { code: 'INVALID_APPROVAL' });
  const unrelatedNotes = { ...input, target_release: descriptor() };
  assert.throws(() => buildOperationPlan(unrelatedNotes), { code: 'INVALID_CONTRACT' });
  assert.throws(() => validateOperationPlan({ ...plan, target_release: descriptor() }), { code: 'INVALID_CONTRACT' });
  const forgedDowngrade = { ...plan, current_release: descriptor(), target_release: descriptor('1.1.3'), changelog: { body: '', sha256: createHash('sha256').update('').digest('hex') }, status: 'ready', blockers: [] };
  forgedDowngrade.target_release = { ...forgedDowngrade.target_release, changelog_sha256: forgedDowngrade.changelog.sha256 };
  assert.throws(() => validateOperationPlan(forgedDowngrade), { code: 'INVALID_CONTRACT' });
  assert.throws(() => validateApprovalForPlan(forgedDowngrade, { ...receipt, plan_sha256: canonicalSha256(forgedDowngrade) }, '2026-09-24T12:00:00.000Z'), { code: 'INVALID_APPROVAL' });
  const forgedInstall = { ...plan, operation: 'install', status: 'ready', blockers: [] };
  assert.throws(() => validateOperationPlan(forgedInstall), { code: 'INVALID_CONTRACT' });
  const forgedMigrate = { ...plan, operation: 'migrate', status: 'ready', blockers: [] };
  assert.throws(() => validateOperationPlan(forgedMigrate), { code: 'INVALID_CONTRACT' });
  assert.equal(buildOperationPlan({ ...input, channel: 'preview' }).status, 'ready');
  assert.throws(() => buildOperationPlan({ ...input, software_only: true }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => buildOperationPlan({ ...input, projects: [{ ...project, profile: 'po-legacy-schema2' }] }), { code: 'INVALID_CONTRACT' });
  const oldRelease = { ...descriptor('1.1.3'), changelog_sha256: notesHash };
  assert.equal(buildOperationPlan({ ...input, operation: 'migrate', current_release: oldRelease, target_release: oldRelease, projects: [{ ...project, profile: 'po-legacy-schema2' }], migration_ids: ['po-legacy-snapshot-v1'] }).status, 'ready');
  assert.equal(buildOperationPlan({ ...input, active_path: 'C:/skills/conductor', target_active_path: 'C:/skills/conductor', control_path: 'C:/skills/.conductor/install-1', current_files: [], projects: [], software_only: true, writes: ['C:/skills/conductor'], recovery: ['C:/skills/conductor'], snapshot: { path: 'C:/skills/snapshot', capacity_bytes: 1 } }).status, 'ready');
  assert.throws(() => buildOperationPlan({ ...input, active_path: 'C:skills/conductor' }), { code: 'INVALID_CONTRACT' });
  assert.throws(() => buildOperationPlan({ ...input, active_path: 'C:/skills/CON/file' }), { code: 'INVALID_CONTRACT' });
  const blocked = buildOperationPlan({ ...input, blockers: ['dirty installation'] });
  assert.equal(blocked.status, 'blocked');
  assert.throws(() => validateApprovalForPlan(blocked, { ...receipt, plan_sha256: canonicalSha256(blocked) }, '2026-09-24T12:00:00.000Z'), { code: 'INVALID_APPROVAL' });
});

test('journal, installation and declarations remain strict and pure', () => {
  const installation = { installation_version: 1, install_id: 'install-1', manager_version: '1.2.0', generation: 1, channel: 'stable', scope: 'project', active_path: '/skills/chatgpt-conductor', control_path: '/skills/.conductor/install-1', release: descriptor(), projects: [project], last_transaction_id: null, last_snapshot_path: null };
  assert.equal(validateInstallationRecord(installation).generation, 1);
  assert.throws(() => validateInstallationRecord({ ...installation, generation: Number.MAX_SAFE_INTEGER + 1 }), { code: 'INVALID_CONTRACT' });
  const emptyHash = createHash('sha256').update('').digest('hex');
  const plan = buildOperationPlan({ operation: 'install', install_id: 'install-1', scope: 'project', active_path: '/skills/chatgpt-conductor', target_active_path: '/skills/chatgpt-conductor', control_path: '/skills/.conductor/install-1', generation: 0, current_release: null, target_release: { ...descriptor(), changelog_sha256: emptyHash }, current_files: [], channel: 'stable', projects: [], software_only: true, migration_ids: [], impact: 'Install software', changelog: { body: '', sha256: emptyHash }, writes: ['/skills/chatgpt-conductor'], recovery: ['/skills/chatgpt-conductor'], snapshot: { path: '/skills/.conductor/install-1/snapshot', capacity_bytes: 1 }, checks: [], quiescence: [], requires_maintenance: false, expires_at: '2026-09-25T00:00:00.000Z', plan_id: 'plan-2', blockers: [] });
  const approval = { plan_id: plan.plan_id, plan_sha256: canonicalSha256(plan), operation: 'install', install_id: 'install-1', projects: [], approval_source: 'trusted-host', user_approved: true, writers_stopped: false, issued_at: '2026-09-24T00:00:00.000Z', expires_at: '2026-09-24T23:00:00.000Z', use_id: 'once-2' };
  const journal = { journal_version: 1, transaction_id: 'tx-1', plan, approval, plan_sha256: canonicalSha256(plan), approval_sha256: canonicalSha256(approval), manager_release: descriptor(), before_generation: 1, after_generation: 2, paths: ['/skills/chatgpt-conductor'], before_resources: [{ path: '/skills/chatgpt-conductor', bytes: 3, sha256: h }], after_resources: [{ path: '/skills/chatgpt-conductor', bytes: 4, sha256: h }], snapshots: [], phase: 'PREPARED', sequence: 0, actions: [{ sequence: 0, kind: 'replace', source: '/skills/.conductor/install-1/staged', destination: '/skills/chatgpt-conductor', before_sha256: h, after_sha256: h, intent: true, completed: false }], verification: [], result: null };
  assert.equal(validateJournal(journal).phase, 'PREPARED');
  assert.throws(() => validateJournal({ ...journal, journal_version: 2 }), { code: 'INVALID_CONTRACT' });
  const declarations = readFileSync(new URL('../contracts/distribution.d.ts', import.meta.url), 'utf8');
  const declaredBody = name => declarations.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1];
  assert.match(declaredBody('OperationPlan'), /changelog: \{ body: string; sha256: string \}/);
  assert.match(declaredBody('ReleaseDescriptor'), /release_id: string/);
  assert.match(declaredBody('ManifestV1'), /release_id: string/);
  assert.match(declaredBody('ManifestV1'), /node_majors: number\[\]/);
  for (const file of ['contracts.mjs', 'version.mjs', 'plan.mjs']) assert.doesNotMatch(readFileSync(new URL(`../scripts/distribution/${file}`, import.meta.url), 'utf8'), /from ['"]\.\.\/(?:router|migration|cli|source|store|transaction)/);
});
