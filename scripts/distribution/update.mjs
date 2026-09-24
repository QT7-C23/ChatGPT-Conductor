import { randomUUID } from 'node:crypto';

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalSha256, canonicalJson, validateInstallationRecord, DistributionError } from './contracts.mjs';
import { validateApprovalForPlan } from './plan.mjs';
import { requireAuthenticatedBundle, restoreAuthenticatedCache } from './source.mjs';
import { extractVerifiedPayload } from './archive.mjs';
import { verifyCandidate, verifyProjectCompatibility } from './verify.mjs';
import { createSnapshot, readProject } from './snapshot.mjs';
import { createScopedStore, checkPlanPaths, checkDevices, exists, hash, inside, canonicalPath, assertInventory, transitionJournal, journalAction, persistAuthenticatedRelease, authenticatedCacheReader } from './store.mjs';
import { moveResource, reconcile, commitDataResources, resourceHash } from './recovery.mjs';
import { stageDataChange } from './data-change.mjs';
const fail=(code,message)=>{throw new DistributionError(code,message);};
const projectBindings=projects=>projects.map(({files,...identity})=>identity);

export const update=input=>runReplacement(input,'update');
export const rollback=input=>runReplacement(input,'rollback');
export const migrate=input=>runReplacement(input,'migrate');
async function runReplacement({plan,approval,bundle,managerBundle,currentBundle,source,store:providedStore,transactionId=randomUUID(),fault=async()=>{},deviceOptions={}},operation) {
  plan=structuredClone(plan);approval=structuredClone(approval);
  validateApprovalForPlan(plan,approval);
  if(operation!=='update'&&plan.projects.length&&!approval.writers_stopped)fail('WRITERS_ACTIVE','Data maintenance requires stopped writers');
  if(plan.operation!==operation||!plan.current_release||operation==='update'&&(plan.data_change||plan.migration_ids.length)||operation==='migrate'&&!plan.data_change||operation==='rollback'&&plan.migration_ids.length)fail('UPDATE_STATE','Operation requires an explicit supported plan');
  requireAuthenticatedBundle(bundle,{payload:true});requireAuthenticatedBundle(managerBundle,{payload:true});
  if(canonicalSha256(bundle.descriptor)!==canonicalSha256(plan.target_release)||managerBundle.descriptor.version!=='1.2.0'||operation==='update'&&!bundle.manifest.upgrade_from.includes(plan.current_release.version))fail('UPDATE_ROUTE','Unsupported update or migration route');
  if(operation==='migrate') {
    const ids=[];
    for(const p of plan.projects.filter(p=>p.profile!=='po-1.1.3')) {
      const routes=bundle.manifest.migrations.filter(m=>m.kind==='legacy-data'&&m.handler_id==='po-legacy-snapshot-v1'&&m.from_profile===p.profile&&m.to_profile==='po-1.1.3'&&m.from_software_versions.includes(plan.current_release.version));
      if(routes.length!==1)fail('MIGRATION_ROUTE','Exactly one authenticated and implemented legacy migration route required');
      ids.push(routes[0].id);
    }
    if(canonicalSha256([...new Set(ids)].sort())!==canonicalSha256(plan.migration_ids.slice().sort()))fail('MIGRATION_ROUTE','Approved migration IDs differ from manifest route');
  }
  if((plan.data_change?.after_projects??plan.projects).some(p=>p.profile!==bundle.manifest.data_contract.write_profile||!bundle.manifest.data_contract.read_profiles.includes(p.profile)))fail('DATA_PROFILE','Project profile incompatible');
  const paths=await checkPlanPaths(plan);
  if(paths.active!==paths.target&&await exists(paths.target))fail('LAYOUT','Both Skill directories occupied');
  const readBefore=p=>readProject(p,{allowLegacy:operation==='migrate'});
  const running=await canonicalPath(fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,''));
  if(inside(paths.active,running)||inside(paths.target,running))fail('RUNNER_LOCATION','Manager is inside replacement scope');
  try{await assertInventory(running,managerBundle.manifest.payload.files,{relative:true});}catch{fail('MANAGER_IDENTITY','Running manager differs from authenticated manager');}
  const store=providedStore??await createScopedStore({roots:[paths.control,path.dirname(paths.active),paths.snapshot,...(plan.data_change?[plan.data_change.stage_path,...(plan.data_change.selected_snapshot?[path.dirname(plan.data_change.selected_snapshot.path)]:[]),...plan.projects.flatMap(p=>[p.root_path,...(p.bindings?.reference_roots??[])])]:[])],fault});
  if(plan.adoption)await store.mkdir(`${paths.control}/transactions`);
  const lock=await store.acquireLock(`${paths.control}/writer.lock`,transactionId);
  const file=`${paths.control}/transactions/${hash(transactionId)}.json`;
  let journal;
  const phase=async value=>{await fault(`journal:before:${value}`,file);await transitionJournal({store,file,journal,phase:value});await fault(`journal:after:${value}`,file);};
  try {
    const before=plan.adoption?null:await store.readJson(`${paths.control}/installation.json`,validateInstallationRecord);
    if(plan.adoption&&await exists(`${paths.control}/installation.json`))fail('ADOPTION','Registry must be absent');
    if(before&&(before.install_id!==plan.install_id||before.generation!==plan.generation||before.active_path!==paths.active||before.control_path!==paths.control||before.scope!==plan.scope||canonicalSha256(before.release)!==canonicalSha256(plan.current_release)||canonicalSha256(projectBindings(before.projects))!==canonicalSha256(projectBindings(plan.registration?.before_projects??plan.projects))))fail('INSTALLATION_CHANGED','Registration differs from approved plan');
    if(plan.registration&&(!before||canonicalSha256(before.projects)!==canonicalSha256(plan.registration.before_projects)))fail('INSTALLATION_CHANGED','Registration prestate differs');
    const current=plan.adoption?requireAuthenticatedBundle(currentBundle,{payload:true}):await restoreAuthenticatedCache({store:authenticatedCacheReader({store,control:paths.control}),release:plan.current_release});
    if(canonicalSha256(current.descriptor)!==canonicalSha256(plan.current_release)||plan.adoption&&current.manifest.payload.files.length!==46)fail('ADOPTION','Exact authenticated V1.1.3 inventory required');
    await assertInventory(paths.active,current.manifest.payload.files,{relative:true});await assertInventory(paths.active,plan.current_files);
    await Promise.all(plan.projects.map(readBefore));
    for(const original of [bundle,managerBundle,...(plan.adoption?[current]:[])]) {
      if(operation==='rollback'&&original.evidence.method==='trusted-local-record'){const cached=await restoreAuthenticatedCache({store:authenticatedCacheReader({store,control:paths.control}),release:original.descriptor});if(canonicalSha256(cached.descriptor)!==canonicalSha256(original.descriptor))fail('CACHE_CHANGED','Cache identity changed');continue;}
      const fresh=await source.recheck(original);requireAuthenticatedBundle(fresh);
      if(canonicalSha256(fresh.descriptor)!==canonicalSha256(original.descriptor))fail('RELEASE_CHANGED','Release changed before apply');
    }
    validateApprovalForPlan(plan,approval);
    if(await exists(file))fail('TRANSACTION_EXISTS','Transaction ID already exists');
    await store.consumeApproval(paths.control,approval);
    journal={journal_version:1,transaction_id:transactionId,plan,approval,plan_sha256:canonicalSha256(plan),approval_sha256:canonicalSha256(approval),manager_release:managerBundle.descriptor,before_generation:plan.generation,after_generation:plan.generation+1,paths:[...new Set([paths.control,paths.active,paths.target,paths.snapshot])],before_resources:plan.current_files,after_resources:bundle.manifest.payload.files.map(f=>({...f,path:`${paths.target}/${f.path}`})),snapshots:[],phase:'PLANNED',sequence:0,actions:[],verification:[],result:null};
    const bytes=bundle.manifest.payload.files.reduce((n,f)=>n+f.bytes,0);
    await checkDevices({code:[paths.control,paths.active,paths.target],data:[paths.snapshot,...(plan.data_change?[plan.data_change.stage_path]:[]),...plan.projects.flatMap(p=>[p.root_path,...(p.bindings?.reference_roots??[])])],requiredCodeBytes:bytes*4,requiredDataBytes:Math.max(plan.snapshot.capacity_bytes,plan.projects.flatMap(p=>p.files).reduce((n,f)=>n+f.bytes,0)*3+(plan.data_change?.after_projects??[]).flatMap(p=>p.files).reduce((n,f)=>n+f.bytes,0)*2+65536),...deviceOptions});
    if(plan.adoption)await persistAuthenticatedRelease({store,control:paths.control,bundle:current,transactionId,managerRelease:managerBundle.descriptor});
    await persistAuthenticatedRelease({store,control:paths.control,bundle,transactionId,managerRelease:managerBundle.descriptor});
    await persistAuthenticatedRelease({store,control:paths.control,bundle:managerBundle,transactionId,managerRelease:managerBundle.descriptor});
    const managerParent=await store.mkdir(`${paths.control}/manager`),managerName=canonicalSha256(managerBundle.descriptor);
    const managerRoot=`${managerParent}/${managerName}/${managerBundle.manifest.skill_id}`;
    if(!(await exists(`${managerParent}/${managerName}`)))await extractVerifiedPayload(managerBundle,{stagingParent:managerParent,name:managerName});
    await verifyCandidate({bundle:managerBundle,root:managerRoot});
    // Publish a recoverable transaction only after its independent manager and
    // authenticated cache are complete. No active resource has changed yet.
    await phase('PLANNED');await phase('APPROVED');
    await phase('PREPARED');
    let snapshot;
    await journalAction({store,file,journal,kind:'snapshot',destination:paths.snapshot,fault,run:async()=>{snapshot=await createSnapshot({store,plan,transactionId,installation:before});}});
    journal.snapshots=[{path:snapshot.path,bytes:snapshot.bytes,sha256:snapshot.sha256}];await phase('SNAPSHOTTED');
    const stage=await store.mkdir(`${paths.control}/stage`);
    const candidate=operation==='migrate'?{archiveRoot:paths.active}:await extractVerifiedPayload(bundle,{stagingParent:stage,name:hash(transactionId)});
    const candidateRoot=await canonicalPath(candidate.archiveRoot);
    const stagedData=await stageDataChange({store,plan});
    await phase('STAGED');await verifyCandidate({bundle,root:candidateRoot});
    await verifyProjectCompatibility({bundle,root:candidateRoot,projects:stagedData.projects});
    journal.verification=['conductor-node-verify-v1'];await phase('VERIFIED');
    validateApprovalForPlan(plan,approval);await checkPlanPaths(plan);
    await Promise.all(plan.projects.map(readBefore));await assertInventory(paths.active,plan.current_files);
    await assertInventory(candidateRoot,bundle.manifest.payload.files,{relative:true});await assertInventory(managerRoot,managerBundle.manifest.payload.files,{relative:true});
    if(plan.adoption?await exists(`${paths.control}/installation.json`):canonicalSha256(await store.readJson(`${paths.control}/installation.json`,validateInstallationRecord))!==canonicalSha256(before))fail('INSTALLATION_CHANGED','Registration changed before commit');
    const installation={...(before??{installation_version:1,install_id:plan.install_id,scope:plan.scope,control_path:paths.control}),projects:plan.data_change?.after_projects??plan.projects,generation:plan.generation+1,manager_version:managerBundle.manifest.version,channel:plan.channel,release:bundle.descriptor,active_path:paths.target,last_transaction_id:transactionId,last_snapshot_path:paths.snapshot};
    validateInstallationRecord(installation);
    const stagedRegistration=`${stage}/${hash(transactionId)}-registration.json`;
    await journalAction({store,file,journal,kind:'write',destination:stagedRegistration,afterSha256:hash(canonicalJson(installation)),fault,run:()=>store.writeNew(stagedRegistration,canonicalJson(installation))});
    await phase('COMMITTING');
    const codeMoves=operation==='migrate'?[]:[[paths.active,`${stage}/${hash(transactionId)}-old-code`],[candidateRoot,paths.target]];
    for(const [from,to] of codeMoves)await moveResource({store,file,journal,source:from,destination:to,fault});
    if(plan.data_change)await commitDataResources({store,file,journal,replacements:stagedData.replacements,fault});
    const registrationMoves=[...(before?[[`${paths.control}/installation.json`,`${stage}/${hash(transactionId)}-old-registration.json`]]:[]),[stagedRegistration,`${paths.control}/installation.json`]];
    for(const [from,to] of registrationMoves)await moveResource({store,file,journal,source:from,destination:to,fault});
    await assertInventory(paths.target,bundle.manifest.payload.files,{relative:true});await Promise.all(installation.projects.map(p=>readProject(p)));
    for(const r of plan.data_change?.resources??[])if(await resourceHash(r.path)!==r.after_sha256)fail('DATA_CHANGED','After data resource differs');
    await verifyProjectCompatibility({bundle,root:paths.target,projects:installation.projects});
    if(canonicalSha256(await store.readJson(`${paths.control}/installation.json`,validateInstallationRecord))!==canonicalSha256(installation))fail('INSTALLATION_CHANGED','Registration readback differs');
    await phase('COMMITTED');
    const receipt={transaction_id:transactionId,installation,snapshot_path:paths.snapshot,manager_path:managerRoot,reload_required:true,durability:'process-crash',power_loss_verified:false,freshness:bundle.evidence.method==='trusted-local-record'?'stale-offline':'authenticated-exact-release'};
    await store.writeJson(`${paths.control}/transactions/${hash(transactionId)}.receipt.json`,receipt);
    journal.result=`${operation} completed; reload Skill`;await phase('SUCCEEDED');await lock.release('SUCCEEDED');return receipt;
  } catch(error) {
    if(!journal||!(await exists(file))){await lock.release('ABORTED');throw error;}
    try {await reconcile({store,file,journal,lock});}
    catch {journal.result='Recovery requires validated resources';try{await phase('RECOVERY_REQUIRED');}catch{}}
    throw error;
  }
}
