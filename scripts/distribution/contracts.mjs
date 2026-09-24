import { createHash } from 'node:crypto';

export class DistributionError extends Error {
  constructor(code, message) { super(message); this.name = 'DistributionError'; this.code = code; }
}
const fail = (message) => { throw new DistributionError('INVALID_CONTRACT', message); };
const object = (v, keys, label) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).sort().join('\0') !== keys.slice().sort().join('\0')) fail(`Invalid ${label} fields`);
  return v;
};
const string = (v, label, nonempty = true) => { if (typeof v !== 'string' || (nonempty && !v.length)) fail(`Invalid ${label}`); return v; };
const integer = (v, label, positive = false) => { if (!Number.isSafeInteger(v) || (positive ? v <= 0 : v < 0)) fail(`Invalid ${label}`); return v; };
const literal = (v, values, label) => { if (!values.includes(v)) fail(`Invalid ${label}`); return v; };
const array = (v, fn, label) => { if (!Array.isArray(v)) fail(`Invalid ${label}`); v.forEach((item, i) => fn(item, `${label}[${i}]`)); return v; };
const unique = (v, key, label) => { if (new Set(v.map(key)).size !== v.length) fail(`Duplicate ${label}`); };
const sha = (v, label) => { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) fail(`Invalid ${label}`); };
const semver = (v, label) => { if (typeof v !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?$/.test(v)) fail(`Invalid ${label}`); };
export function compareSemVer(a, b) {
  semver(a, 'version'); semver(b, 'version');
  const parse = (v) => {
    const dash = v.indexOf('-');
    return { core: (dash < 0 ? v : v.slice(0, dash)).split('.').map(BigInt), pre: dash < 0 ? null : v.slice(dash + 1).split('.') };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i] ? 1 : -1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    if (x.pre[i] === y.pre[i]) continue;
    const xn = /^\d+$/.test(x.pre[i]), yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn) return BigInt(x.pre[i]) > BigInt(y.pre[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x.pre[i] > y.pre[i] ? 1 : -1;
  }
  return 0;
}
const path = (v, label, absolute = false) => {
  string(v, label);
  const drive = /^[A-Z]:\//.test(v);
  const body = absolute ? drive ? v.slice(3) : v.startsWith('/') ? v.slice(1) : v : v;
  const components = body.split('/');
  if (v.includes('\\') || v.includes('\0') || components.some(p => p === '..' || p === '.' || p === '' || p.includes(':') || /[. ]$/.test(p) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p)) || (absolute ? !(v.startsWith('/') && !v.startsWith('//') || drive) : v.startsWith('/') || v.includes(':'))) fail(`Unsafe ${label}`);
};
const repo = (v) => { object(v, ['host', 'full_name', 'id'], 'repository'); if (v.host !== 'github.com' || v.full_name !== 'QT7-C23/ChatGPT-Conductor' || v.id !== '1382745738') fail('Repository mismatch'); };
const identity = (v, channel) => {
  semver(v.version, 'version');
  if (v.tag !== `v${v.version}` || !/^[0-9a-f]{40}$/.test(v.source_commit) || typeof v.release_id !== 'string' || !/^[1-9]\d*$/.test(v.release_id)) fail('Release identity mismatch');
  literal(v.channel, ['stable', 'preview'], 'channel');
  if ((v.version.includes('-') ? 'preview' : 'stable') !== v.channel || (channel && channel !== v.channel)) fail('Channel mismatch');
  if (v.skill_id !== (v.version === '1.1.3' ? 'project-orchestrator' : 'chatgpt-conductor')) fail('Skill mismatch');
  repo(v.repository);
};
const file = (v, label, absolute = false) => { object(v, ['path', 'bytes', 'sha256'], label); path(v.path, `${label}.path`, absolute); integer(v.bytes, `${label}.bytes`); sha(v.sha256, `${label}.sha256`); };
const asset = (v, label) => { object(v, ['name', 'bytes', 'sha256'], label); string(v.name, `${label}.name`); if (v.name.includes('/') || v.name.includes('\\') || v.name === '.' || v.name === '..') fail(`Invalid ${label}.name`); integer(v.bytes, `${label}.bytes`, true); sha(v.sha256, `${label}.sha256`); };
const profile = (v, legacy = false) => literal(v, legacy ? ['po-1.1.3', 'po-legacy-schema1', 'po-legacy-schema2'] : ['po-1.1.3'], 'profile');
const migration = (v) => {
  object(v, ['id', 'from_profile', 'to_profile', 'from_software_versions', 'target_software_version', 'kind', 'handler_id', 'preconditions', 'state_effect', 'authorization_effect', 'rollback_mode', 'impact_summary'], 'migration');
  string(v.id, 'migration.id'); profile(v.from_profile, true); profile(v.to_profile); array(v.from_software_versions, semver, 'from_software_versions'); semver(v.target_software_version, 'target_software_version'); literal(v.kind, ['legacy-data', 'layout'], 'migration.kind'); literal(v.handler_id, ['po-legacy-snapshot-v1', 'conductor-layout-v1'], 'handler_id');
  if ((v.kind === 'legacy-data') !== (v.handler_id === 'po-legacy-snapshot-v1')) fail('Migration handler mismatch');
  array(v.preconditions, string, 'preconditions'); ['state_effect', 'authorization_effect', 'rollback_mode', 'impact_summary'].forEach(k => string(v[k], `migration.${k}`));
};

export function validateManifest(v) {
  object(v, ['manifest_version', 'product', 'version', 'channel', 'repository', 'tag', 'source_commit', 'release_id', 'skill_id', 'payload', 'changelog', 'runtime', 'data_contract', 'upgrade_from', 'migrations', 'verification', 'baseline_provenance'], 'manifest');
  if (v.manifest_version !== 1 || v.product !== 'chatgpt-conductor') fail('Unsupported manifest'); identity(v);
  object(v.payload, ['name', 'bytes', 'sha256', 'archive_root', 'files'], 'payload'); asset({ name: v.payload.name, bytes: v.payload.bytes, sha256: v.payload.sha256 }, 'payload');
  if (v.payload.name !== `chatgpt-conductor-${v.version}.zip` || v.payload.archive_root !== v.skill_id) fail('Invalid payload identity');
  array(v.payload.files, file, 'payload.files'); unique(v.payload.files, x => x.path.toLowerCase(), 'payload file'); asset(v.changelog, 'changelog'); if (v.changelog.name !== 'CHANGELOG.md') fail('Invalid changelog');
  object(v.runtime, ['node_majors', 'platforms', 'min_manager_version'], 'runtime'); array(v.runtime.node_majors, (x) => literal(x, [22, 24], 'Node major'), 'node_majors'); unique(v.runtime.node_majors, x => x, 'Node major'); array(v.runtime.platforms, (x) => literal(x, ['win32-x64', 'linux-x64'], 'platform'), 'platforms'); unique(v.runtime.platforms, x => x, 'platform'); semver(v.runtime.min_manager_version, 'min_manager_version');
  object(v.data_contract, ['schema_version', 'profile', 'read_profiles', 'write_profile'], 'data_contract'); if (v.data_contract.schema_version !== 2) fail('Unknown data schema'); profile(v.data_contract.profile); profile(v.data_contract.write_profile); array(v.data_contract.read_profiles, x => profile(x, true), 'read_profiles'); unique(v.data_contract.read_profiles, x => x, 'read profile');
  array(v.upgrade_from, semver, 'upgrade_from'); unique(v.upgrade_from, x => x, 'upgrade_from'); array(v.migrations, migration, 'migrations'); unique(v.migrations, x => x.id, 'migration'); for (const m of v.migrations) if (m.target_software_version !== v.version) fail('Migration target mismatch');
  object(v.verification, ['profile'], 'verification'); if (v.verification.profile !== 'conductor-node-verify-v1') fail('Unknown verification profile');
  if (v.baseline_provenance !== null) { const b = object(v.baseline_provenance, ['source_archive_sha256', 'source_version', 'source_prefix', 'source_file_inventory_sha256'], 'baseline_provenance'); sha(b.source_archive_sha256, 'source_archive_sha256'); semver(b.source_version, 'source_version'); path(b.source_prefix, 'source_prefix'); sha(b.source_file_inventory_sha256, 'source_file_inventory_sha256'); }
  return v;
}

export function validateReleaseDescriptor(v) {
  object(v, ['repository', 'tag', 'source_commit', 'release_id', 'version', 'manifest_sha256', 'payload_sha256', 'changelog_sha256', 'immutable', 'draft', 'prerelease', 'channel', 'skill_id'], 'release descriptor'); identity(v);
  for (const k of ['manifest_sha256', 'payload_sha256', 'changelog_sha256']) sha(v[k], k);
  if (v.immutable !== true || v.draft !== false || v.prerelease !== (v.channel === 'preview')) fail('Release publication mismatch'); return v;
}
const project = (v) => {
  const keys = ['project_id', 'root_path', 'state_path', 'directories', 'files', 'schema_version', 'profile'];
  if (v && Object.hasOwn(v, 'bindings')) keys.push('bindings');
  object(v, keys, 'project');
  string(v.project_id, 'project_id'); path(v.root_path, 'root_path', true); path(v.state_path, 'state_path', true);
  if (!v.state_path.startsWith(v.root_path + '/')) fail('State outside project root');
  const roots = [v.root_path];
  if (v.bindings) {
    const bindingKeys = ['packet_path','result_path','reference_roots','evidence'];
    for (const key of ['historical_source_path','historical_review_path']) if (Object.hasOwn(v.bindings,key)) bindingKeys.push(key);
    const b = object(v.bindings, bindingKeys, 'project bindings');
    array(b.reference_roots, (x,l) => path(x,l,true), 'reference_roots');
    unique(b.reference_roots, x => x.toLowerCase(), 'reference root');
    roots.push(...b.reference_roots);
    for (const key of ['packet_path','result_path','historical_source_path','historical_review_path']) if (b[key] != null) path(b[key],key,true);
    array(b.evidence, e => {
      object(e,['ref','root_path','path','resolution'],'evidence binding');
      string(e.ref,'evidence ref'); path(e.root_path,'evidence root',true); path(e.path,'evidence path',true);
      literal(e.resolution,['relative','absolute','bound'],'evidence resolution');
      if (!roots.includes(e.root_path) || !e.path.startsWith(e.root_path + '/')) fail('Evidence outside recorded root');
    },'evidence');
    unique(b.evidence,e => e.root_path + '/' + e.ref,'evidence binding');
  }
  const within = x => roots.some(r => x.startsWith(r + '/'));
  array(v.directories, (x,l) => { path(x,l,true); if (!roots.includes(x) && !within(x)) fail('Directory outside project roots'); }, 'project.directories');
  unique(v.directories,x => x.toLowerCase(),'project directory');
  array(v.files,(x,l) => { file(x,l,true); if (!within(x.path)) fail('File outside project roots'); },'project.files');
  unique(v.files,x => x.path.toLowerCase(),'project file');
  if (!v.files.some(x => x.path === v.state_path) || ![[2,'po-1.1.3'],[1,'po-legacy-schema1'],[2,'po-legacy-schema2']].some(([s,p]) => v.schema_version === s && v.profile === p)) fail('Invalid project contract');
  if (v.bindings) for (const bound of [v.bindings.packet_path,v.bindings.result_path,v.bindings.historical_source_path,v.bindings.historical_review_path,...v.bindings.evidence.map(e => e.path)].filter(Boolean)) if (!v.files.some(f => f.path === bound)) fail('Bound reference missing from inventory');
};
export const validateProjectInventory = project;
const projects = (v) => { array(v, project, 'projects'); unique(v, x => x.project_id, 'project'); unique(v.flatMap(x => x.files), x => x.path.toLowerCase(), 'managed file'); };
export function validateInstallationRecord(v) {
  object(v, ['installation_version', 'install_id', 'manager_version', 'generation', 'channel', 'scope', 'active_path', 'control_path', 'release', 'projects', 'last_transaction_id', 'last_snapshot_path'], 'installation'); if (v.installation_version !== 1) fail('Unknown installation schema'); string(v.install_id, 'install_id'); semver(v.manager_version, 'manager_version'); integer(v.generation, 'generation'); literal(v.channel, ['stable', 'preview'], 'channel'); literal(v.scope, ['user', 'project'], 'scope'); path(v.active_path, 'active_path', true); path(v.control_path, 'control_path', true); validateReleaseDescriptor(v.release); projects(v.projects); if (v.last_transaction_id !== null) string(v.last_transaction_id, 'last_transaction_id'); if (v.last_snapshot_path !== null) path(v.last_snapshot_path, 'last_snapshot_path', true); return v;
}
export function validateOperationPlan(v) {
  const keys=['operation', 'install_id', 'scope', 'active_path', 'target_active_path', 'control_path', 'generation', 'current_release', 'target_release', 'current_files', 'channel', 'projects', 'software_only', 'migration_ids', 'impact', 'changelog', 'writes', 'recovery', 'snapshot', 'checks', 'quiescence', 'requires_maintenance', 'expires_at', 'plan_id', 'blockers', 'status'];
  for(const k of ['data_change','adoption','layout','registration','offline'])if(v&&Object.hasOwn(v,k))keys.push(k);
  object(v, keys, 'plan');
  literal(v.operation, ['install', 'update', 'rollback', 'migrate'], 'operation');
  if(v.offline!==undefined){object(v.offline,['freshness','revocation'],'offline release status');if(v.operation!=='rollback'||v.offline.freshness!=='stale-offline'||v.offline.revocation!=='unknown')fail('Invalid offline rollback status');}
  string(v.install_id, 'install_id');
  literal(v.scope, ['user', 'project'], 'scope');
  path(v.active_path, 'active_path', true);
  path(v.target_active_path, 'target_active_path', true);
  path(v.control_path, 'control_path', true);
  integer(v.generation, 'generation');
  if (v.current_release !== null) validateReleaseDescriptor(v.current_release);
  validateReleaseDescriptor(v.target_release);
  array(v.current_files, (x, l) => file(x, l, true), 'current_files');
  unique(v.current_files, x => x.path.toLowerCase(), 'current file');
  literal(v.channel, ['stable', 'preview'], 'channel');
  if (v.channel === 'stable' && v.target_release.channel !== 'stable') fail('Stable channel cannot select preview');
  projects(v.projects);
  if(v.registration!==undefined) {
    const r=object(v.registration,['before_projects','added_project_ids'],'registration');
    if(v.operation!=='migrate'||v.adoption)fail('Registration requires explicit migration');
    projects(r.before_projects);array(r.added_project_ids,string,'added project IDs');unique(r.added_project_ids,x=>x,'added project ID');
    if(!r.added_project_ids.length)fail('Empty registration');
    const old=r.before_projects.map(p=>p.project_id), added=v.projects.filter(p=>!old.includes(p.project_id));
    if(canonicalJson(added.map(p=>p.project_id))!==canonicalJson(r.added_project_ids)||v.projects.length!==old.length+added.length)fail('Registration union differs');
    for(const p of r.before_projects){const q=v.projects.find(x=>x.project_id===p.project_id);const binding=({files,...rest})=>rest;if(!q||canonicalJson(binding(p))!==canonicalJson(binding(q)))fail('Existing registration bindings changed');}
    if(added.some(p=>p.profile==='po-1.1.3'))fail('Registration supports declared legacy migration only');
  }
  if(v.layout!==undefined){object(v.layout,['from','to'],'layout');path(v.layout.from,'layout.from',true);path(v.layout.to,'layout.to',true);if(v.layout.from!==v.active_path||v.layout.to!==v.target_active_path||v.layout.from===v.layout.to)fail('Layout differs from approved code paths');}
  if(v.active_path!==v.target_active_path&&!v.layout)fail('Explicit layout change required');
  if(v.adoption!==undefined){object(v.adoption,['source','registry_absent'],'adoption');if(v.adoption.source!=='manual-v1.1.3'||v.adoption.registry_absent!==true||v.generation!==0||v.current_release?.version!=='1.1.3'||v.operation!=='update')fail('Invalid manual adoption');}
  if(v.data_change!==undefined) {
    const d=object(v.data_change,['stage_path','after_projects','resources','migrations','selected_snapshot','loss_window'],'data change');
    if(!['migrate','rollback'].includes(v.operation))fail('Unexpected data changes');
    path(d.stage_path,'data stage',true);projects(d.after_projects);
    if(canonicalJson(d.after_projects.map(p=>p.project_id))!==canonicalJson(v.projects.map(p=>p.project_id)))fail('After project set changed');
    for(let i=0;i<v.projects.length;i++)if(d.after_projects[i].root_path!==v.projects[i].root_path||canonicalJson(d.after_projects[i].bindings?.reference_roots??[])!==canonicalJson(v.projects[i].bindings?.reference_roots??[]))fail('After project roots changed');
    array(d.resources,r=>{object(r,['path','kind','before_sha256','after_sha256'],'data resource');path(r.path,'data resource',true);literal(r.kind,['file','directory'],'data resource kind');for(const k of ['before_sha256','after_sha256'])if(r[k]!==null)sha(r[k],k);if(r.before_sha256===null&&r.after_sha256===null)fail('Empty resource change');},'data resources');unique(d.resources,r=>r.path.toLowerCase(),'data resource');
    array(d.migrations,r=>{object(r,['project_id','destination','packet_path','result_path','review_path','confirmation_path'],'migration request');string(r.project_id,'migration project');for(const k of ['destination','confirmation_path'])path(r[k],k,true);for(const k of ['packet_path','result_path','review_path'])if(r[k]!==null)path(r[k],k,true);},'migration requests');
    if(v.operation==='migrate') {if(d.selected_snapshot!==null||d.loss_window!==null||!d.migrations.length||!v.migration_ids.length)fail('Invalid migration data plan');}
    else {
      if(d.migrations.length||v.migration_ids.length)fail('Snapshot restore is not a legacy migration');
      const s=object(d.selected_snapshot,['path','bytes','sha256','transaction_id','created_at'],'selected snapshot');file({path:s.path,bytes:s.bytes,sha256:s.sha256},'selected snapshot',true);string(s.transaction_id,'snapshot transaction');if(!Number.isFinite(Date.parse(s.created_at)))fail('Snapshot time');
      const w=object(d.loss_window,['from','to'],'loss window');if(w.from!==s.created_at||!Number.isFinite(Date.parse(w.to))||Date.parse(w.to)<Date.parse(w.from))fail('Loss window');
    }
  }
  if (v.software_only !== (v.projects.length === 0) || typeof v.requires_maintenance !== 'boolean') fail('Invalid scope declaration');
  array(v.migration_ids, string, 'migration_ids');
  unique(v.migration_ids, x => x, 'migration ID');
  if (v.projects.some(p => p.profile !== 'po-1.1.3') && (v.operation !== 'migrate' || !v.migration_ids.length)) fail('Legacy data requires explicit migrate handler');
  string(v.impact, 'impact');
  object(v.changelog, ['body', 'sha256'], 'changelog');
  string(v.changelog.body, 'changelog.body', false);
  sha(v.changelog.sha256, 'changelog.sha256');
  const bodyHash = createHash('sha256').update(v.changelog.body, 'utf8').digest('hex');
  if (bodyHash !== v.changelog.sha256 || bodyHash !== v.target_release.changelog_sha256) fail('Changelog mismatch');
  for (const k of ['writes', 'recovery']) {
    array(v[k], (x, l) => path(x, l, true), k);
    unique(v[k], x => x.toLowerCase(), k);
  }
  object(v.snapshot, ['path', 'capacity_bytes'], 'snapshot');
  path(v.snapshot.path, 'snapshot.path', true);
  integer(v.snapshot.capacity_bytes, 'capacity_bytes');
  for (const k of ['checks', 'quiescence', 'blockers']) array(v[k], string, k);
  string(v.expires_at, 'expires_at');
  if (!Number.isFinite(Date.parse(v.expires_at))) fail('Invalid plan expiry');
  string(v.plan_id, 'plan_id');
  if (v.status !== (v.blockers.length ? 'blocked' : 'ready')) fail('Plan status mismatch');
  if (v.status === 'ready') {
    if (v.operation === 'install' && v.current_release !== null) fail('Install cannot replace an installation');
    if (v.operation !== 'install' && v.current_release === null) fail('Current installation identity required');
    if (v.current_release !== null) {
      const order = compareSemVer(v.target_release.version, v.current_release.version);
      if (v.operation === 'update' && order <= 0) fail('Update requires newer release');
      if (v.operation === 'rollback' && order >= 0) fail('Rollback requires older release');
      if (v.operation === 'migrate' && canonicalSha256(v.target_release) !== canonicalSha256(v.current_release)) fail('Migration changes software identity');
    }
  }
  return v;
}
export function validateApprovalReceipt(v) {
  object(v, ['plan_id', 'plan_sha256', 'operation', 'install_id', 'projects', 'approval_source', 'user_approved', 'writers_stopped', 'issued_at', 'expires_at', 'use_id'], 'approval'); string(v.plan_id, 'plan_id'); sha(v.plan_sha256, 'plan_sha256'); literal(v.operation, ['install', 'update', 'rollback', 'migrate'], 'operation'); string(v.install_id, 'install_id'); array(v.projects, string, 'projects'); unique(v.projects, x => x, 'approved project'); string(v.approval_source, 'approval_source'); if (v.user_approved !== true || typeof v.writers_stopped !== 'boolean') fail('User approval absent'); for (const k of ['issued_at', 'expires_at']) if (typeof v[k] !== 'string' || !Number.isFinite(Date.parse(v[k]))) fail(`Invalid ${k}`); string(v.use_id, 'use_id'); return v;
}
export function validateJournal(v) {
  object(v, ['journal_version', 'transaction_id', 'plan', 'approval', 'plan_sha256', 'approval_sha256', 'manager_release', 'before_generation', 'after_generation', 'paths', 'before_resources', 'after_resources', 'snapshots', 'phase', 'sequence', 'actions', 'verification', 'result'], 'journal');
  if (v.journal_version !== 1) fail('Unknown journal schema');
  string(v.transaction_id, 'transaction_id');
  validateOperationPlan(v.plan);
  validateApprovalReceipt(v.approval);
  sha(v.plan_sha256, 'plan_sha256');
  sha(v.approval_sha256, 'approval_sha256');
  if (canonicalSha256(v.plan) !== v.plan_sha256 ||
      canonicalSha256(v.approval) !== v.approval_sha256 ||
      v.approval.plan_sha256 !== v.plan_sha256 ||
      v.approval.plan_id !== v.plan.plan_id) fail('Journal digest mismatch');
  validateReleaseDescriptor(v.manager_release);
  integer(v.before_generation, 'before_generation');
  integer(v.after_generation, 'after_generation');
  array(v.paths, (x, l) => path(x, l, true), 'paths');
  unique(v.paths, x => x.toLowerCase(), 'path');
  for (const k of ['before_resources', 'after_resources', 'snapshots']) {
    array(v[k], (x, l) => file(x, l, true), k);
  }
  literal(v.phase, ['PLANNED', 'APPROVED', 'PREPARED', 'SNAPSHOTTED', 'STAGED', 'VERIFIED', 'COMMITTING', 'COMMITTED', 'SUCCEEDED', 'ABORTED', 'RECOVERING', 'RESTORED', 'RECOVERY_REQUIRED'], 'phase');
  integer(v.sequence, 'sequence');
  array(v.actions, a => {
    object(a, ['sequence', 'kind', 'source', 'destination', 'before_sha256', 'after_sha256', 'intent', 'completed'], 'action');
    integer(a.sequence, 'action.sequence');
    literal(a.kind, ['replace', 'move', 'write', 'snapshot', 'verify'], 'action.kind');
    if (a.source !== null) path(a.source, 'action.source', true);
    path(a.destination, 'action.destination', true);
    if (a.before_sha256 !== null) sha(a.before_sha256, 'action.before_sha256');
    if (a.after_sha256 !== null) sha(a.after_sha256, 'action.after_sha256');
    if (typeof a.intent !== 'boolean' || typeof a.completed !== 'boolean' || (a.completed && !a.intent)) fail('Invalid action state');
  }, 'actions');
  array(v.verification, string, 'verification');
  if (v.result !== null) string(v.result, 'result');
  return v;
}
export function canonicalJson(value) {
  const visit = (v) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isSafeInteger(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(visit).join(',')}]`;
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${visit(v[k])}`).join(',')}}`;
    fail('Non-canonical JSON value');
  };
  return visit(value);
}
export const canonicalSha256 = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
