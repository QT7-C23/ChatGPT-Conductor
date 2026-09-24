import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { canonicalSha256, DistributionError, validateInstallationRecord } from './contracts.mjs';
import { restoreAuthenticatedCache } from './source.mjs';
import { readProject } from './snapshot.mjs';
import { validateApprovalForPlan } from './plan.mjs';
import { createScopedStore, canonicalPath, checkPlanPaths, assertInventory, inventory, hash, exists, authenticatedCacheReader, validateJournalScope, transitionJournal, journalAction } from './store.mjs';
import { directoryList, resourceHash } from './resources.mjs';
export { resourceHash } from './resources.mjs';
const fail = message => { throw new DistributionError('RECOVERY_REQUIRED',message); };
const terminal = new Set(['SUCCEEDED','ABORTED','RESTORED']);
const projectBindings=projects=>projects.map(({files,...identity})=>identity);

function validateBeforeRegistration(installation,journal) {
  validateInstallationRecord(installation);
  const p=journal.plan;
  if(installation.install_id!==p.install_id||installation.generation!==p.generation||installation.active_path!==p.active_path||installation.control_path!==p.control_path||installation.scope!==p.scope||installation.manager_version!==journal.manager_release.version||canonicalSha256(installation.release)!==canonicalSha256(p.current_release)||canonicalSha256(projectBindings(installation.projects))!==canonicalSha256(projectBindings(p.registration?.before_projects??p.projects)))fail('Before registration binding differs');
  if(p.registration&&canonicalSha256(installation.projects)!==canonicalSha256(p.registration.before_projects))fail('Before project registration differs');
}
async function validateBindings(store,journal) {
  validateJournalScope(journal);
  await checkPlanPaths(journal.plan);
  validateApprovalForPlan(journal.plan,journal.approval,journal.approval.issued_at);
  if(journal.before_generation!==journal.plan.generation||journal.after_generation!==journal.before_generation+1)fail('Generation binding differs');
  if(canonicalSha256(await store.readJson(`${journal.plan.control_path}/approvals/${hash(journal.approval.use_id)}.json`))!==journal.approval_sha256)fail('Approval consumption missing');
}

export async function moveResource({store,file,journal,source,destination,fault=async()=>{}}) {
  const digest=await resourceHash(source);
  if (!digest || await exists(destination)) fail('Move precondition changed');
  return journalAction({store,file,journal,kind:'move',source,destination,beforeSha256:digest,afterSha256:digest,fault,run:()=>store.renameAbsent(source,destination)});
}
export async function readRecoverableJournal(store,file) {
  let bytes;
  try { bytes=await fs.readFile(await store.guard(file),'utf8'); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  if(bytes!==undefined) {
    let value;
    try {value=JSON.parse(bytes);} catch {}
    if(value!==undefined) return validateJournalScope(value); // Unknown schema never falls back.
  }
  return store.readJson(`${file}.prev`,validateJournalScope);
}
export async function requireManager({store,control,journal}) {
  const manager=await restoreAuthenticatedCache({store:authenticatedCacheReader({store,control}),release:journal.manager_release});
  const root=await canonicalPath(fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,''));
  await assertInventory(root,manager.manifest.payload.files,{relative:true});
  const persistent=`${control}/manager/${canonicalSha256(manager.descriptor)}/${manager.manifest.skill_id}`;
  await assertInventory(persistent,manager.manifest.payload.files,{relative:true});
  return persistent;
}
export async function checkSnapshot(store,journal) {
  if(journal.snapshots.length!==1)fail('Snapshot identity missing');
  const record=journal.snapshots[0];
  if(record.path!==`${journal.plan.snapshot.path}/snapshot.json`)fail('Snapshot path changed');
  const bytes=await fs.readFile(await store.guard(record.path));
  if(bytes.length!==record.bytes||hash(bytes)!==record.sha256)fail('Snapshot manifest changed');
  const snapshot=JSON.parse(bytes);
  if(snapshot.snapshot_version!==1||snapshot.transaction_id!==journal.transaction_id||snapshot.plan_sha256!==journal.plan_sha256||canonicalSha256(snapshot)!==await fs.readFile(`${journal.plan.snapshot.path}/snapshot.sha256`,'utf8'))fail('Snapshot binding changed');
  const expected=journal.plan.projects.flatMap(p=>p.files);
  if(snapshot.copies.length!==expected.length)fail('Snapshot resource count changed');
  for(const f of expected) {
    const copies=snapshot.copies.filter(c=>c.original_path===f.path);
    if(copies.length!==1||copies[0].sha256!==f.sha256||copies[0].bytes!==f.bytes)fail('Snapshot mapping changed');
    const c=copies[0]; const b=await fs.readFile(await store.guard(c.path));
    if(!c.path.startsWith(`${journal.plan.snapshot.path}/projects/`)||hash(b)!==c.sha256||b.length!==c.bytes)fail('Snapshot copy changed');
  }
  const snapshotDigest=canonicalSha256(snapshot);
  const expectedFiles=[record,{path:`${journal.plan.snapshot.path}/snapshot.sha256`,bytes:64,sha256:hash(snapshotDigest)},...snapshot.copies.map(({original_path,...f})=>f)].sort((a,b)=>a.path.localeCompare(b.path));
  if(canonicalSha256((await inventory(journal.plan.snapshot.path)).sort((a,b)=>a.path.localeCompare(b.path)))!==canonicalSha256(expectedFiles))fail('Foreign snapshot resource');
  const root=journal.plan.snapshot.path,dirs=new Set([root]);
  const add=directory=>{while(directory!==root){if(!directory.startsWith(root+'/'))fail('Snapshot directory outside scope');dirs.add(directory);directory=path.posix.dirname(directory);}dirs.add(root);};
  for(const f of expectedFiles)add(path.posix.dirname(f.path));
  for(let i=0;i<journal.plan.projects.length;i++){
    const p=journal.plan.projects[i],roots=[p.root_path,...(p.bindings?.reference_roots??[])];
    for(let n=0;n<roots.length;n++)add(`${root}/projects/${i}/roots/${n}`);
    for(const dir of snapshot.projects[i].directories){const n=roots.findIndex(r=>dir===r||dir.startsWith(r+'/'));if(n<0)fail('Snapshot directory scope changed');add(`${root}/projects/${i}/roots/${n}${dir.slice(roots[n].length)}`);}
  }
  if(canonicalSha256([...dirs].sort())!==canonicalSha256(await directoryList(root)))fail('Snapshot directory inventory changed');
  if(journal.plan.operation==='install'||journal.plan.adoption) {
    if(snapshot.installation_prestate!==null||journal.before_generation!==0)fail('Install snapshot prestate differs');
  }else{
    validateBeforeRegistration(snapshot.installation_prestate,journal);
    if(snapshot.installation_prestate.generation!==journal.before_generation||canonicalSha256(snapshot.installation_prestate.release)!==canonicalSha256(journal.plan.current_release))fail('Snapshot installation changed');
  }
  return snapshot;
}
async function validatePoststate(store,journal) {
  const target=await restoreAuthenticatedCache({store:authenticatedCacheReader({store,control:journal.plan.control_path}),release:journal.plan.target_release});
  await assertInventory(journal.plan.target_active_path,target.manifest.payload.files,{relative:true});
  if(journal.plan.active_path!==journal.plan.target_active_path&&await exists(journal.plan.active_path))fail('Previous code still active');
  const installation=await store.readJson(`${journal.plan.control_path}/installation.json`,validateInstallationRecord);
  const p=journal.plan;
  const expected={installation_version:1,install_id:p.install_id,manager_version:journal.manager_release.version,generation:journal.after_generation,channel:p.channel,scope:p.scope,active_path:p.target_active_path,control_path:p.control_path,release:p.target_release,projects:p.data_change?.after_projects??p.projects,last_transaction_id:journal.transaction_id,last_snapshot_path:p.snapshot.path};
  const registrationAction=journal.actions.findLast(a=>a.destination===`${p.control_path}/installation.json`&&['move','write'].includes(a.kind));
  if(canonicalSha256(installation)!==canonicalSha256(expected)||!registrationAction||await resourceHash(registrationAction.destination)!==registrationAction.after_sha256)fail('Post registration differs');
  await Promise.all(installation.projects.map(readProject));
  for(const r of p.data_change?.resources??[])if(await resourceHash(r.path)!==r.after_sha256)fail('After data resource differs');
  return installation;
}
async function validatePrestate(store,journal,snapshot) {
  const p=journal.plan,registry=`${p.control_path}/installation.json`;
  if(p.operation==='install') {
    if(await exists(p.active_path)||await exists(p.target_active_path)||await exists(registry))fail('Absent install prestate not restored');
  }else {
    const current=await restoreAuthenticatedCache({store:authenticatedCacheReader({store,control:p.control_path}),release:p.current_release});
    await assertInventory(p.active_path,current.manifest.payload.files,{relative:true});
    await assertInventory(p.active_path,p.current_files);
    if(p.active_path!==p.target_active_path&&await exists(p.target_active_path))fail('Target code still active');
    if(p.adoption){if(await exists(registry))fail('Adoption registry prestate not absent');}
    else {
      const before=await store.readJson(registry,validateInstallationRecord);validateBeforeRegistration(before,journal);
      if(snapshot&&canonicalSha256(before)!==canonicalSha256(snapshot.installation_prestate))fail('Registration prestate not restored');
    }
  }
  await Promise.all(p.projects.map(project=>readProject(project,{allowLegacy:p.operation==='migrate'})));
  for(const r of p.data_change?.resources??[])if(await resourceHash(r.path)!==r.before_sha256)fail('Before data resource differs');
}
async function validateTerminalState(store,journal) {
  // A phase is only a hint. Snapshot, code, registry and project bytes prove it.
  const snapshot=journal.phase==='ABORTED'&&!journal.actions.some(a=>a.kind==='move')&&!journal.snapshots.length?null:await checkSnapshot(store,journal);
  if(journal.phase==='SUCCEEDED')await validatePoststate(store,journal);
  else await validatePrestate(store,journal,snapshot);
}
export async function reconcile({store,file,journal,lock,fault=async()=>{}}) {
  const control=journal.plan.control_path;
  const managerPath=await requireManager({store,control,journal});
  await validateBindings(store,journal);
  if(terminal.has(journal.phase)&&journal.phase!=='SUCCEEDED') {
    let proven=false;
    try {await validateTerminalState(store,journal);proven=true;}
    catch(error){if(error.code==='LOCKED')throw error;}
    // Only a proven prestate can finish here; otherwise reconcile retained moves.
    if(proven) {await lock.release(journal.phase);return {status:journal.phase,exit_code:3};}
  }
  const hasMoves=journal.actions.some(a=>a.kind==='move');
  if(!hasMoves) {
    await validatePrestate(store,journal,journal.snapshots.length?await checkSnapshot(store,journal):null);
    journal.result='Aborted before resource commit';
    await transitionJournal({store,file,journal,phase:'ABORTED'});await lock.release('ABORTED');
    return {status:'ABORTED',exit_code:3};
  }
  const snapshot=await checkSnapshot(store,journal);
  if(journal.phase==='COMMITTED'||journal.phase==='SUCCEEDED') {
    try {
      const installation=await validatePoststate(store,journal);
      const receipt={transaction_id:journal.transaction_id,installation,snapshot_path:journal.plan.snapshot.path,manager_path:managerPath,reload_required:true,durability:'process-crash',power_loss_verified:false};
      await store.writeJson(`${control}/transactions/${hash(journal.transaction_id)}.receipt.json`,receipt);
      journal.result='Recovered proven committed state';await transitionJournal({store,file,journal,phase:'SUCCEEDED'});await lock.release('SUCCEEDED');
      return {...receipt,status:'SUCCEEDED',exit_code:0};
    }catch(error){ if(error.code==='LOCKED')throw error; }
  }
  // During a data commit some declared files can be temporarily retained in
  // stage. Refuse every foreign path/hash before reversing any resource.
  const approvedData=new Map(journal.plan.projects.flatMap(p=>p.files).map(f=>[f.path,f]));
  const afterData=new Map((journal.plan.data_change?.after_projects.flatMap(p=>p.files)??journal.after_resources.filter(f=>approvedData.has(f.path))).map(f=>[f.path,f]));
  for(const project of journal.plan.projects) {
    for(const directory of project.directories)for(const f of await exists(directory)?await inventory(directory):[]) {
      const before=approvedData.get(f.path),after=afterData.get(f.path);
      if(!before&&!after||![before?.sha256,after?.sha256].includes(f.sha256))fail('Foreign project write blocks restoration');
    }
    for(const f of project.files) {
      const actual=await resourceHash(f.path);
      if(actual!==null&&![f.sha256,afterData.get(f.path)?.sha256].includes(actual))fail('Project fingerprint changed');
    }
  }
  const moves=journal.actions.filter(a=>a.kind==='move'||journal.plan.operation==='install'&&a.kind==='write'&&a.destination===`${control}/installation.json`).map(a=>a.kind==='write'?{...a,source:`${control}/stage/${hash(journal.transaction_id)}-recovered-registration.json`,before_sha256:a.after_sha256,generated_write:true}:a);
  const state=new Map();
  const allowed=new Map();
  for(const a of moves) {
    if(!a.intent||!a.source||!a.before_sha256||a.before_sha256!==a.after_sha256)fail('Unbound move action');
    for(const p of [a.source,a.destination]) {
      if(!allowed.has(p))allowed.set(p,new Set());allowed.get(p).add(a.before_sha256);
      if(!state.has(p))state.set(p,await resourceHash(p));
    }
  }
  for(const [p,digest] of state)if(digest!==null&&!allowed.get(p).has(digest))fail('Foreign resource blocks compensation');
  const reversals=[];
  for(const a of moves.toReversed()) {
    const src=state.get(a.source),dst=state.get(a.destination);
    if(a.generated_write&&src===null&&dst===null)continue;
    if(src===a.before_sha256&&dst!==a.after_sha256)continue;
    if(src!==null||dst!==a.after_sha256)fail('Ambiguous resource; preserve all copies');
    reversals.push(a);state.set(a.source,a.before_sha256);state.set(a.destination,null);
  }
  for(const r of journal.plan.data_change?.resources??[])if((state.has(r.path)?state.get(r.path):await resourceHash(r.path))!==r.before_sha256)fail('Approved data prestate cannot be proven');
  for(const f of approvedData.values()) {
    if(journal.plan.data_change?.resources.some(r=>r.kind==='directory'&&f.path.startsWith(r.path+'/')))continue;
    if((state.has(f.path)?state.get(f.path):await resourceHash(f.path))!==f.sha256)fail('Complete project prestate cannot be proven');
  }
  await transitionJournal({store,file,journal,phase:'RECOVERING'});
  for(const a of reversals) {
    if(await resourceHash(a.destination)!==a.after_sha256||await exists(a.source))fail('Resource changed during compensation');
    await journalAction({store,file,journal,kind:'replace',source:a.destination,destination:a.source,beforeSha256:a.after_sha256,afterSha256:a.before_sha256,fault,run:()=>store.renameAbsent(a.destination,a.source)});
  }
  await validatePrestate(store,journal,snapshot);
  journal.result='Restored exact previous state';await transitionJournal({store,file,journal,phase:'RESTORED'});await lock.release('RESTORED');
  return {status:'RESTORED',exit_code:3};
}
export async function recover({control,transactionId,store:providedStore,fault=async()=>{}}) {
  control=await canonicalPath(control);
  const file=`${control}/transactions/${hash(transactionId)}.json`;
  const reader=providedStore??await createScopedStore({roots:[control]});
  const journal=await readRecoverableJournal(reader,file);
  if(journal.transaction_id!==transactionId||journal.plan.control_path!==control)fail('Recovery identity differs');
  const store=providedStore??await createScopedStore({roots:[control,path.dirname(journal.plan.active_path),journal.plan.snapshot.path,...(journal.plan.data_change?[journal.plan.data_change.stage_path,...(journal.plan.data_change.selected_snapshot?[path.dirname(journal.plan.data_change.selected_snapshot.path)]:[])]:[]),...journal.plan.projects.flatMap(p=>[p.root_path,...(p.bindings?.reference_roots??[])])],fault});
  await requireManager({store,control,journal});
  if(terminal.has(journal.phase)&&!(await exists(`${control}/writer.lock`))) {
    // Without ownership of an interrupted transaction, never compensate historical
    // operations: later project writes must be preserved even when proof fails.
    await validateBindings(store,journal);await validateTerminalState(store,journal);
    return {status:journal.phase,exit_code:journal.phase==='SUCCEEDED'?0:3};
  }
  const lock=await store.recoverLock({file:`${control}/writer.lock`,journalFile:file,journal,allowTerminal:terminal.has(journal.phase)});
  try {await store.readJson(file,validateJournalScope);}
  catch {
    if(await exists(file))await store.renameAbsent(file,`${file}.invalid-${hash(await fs.readFile(file))}`);
    await store.writeJson(file,journal,validateJournalScope);
  }
  try {return await reconcile({store,file,journal,lock,fault});}
  catch(error) {
    journal.result=`Recovery blocked: ${error.code??'INVALID_RESOURCE'}`;
    try{await transitionJournal({store,file,journal,phase:'RECOVERY_REQUIRED'});}catch{}
    throw new DistributionError('RECOVERY_REQUIRED',journal.result);
  }
}



// Called only by operation-specific migration/rollback code after deterministic
// staging. Every replacement is an existing approved file; additions/deletions
// need a separately designed contract and are deliberately refused.
export async function commitDataResources({store,file,journal,replacements,fault=async()=>{}}) {
  if(journal.plan.data_change){
    const d=journal.plan.data_change;
    if(replacements.length!==d.resources.length)fail('Data resource set differs');
    for(let i=0;i<replacements.length;i++){const r=replacements[i],bound=d.resources[i];
      if(r.destination!==bound.path||r.source!==(bound.after_sha256===null?null:`${d.stage_path}/new-${i}`)||await resourceHash(r.destination)!==bound.before_sha256||r.source&&await resourceHash(r.source)!==bound.after_sha256)fail('Data resource differs from approved union');
    }
    journal.after_resources=[...journal.after_resources,...d.after_projects.flatMap(p=>p.files)];await transitionJournal({store,file,journal,phase:journal.phase});
    for(let i=0;i<replacements.length;i++){const r=replacements[i],bound=d.resources[i];
      if(bound.before_sha256!==null)await moveResource({store,file,journal,source:r.destination,destination:`${d.stage_path}/old-${i}`,fault});
      if(r.source!==null)await moveResource({store,file,journal,source:r.source,destination:r.destination,fault});
    }return;
  }
  if(!['migrate','rollback'].includes(journal.plan.operation)||!journal.plan.migration_ids.length)fail('Data changes require explicit migration approval');
  const approved=new Map(journal.plan.projects.flatMap(p=>p.files).map(f=>[f.path,f]));
  const staged=[];
  for(const [index,r] of replacements.entries()) {
    const before=approved.get(r.destination);
    if(!before||!r.source.startsWith(`${journal.plan.control_path}/stage/`)||await resourceHash(r.destination)!==before.sha256)fail('Data replacement outside approved prestate');
    const bytes=await fs.readFile(await store.guard(r.source));
    if(replacements.filter(x=>x.destination===r.destination).length!==1)fail('Duplicate data replacement');
    staged.push({...r,backup:`${journal.plan.control_path}/stage/${hash(journal.transaction_id)}-data-${index}`,resource:{path:r.destination,bytes:bytes.length,sha256:hash(bytes)}});
  }
  const changed=new Set(staged.map(r=>r.destination));
  journal.after_resources=[...journal.after_resources.filter(f=>!changed.has(f.path)),...staged.map(r=>r.resource)];
  await transitionJournal({store,file,journal,phase:journal.phase});
  for(const r of staged)for(const [source,destination] of [[r.destination,r.backup],[r.source,r.destination]])await moveResource({store,file,journal,source,destination,fault});
}
