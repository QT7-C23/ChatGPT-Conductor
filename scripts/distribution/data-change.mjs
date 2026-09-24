import * as fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256, DistributionError } from './contracts.mjs';
import { inside, exists, hash, validateJournalScope, canonicalPath, createScopedStore } from './store.mjs';
import { validateSnapshot, currentRevisionRequirement, currentRevisionInstructions } from '../contracts.mjs';
import { readProject } from './snapshot.mjs';
import { prepareLegacyMigration, validateMigrationPlan } from './migration-adapter.mjs';
import { checkSnapshot } from './recovery.mjs';
import { directoryDigest, resourceHash } from './resources.mjs';
export { directoryList } from './resources.mjs';
const fail=message=>{throw new DistributionError('DATA_CHANGE_INVALID',message);};

async function checkGovernance(current,previous,snapshot) {
  const readState=async(file,expected)=>{
    const bytes=await fs.readFile(await canonicalPath(file));
    if(!expected||hash(bytes)!==expected.sha256||bytes.length!==expected.bytes)fail('Governance state fingerprint changed');
    return validateSnapshot(JSON.parse(bytes));
  };
  const copy=snapshot.copies.find(c=>c.original_path===previous.state_path);
  const now=await readState(current.state_path,current.files.find(f=>f.path===current.state_path));
  const before=await readState(copy?.path,copy);
  if(canonicalSha256(currentRevisionRequirement(now))!==canonicalSha256(currentRevisionRequirement(before))||canonicalSha256(currentRevisionInstructions(now))!==canonicalSha256(currentRevisionInstructions(before)))
    throw new DistributionError('SNAPSHOT_REQUIREMENT_CONFLICT','Selected snapshot conflicts with current effective requirement identity; project decisions must be resolved separately');
  // Equality is proof of compatibility, not an updater-created approval. Only
  // the ordinary revision counter may differ for a non-executable state.
  const {revision:nowRevision,...nowGovernance}=now,{revision:beforeRevision,...beforeGovernance}=before;
  if(canonicalSha256(nowGovernance)!==canonicalSha256(beforeGovernance)||(['READY_TO_EXECUTE','EXECUTE'].includes(before.state)&&nowRevision!==beforeRevision))
    throw new DistributionError('SNAPSHOT_GOVERNANCE_CONFLICT','Selected snapshot conflicts with current governance or execution authority; project decisions must be resolved separately');
}

export async function planLegacyMigration({projects,requests,stagePath}) {
  const prepared=await prepareLegacyMigration({projects,requests});
  return {stage_path:stagePath,after_projects:prepared.projects,resources:prepared.outputs.map(o=>({path:o.path,kind:'file',before_sha256:null,after_sha256:hash(o.bytes)})),migrations:structuredClone(requests),selected_snapshot:null,loss_window:null};
}
export async function selectedSnapshot({store,plan,selection}) {
  const file=`${plan.control_path}/transactions/${hash(selection.transaction_id)}.json`;
  const journalStore=store??await createScopedStore({roots:[plan.control_path]});
  const journal=await journalStore.readJson(file,validateJournalScope);
  if(journal.phase!=='SUCCEEDED'||journal.plan.control_path!==plan.control_path||journal.plan.install_id!==plan.install_id||journal.transaction_id!==selection.transaction_id)fail('Selected snapshot requires a successful bound transaction');
  const record=journal.snapshots[0];
  if(journal.snapshots.length!==1||selection.path!==record.path||selection.sha256!==record.sha256||selection.bytes!==record.bytes||record.path!==`${journal.plan.snapshot.path}/snapshot.json`)fail('Selected snapshot fingerprint changed');
  if(!store){
    // Bind the exact canonical manifest before granting its sibling copies scope.
    if(await canonicalPath(record.path)!==record.path)fail('Selected snapshot path must be canonical');
    const bytes=await fs.readFile(record.path);
    if(bytes.length!==record.bytes||hash(bytes)!==record.sha256)fail('Selected snapshot fingerprint changed');
    const manifest=JSON.parse(bytes);
    if(manifest.transaction_id!==journal.transaction_id||manifest.plan_sha256!==journal.plan_sha256||manifest.created_at!==selection.created_at)fail('Selected snapshot binding changed');
    store=await createScopedStore({roots:[plan.control_path,path.posix.dirname(record.path),...plan.projects.flatMap(p=>[p.root_path,...(p.bindings?.reference_roots??[])])]});
  }
  const snapshot=await checkSnapshot(store,journal);
  if(selection.path!==record.path||selection.sha256!==record.sha256||selection.bytes!==record.bytes||selection.created_at!==snapshot.created_at)fail('Selected snapshot fingerprint changed');
  const before=snapshot.installation_prestate;
  if(!before||before.install_id!==plan.install_id||canonicalSha256(before.release)!==canonicalSha256(plan.target_release))fail('Snapshot does not belong to target installation and release');
  if(canonicalSha256(before.projects.map(p=>[p.project_id,p.root_path,p.bindings?.reference_roots??[]]))!==canonicalSha256(plan.projects.map(p=>[p.project_id,p.root_path,p.bindings?.reference_roots??[]])))fail('Snapshot project scope differs');
  const projects=journal.plan.projects.map((declaration,i)=>{
    const captured=snapshot.projects[i];
    const sorted=files=>files.slice().sort((a,b)=>a.path.localeCompare(b.path));
    if(!captured||captured.project_id!==declaration.project_id||canonicalSha256(sorted(captured.files))!==canonicalSha256(sorted(declaration.files)))fail('Snapshot-time project inventory differs from approved declaration');
    return {...structuredClone(declaration),files:structuredClone(captured.files)};
  });
  return {snapshot,projects};
}
export async function planSnapshotRestore({store,plan,snapshotRecord,stagePath,now=new Date().toISOString()}) {
  const {snapshot,projects:after}=await selectedSnapshot({store,plan,selection:snapshotRecord});
  const resources=[];
  for(let i=0;i<plan.projects.length;i++) {
    const current=plan.projects[i],previous=after[i];await readProject(current);
    await checkGovernance(current,previous,snapshot);
    const scopes=[...new Set([...current.directories,...previous.directories])].filter(d=>![...current.directories,...previous.directories].some(x=>x!==d&&inside(x,d)));
    for(const dir of scopes) {
      // A whole-directory move is allowed only for a tree declared in both
      // inventories, with every byte and every empty directory accounted for.
      if(!current.directories.includes(dir)||!previous.directories.includes(dir))fail('Directory restore scope must be explicitly declared before and after');
      const dirs=snapshot.projects[i].directories.filter(d=>inside(dir,d));
      resources.push({path:dir,kind:'directory',before_sha256:await resourceHash(dir),after_sha256:directoryDigest(dir,previous.files,dirs)});
    }
    const union=[...new Set([...current.files,...previous.files].map(f=>f.path))].filter(p=>!scopes.some(d=>inside(d,p)));
    for(const file of union)resources.push({path:file,kind:'file',before_sha256:current.files.find(f=>f.path===file)?.sha256??null,after_sha256:previous.files.find(f=>f.path===file)?.sha256??null});
  }
  return {stage_path:stagePath,after_projects:structuredClone(after),resources,migrations:[],selected_snapshot:structuredClone(snapshotRecord),loss_window:{from:snapshotRecord.created_at,to:now}};
}
export async function stageDataChange({store,plan}) {
  const d=plan.data_change;if(!d)return {replacements:[],projects:plan.projects};
  if(await exists(d.stage_path))fail('Data stage must be absent');
  const outputs=new Map();let snapshot=null;
  if(plan.operation==='migrate') {
    const migrated=await validateMigrationPlan(plan);for(const o of migrated.outputs)outputs.set(o.path,o.bytes);
    const expected=migrated.outputs.map(o=>({path:o.path,kind:'file',before_sha256:null,after_sha256:hash(o.bytes)}));
    if(canonicalSha256(expected)!==canonicalSha256(d.resources))fail('Migration resource scope differs');
  }else{
    ({snapshot}=await selectedSnapshot({store,plan,selection:d.selected_snapshot}));
    const expected=await planSnapshotRestore({store,plan,snapshotRecord:d.selected_snapshot,stagePath:d.stage_path,now:d.loss_window.to});
    if(canonicalSha256(expected)!==canonicalSha256(d))fail('Snapshot restore differs from approved scope');
  }
  await store.mkdir(d.stage_path);const replacements=[];
  for(let i=0;i<d.resources.length;i++) {
    const r=d.resources[i],source=`${d.stage_path}/new-${i}`;
    if(await resourceHash(r.path)!==r.before_sha256)fail('Data resource changed');
    if(r.after_sha256!==null) {
      if(r.kind==='directory') {
        await store.mkdir(source);
        for(const dir of snapshot.projects.flatMap(p=>p.directories).filter(x=>inside(r.path,x)))await store.mkdir(`${source}${dir.slice(r.path.length)}`);
        for(const c of snapshot.copies.filter(c=>inside(r.path,c.original_path))){const destination=`${source}${c.original_path.slice(r.path.length)}`;await store.mkdir(path.dirname(destination));await store.copyNew(c.path,destination);}
      }else if(outputs.has(r.path))await store.writeNew(source,outputs.get(r.path));
      else {const c=snapshot.copies.find(c=>c.original_path===r.path);if(!c)fail('Snapshot file missing');await store.copyNew(c.path,source);}
      if(await resourceHash(source)!==r.after_sha256)fail('Staged resource differs');
    }
    replacements.push({source:r.after_sha256===null?null:source,destination:r.path});
  }
  // Verify the complete after-project contracts against a private materialized
  // copy; original paths remain the approved identities in registration.
  const validationProjects=[];
  const validationRoot=`${d.stage_path}/validation`;
  for(let i=0;i<d.after_projects.length;i++) {
    const p=d.after_projects[i],roots=[p.root_path,...(p.bindings?.reference_roots??[])];
    const remap=value=>{if(value===null)return null;const n=roots.findIndex(r=>inside(r,value));if(n<0)fail('After reference outside roots');return `${validationRoot}/${i}/${n}${value.slice(roots[n].length)}`;};
    for(const dir of p.directories)await store.mkdir(remap(dir));
    for(const f of p.files){const resource=d.resources.find(r=>r.path===f.path||r.kind==='directory'&&inside(r.path,f.path));const index=d.resources.indexOf(resource);const src=resource?`${d.stage_path}/new-${index}${resource.kind==='directory'?f.path.slice(resource.path.length):''}`:f.path;const dest=remap(f.path);await store.mkdir(path.dirname(dest));await store.copyNew(src,dest);}
    const copy={...p,root_path:remap(p.root_path),state_path:remap(p.state_path),directories:p.directories.map(remap),files:p.files.map(f=>({...f,path:remap(f.path)}))};
    if(p.bindings){copy.bindings={...p.bindings,reference_roots:p.bindings.reference_roots.map(remap),evidence:p.bindings.evidence.map(e=>({...e,root_path:remap(e.root_path),path:remap(e.path),resolution:e.resolution==='absolute'?'bound':e.resolution}))};for(const k of ['packet_path','result_path','historical_source_path','historical_review_path'])if(k in copy.bindings)copy.bindings[k]=remap(copy.bindings[k]);}
    await readProject(copy);validationProjects.push(copy);
  }
  return {replacements,projects:validationProjects};
}
