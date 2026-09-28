import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {DistributionError,canonicalSha256,validateInstallationRecord,validateOperationPlan,validateReleaseDescriptor} from './contracts.mjs';
import {buildOperationPlan,validateApprovalForPlan} from './plan.mjs';
import {createReleaseSource,restoreAuthenticatedCache,requireAuthenticatedBundle} from './source.mjs';
import {extractVerifiedPayload} from './archive.mjs';
import {verifyCandidate} from './verify.mjs';
import {selectRelease} from './version.mjs';
import {canonicalPath,inventory,assertInventory,createScopedStore,authenticatedCacheReader,checkPlanPaths,exists,hash,readDurableJournal} from './store.mjs';
import {readProject} from './snapshot.mjs';
import {planLegacyMigration,planSnapshotRestore} from './data-change.mjs';

const HELP={usage:[
  'check-update --config <absolute.json>',
  'install|update|rollback|migrate --plan --config <absolute.json>',
  'install|update|rollback|migrate --apply <absolute-plan.json> --approval <absolute-receipt.json>',
  'verify --control <absolute-control>',
  'recover --control <absolute-control> --transaction <id>',
  '--help',
],approval:'Trusted host must issue exact ApprovalReceipt after explicit user approval; no --yes or executable/source overrides.',plan_lifetime_minutes:90,candidate_timeout_minutes:20};
const fail=(code)=>{throw new DistributionError(code,'Distribution request rejected');};
const read=async file=>JSON.parse(await fs.readFile(await canonicalPath(file),'utf8'));
const writable=new Set(['install','update','rollback','migrate']);
export function parseArguments(args){
  if(args.length===1&&args[0]==='--help')return {command:'help'};
  const [command,...rest]=args;if(![...writable,'check-update','verify','recover'].includes(command))fail('BAD_CALL');
  const options={command};
  for(let i=0;i<rest.length;i++){
    const key=rest[i];if(!['--plan','--config','--apply','--approval','--control','--transaction'].includes(key)||Object.hasOwn(options,key.slice(2)))fail('BAD_CALL');
    if(key==='--plan')options.plan=true;else{const value=rest[++i];if(!value||value.startsWith('--'))fail('BAD_CALL');options[key.slice(2)]=value;}
  }
  const keys=Object.keys(options).filter(k=>k!=='command').sort().join();
  if(writable.has(command)&&options.apply&&!options.approval&&keys==='apply')fail('APPROVAL_REQUIRED');
  if(!(writable.has(command)?['config,plan','apply,approval'].includes(keys):command==='check-update'?keys==='config':command==='verify'?keys==='control':keys==='control,transaction'))fail('BAD_CALL');
  for(const key of ['config','apply','approval','control'])if(options[key]&&!path.isAbsolute(options[key]))fail('BAD_CALL');
  return options;
}
const envelope=(command,status,extra={})=>({command,status,plan_id:null,transaction_id:null,current_release:null,target_release:null,checks:[],changes:[],recovery:null,errors:[],...extra});
const result=(command,status,extra={},exitCode=0)=>({envelope:envelope(command,status,extra),exitCode});
const allowedConfig=new Set(['install_id','scope','control_path','target_release_id','current_release_id','channel','projects','software_only','snapshot_path','migration_requests','data_stage_path','selected_snapshot','manual_adoption','offline']);
async function readConfig(file){const c=await read(file);if(!c||Array.isArray(c)||Object.keys(c).some(k=>!allowedConfig.has(k)))fail('BAD_CALL');return c;}
async function currentRecord(control){return await exists(`${control}/installation.json`)?validateInstallationRecord(await read(`${control}/installation.json`)):null;}
async function sealedSource(control){
  const store=await createScopedStore({roots:[control]});
  async function descriptors(){
    const values=[];
    for(const name of await fs.readdir(await store.guard(`${control}/cache`))){
      if(!/^[0-9a-f]{64}$/.test(name))continue;
      const record=await store.readJson(`${control}/cache/${name}/record.json`),descriptor=validateReleaseDescriptor(record.descriptor);
      if(canonicalSha256(descriptor)!==name)fail('CACHE_UNTRUSTED');values.push(descriptor);
    }
    return values;
  }
  async function authenticateRelease(id){const matches=(await descriptors()).filter(d=>d.release_id===id);if(matches.length!==1)fail('CACHE_UNTRUSTED');return restoreAuthenticatedCache({store:authenticatedCacheReader({store,control}),release:matches[0]});}
  return {authenticateRelease,acquirePayload:async b=>requireAuthenticatedBundle(b,{payload:true}),recheck:async b=>authenticateRelease(b.descriptor.release_id),discover:async()=>({status:'available',releases:(await descriptors()).map(d=>({release_id:d.release_id,tag:d.tag,prerelease:d.prerelease}))})};
}
const operationSource=async(plan,ports)=>plan.offline?sealedSource(plan.control_path):createReleaseSource(ports);
async function refreshProjects(projects){
  const output=[];
  for(const p of projects){const files=new Map();for(const f of p.files){const bytes=await fs.readFile(await canonicalPath(f.path));files.set(f.path,{path:f.path,bytes:bytes.length,sha256:hash(bytes)});}for(const d of p.directories)for(const f of await inventory(d))files.set(f.path,f);const fresh={...p,files:[...files.values()].sort((a,b)=>a.path.localeCompare(b.path))};await readProject(fresh,{allowLegacy:true});output.push(fresh);}
  return output;
}
export async function planCommand(command,c,source){
  const control=await canonicalPath(c.control_path),record=await currentRecord(control);
  if(c.offline!==undefined){if(c.offline!==true||command!=='rollback'||!record||c.manual_adoption)fail('BAD_CALL');source=await sealedSource(control);}
  if(record&&(c.install_id!==record.install_id||c.scope!==record.scope))fail('INSTALLATION_CHANGED');
  if(command==='install'&&record||command!=='install'&&!record&&!c.manual_adoption)fail('INSTALLATION_CHANGED');
  const target=await source.authenticateRelease(c.target_release_id);
  const current=record?.release??(c.manual_adoption?(await source.authenticateRelease(c.current_release_id)).descriptor:null);
  const base=path.posix.dirname(path.posix.dirname(control));
  const active=record?.active_path??`${base}/skills/${current?.skill_id??target.descriptor.skill_id}`;
  const targetPath=`${base}/skills/${target.descriptor.skill_id}`;
  const declarations=c.projects??[];
  if(!Array.isArray(declarations)||c.software_only!==(declarations.length===0))fail('BAD_CALL');
  if(record&&command!=='migrate'&&canonicalSha256(declarations.map(({files,...p})=>p))!==canonicalSha256(record.projects.map(({files,...p})=>p)))fail('INSTALLATION_CHANGED');
  const projects=await refreshProjects(declarations);
  const plan={operation:command,install_id:c.install_id,scope:c.scope,active_path:active,target_active_path:targetPath,control_path:control,generation:record?.generation??0,current_release:current,target_release:target.descriptor,current_files:current?await inventory(active):[],channel:c.channel,projects,software_only:projects.length===0,migration_ids:[],impact:command==='migrate'?'Explicit legacy registration and new-state migration; no execution authorization':'Software change; project bytes retained unless a selected snapshot is explicitly bound',changelog:{body:target.changelog,sha256:target.descriptor.changelog_sha256},writes:[...new Set([active,targetPath,control])],recovery:[...new Set([active,targetPath,control])],snapshot:{path:await canonicalPath(c.snapshot_path),capacity_bytes:projects.flatMap(p=>p.files).reduce((n,f)=>n+f.bytes,0)*5+65536},checks:['exact authenticated release','complete inventories','fixed candidate verify','snapshot readback','registration readback'],quiescence:['Stop all writers and clients using this installation and declared projects'],requires_maintenance:true,expires_at:new Date(Date.now()+90*60000).toISOString(),plan_id:randomUUID(),blockers:[]};
  if(c.offline){plan.offline={freshness:'stale-offline',revocation:'unknown'};plan.checks.push('Sealed historical cache only; current revocation and freshness unknown');}
  if(active!==targetPath)plan.layout={from:active,to:targetPath};
  if(c.manual_adoption){if(record)fail('INSTALLATION_CHANGED');plan.adoption={source:'manual-v1.1.3',registry_absent:true};}
  if(command==='migrate'){
    if(!record)fail('INSTALLATION_CHANGED');
    const added=projects.filter(p=>!record.projects.some(q=>q.project_id===p.project_id));
    if(added.length)plan.registration={before_projects:record.projects,added_project_ids:added.map(p=>p.project_id)};
    plan.data_change=await planLegacyMigration({projects,requests:c.migration_requests,stagePath:await canonicalPath(c.data_stage_path)});
    for(const p of projects.filter(p=>p.profile!=='po-1.1.3')){const routes=target.manifest.migrations.filter(m=>m.kind==='legacy-data'&&m.handler_id==='po-legacy-snapshot-v1'&&m.from_profile===p.profile&&m.to_profile==='po-1.1.3'&&m.from_software_versions.includes(current.version));if(routes.length!==1)fail('MIGRATION_ROUTE');plan.migration_ids.push(routes[0].id);}
    plan.migration_ids=[...new Set(plan.migration_ids)].sort();
  }
  if(command==='rollback'&&c.selected_snapshot){plan.data_change=await planSnapshotRestore({plan,snapshotRecord:c.selected_snapshot,stagePath:await canonicalPath(c.data_stage_path)});}
  if(plan.data_change){plan.writes.push(plan.data_change.stage_path,...plan.data_change.resources.map(r=>r.path));plan.recovery.push(...plan.data_change.resources.map(r=>r.path));}
  const bound=buildOperationPlan(plan);await checkPlanPaths(bound);
  if(current){const prior=await source.authenticateRelease(current.release_id);if(canonicalSha256(prior.descriptor)!==canonicalSha256(current))fail('INSTALLATION_CHANGED');await assertInventory(active,prior.manifest.payload.files,{relative:true});if(c.manual_adoption&&prior.manifest.payload.files.length!==46)fail('ADOPTION');}
  else if(await exists(targetPath))fail('TARGET_EXISTS');
  return bound;
}
async function acquire(source,descriptor){const b=await source.authenticateRelease(descriptor.release_id);if(canonicalSha256(b.descriptor)!==canonicalSha256(descriptor))fail('RELEASE_CHANGED');return source.acquirePayload(b);}
async function managerDescriptor(plan,source){
  if(plan.target_release.version==='1.3.0')return plan.target_release;
  if(plan.current_release?.version==='1.3.0')return plan.current_release;
  const list=await source.discover();if(list.status!=='available')fail('SOURCE_UNAVAILABLE');const rows=list.releases.filter(r=>r.tag==='v1.3.0');if(rows.length!==1)fail('MANAGER_IDENTITY');return (await source.authenticateRelease(rows[0].release_id)).descriptor;
}
// Only authenticated extracted modules execute transactions. Each imported source
// creates its own opaque capabilities; untrusted request data cannot mint them.
async function handoff(plan,approval,ports){
  const source=await operationSource(plan,ports.sourcePorts);const descriptor=await managerDescriptor(plan,source),manager=await acquire(source,descriptor);
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'conductor-handoff-'));
  const extracted=await extractVerifiedPayload(manager,{stagingParent:temporary,name:'manager'});
  const root=await canonicalPath(extracted.archiveRoot);await assertInventory(root,manager.manifest.payload.files,{relative:true});
  const module=await import(pathToFileURL(`${root}/scripts/distribution/cli.mjs`).href);
  return module.executeApproved({plan,approval,managerRelease:descriptor,sourcePorts:ports.sourcePorts,fault:ports.fault});
}
export async function executeApproved({plan,approval,managerRelease,sourcePorts,fault}){
  validateApprovalForPlan(plan,approval);const source=await operationSource(plan,sourcePorts);
  const bundle=await acquire(source,plan.target_release),managerBundle=await acquire(source,managerRelease);
  const currentBundle=plan.adoption?await acquire(source,plan.current_release):undefined;
  const transactionId=randomUUID();
  try{const module=plan.operation==='install'?await import('./transaction.mjs'):await import('./update.mjs');const receipt=await module[plan.operation]({plan,approval,bundle,managerBundle,currentBundle,source,transactionId,...(fault?{fault}: {})});return result(plan.operation,'succeeded',{plan_id:plan.plan_id,transaction_id:transactionId,current_release:plan.current_release,target_release:plan.target_release,checks:plan.checks,changes:plan.writes,report:receipt});}
  catch(error){
    const store=await createScopedStore({roots:[plan.control_path]});let journal;
    try{journal=await readDurableJournal(store,`${plan.control_path}/transactions/${hash(transactionId)}.json`);if(journal.transaction_id!==transactionId||journal.plan_sha256!==canonicalSha256(plan)||journal.approval_sha256!==canonicalSha256(approval))journal=null;}catch{}
    if(journal&&['RESTORED','RECOVERY_REQUIRED','RECOVERING','COMMITTING','COMMITTED'].includes(journal.phase)||!journal&&await exists(`${plan.control_path}/transactions/${hash(transactionId)}.json`))return result(plan.operation,journal?.phase==='RESTORED'?'restored':'recovery_required',{plan_id:plan.plan_id,transaction_id:transactionId,current_release:plan.current_release,target_release:plan.target_release,recovery:{control:plan.control_path,transaction_id:transactionId,phase:journal?.phase??'UNKNOWN'},errors:[{code:'TRANSACTION_FAILED',message:'Transaction failed; retain all recovery resources'}]},journal?.phase==='RESTORED'?3:4);
    throw error;
  }
}
async function offlineRecovery(options){
  const control=await canonicalPath(options.control),store=await createScopedStore({roots:[control]});
  const file=`${control}/transactions/${hash(options.transaction)}.json`;
  let identified=await exists(file)||await exists(`${file}.prev`)||await exists(`${control}/transactions/${hash(options.transaction)}.receipt.json`);
  if(!identified&&await exists(`${control}/writer.lock`)){
    try{identified=(await store.readJson(`${control}/writer.lock`)).transaction_id===options.transaction;}catch{}
  }
  if(!identified)fail('TRANSACTION_NOT_FOUND');
  try{
    const journal=await readDurableJournal(store,file);
    if(journal.transaction_id!==options.transaction||journal.plan.control_path!==control)fail('RECOVERY_REQUIRED');
    const bundle=await restoreAuthenticatedCache({store:authenticatedCacheReader({store,control}),release:journal.manager_release});
    const root=`${control}/manager/${canonicalSha256(bundle.descriptor)}/${bundle.manifest.skill_id}`;await assertInventory(root,bundle.manifest.payload.files,{relative:true});
    const module=await import(pathToFileURL(`${root}/scripts/distribution/recovery.mjs`).href);
    const report=await module.recover({control,transactionId:options.transaction});
    const status=report.status==='SUCCEEDED'?'succeeded':report.status==='ABORTED'?'blocked':report.status==='RESTORED'?'restored':'recovery_required';
    return result('recover',status,{plan_id:journal.plan.plan_id,transaction_id:journal.transaction_id,current_release:journal.plan.current_release,target_release:journal.plan.target_release,recovery:report},status==='blocked'?2:report.exit_code);
  }catch{
    return result('recover','recovery_required',{transaction_id:options.transaction,recovery:{control,transaction_id:options.transaction},errors:[{code:'RECOVERY_REQUIRED',message:'Recovery is unsafe or required evidence is unavailable; retain all copies'}]},4);
  }
}
export async function runPublicCli(args,ports={}){
  let options;
  try{
    options=parseArguments(args);const command=options.command;
    if(command==='help')return result(command,'read_only',{report:HELP});
    if(command==='recover')return await offlineRecovery(options);
    const source=createReleaseSource(ports.sourcePorts);
    if(command==='verify'){
      const control=await canonicalPath(options.control),record=await currentRecord(control);if(!record)fail('INSTALLATION_CHANGED');
      const store=await createScopedStore({roots:[control]});const bundle=await restoreAuthenticatedCache({store:authenticatedCacheReader({store,control}),release:record.release});await assertInventory(record.active_path,bundle.manifest.payload.files,{relative:true});await Promise.all((await refreshProjects(record.projects)).map(p=>readProject(p)));await verifyCandidate({bundle,root:record.active_path});
      return result(command,'read_only',{current_release:record.release,checks:['authenticated cached inventory','project contracts','fixed candidate verify'],report:{freshness:'stale-offline'}});
    }
    if(command==='check-update'){
      const c=await readConfig(options.config);if(c.offline!==undefined)fail('BAD_CALL');const record=c.control_path?await currentRecord(await canonicalPath(c.control_path)):null,found=await source.discover();if(found.status!=='available')fail('SOURCE_UNAVAILABLE');
      const candidates=[];for(const r of found.releases)candidates.push((await source.authenticateRelease(r.release_id)).descriptor);
      let dirty=false;if(record){try{const current=await source.authenticateRelease(record.release.release_id);if(canonicalSha256(current.descriptor)!==canonicalSha256(record.release))fail('RELEASE_CHANGED');await assertInventory(record.active_path,current.manifest.payload.files,{relative:true});}catch{dirty=true;}}
      const selection=selectRelease(candidates,{channel:c.channel??'stable',current:record?.release??null,dirty});return result(command,selection.status,{current_release:record?.release??null,target_release:selection.target,report:selection},selection.status==='unavailable'?5:selection.status==='blocked'?2:0);
    }
    if(options.plan){const plan=await planCommand(command,await readConfig(options.config),source);return result(command,plan.status==='blocked'?'blocked':'planned',{plan_id:plan.plan_id,current_release:plan.current_release,target_release:plan.target_release,checks:plan.checks,changes:plan.writes,recovery:plan.recovery,plan},plan.status==='blocked'?2:0);}
    const plan=validateOperationPlan(await read(options.apply)),approval=await read(options.approval);if(plan.operation!==command)fail('BAD_CALL');validateApprovalForPlan(plan,approval);return await handoff(plan,approval,ports);
  }catch(error){
    const code=typeof error.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'REQUEST_FAILED';
    const status=code==='BAD_CALL'?'bad_call':code==='APPROVAL_REQUIRED'||code==='INVALID_APPROVAL'?'approval_required':code==='SOURCE_UNAVAILABLE'||code==='AUTHENTICATION_FAILED'?'unavailable':code==='RECOVERY_REQUIRED'?'recovery_required':code==='REQUEST_FAILED'?'error':'blocked';
    const exitCode={bad_call:1,approval_required:2,unavailable:5,recovery_required:4,error:1,blocked:2}[status];
    return result(options?.command??(writable.has(args[0])?args[0]:'unknown'),status,{errors:[{code,message:code==='SNAPSHOT_REQUIREMENT_CONFLICT'?'Selected snapshot conflicts with current effective requirement identity; project decisions must be resolved separately':code==='SNAPSHOT_GOVERNANCE_CONFLICT'?'Selected snapshot conflicts with current governance or execution authority; project decisions must be resolved separately':'Request could not complete; inspect the approved scope and retained transaction records'}]},exitCode);
  }
}
