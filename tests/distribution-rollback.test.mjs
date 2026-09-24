import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { setup,baselineContents,authenticate,approve,nextPlan,operation,runChild } from './helpers/distribution-m5-fixture.mjs';
import { inventory,hash,exists,createScopedStore,assertInventory } from '../scripts/distribution/store.mjs';
import { planSnapshotRestore,directoryList } from '../scripts/distribution/data-change.mjs';
import { resourceHash } from '../scripts/distribution/resources.mjs';
import { canonicalSha256 } from '../scripts/distribution/contracts.mjs';
import { planCommand } from '../scripts/distribution/cli.mjs';
import { transition } from '../scripts/router.mjs';
import { currentRevisionInstructions,checkSideEffect } from '../scripts/contracts.mjs';

async function governedRestore(t){
  const i=await setup(t,{project:true}),p=i.plan.projects[0],root=p.root_path;
  const load=async n=>JSON.parse(await fs.readFile(new URL(`../examples/${n}.json`,import.meta.url)));
  const r={snapshot:await load('project-state'),packet:await load('execution-packet'),result:await load('result-packet'),review:await load('review'),preflight:await load('preflight'),work_type:'general'};
  const go=event=>r.snapshot=transition({...r,event}).snapshot;go('prepare');
  const refs=new Set();const collect=v=>{if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){if(['ref','evidence','evidence_ref'].includes(k)&&typeof x==='string'&&x.length)refs.add(x);else collect(x);}};collect(r);
  const evidence=[];for(const ref of refs){const file=`${root}/evidence-${evidence.length}.txt`;await fs.writeFile(file,'synthetic evidence');evidence.push({ref,root_path:root,path:file,resolution:'bound'});}
  p.bindings={packet_path:`${root}/packet.json`,result_path:`${root}/result.json`,reference_roots:[],evidence};
  await fs.writeFile(p.state_path,JSON.stringify(r.snapshot));await fs.writeFile(p.bindings.packet_path,JSON.stringify(r.packet));await fs.writeFile(p.bindings.result_path,JSON.stringify(r.result));p.files=await inventory(root);
  const ready=structuredClone(r.snapshot),old=await authenticate(t,i,await baselineContents(),'1.1.3'),active=i.plan.active_path.replace('chatgpt-conductor','project-orchestrator');
  const ip={...i.plan,active_path:active,target_active_path:active,target_release:old.bundle.descriptor,changelog:{body:old.bundle.changelog,sha256:old.bundle.descriptor.changelog_sha256}};
  await i.runnerInstall({...i,plan:ip,approval:approve(ip),bundle:old.bundle,source:{recheck:b=>b===old.bundle?old.source.recheck(b):i.source.recheck(b)},transactionId:'install-old'});
  const up=await nextPlan(i,i.bundle,{operation:'update',id:'upgrade'});up.snapshot.path=`${i.plan.control_path}/snapshots/upgrade`;await operation(i,'update',up,{bundle:i.bundle,source:i.source});
  const journal=JSON.parse(await fs.readFile(`${i.plan.control_path}/transactions/${hash('upgrade')}.json`)),snapshot=JSON.parse(await fs.readFile(journal.snapshots[0].path));
  const config={control_path:i.plan.control_path,install_id:'local',scope:'user',target_release_id:'old',channel:'stable',projects:i.plan.projects,software_only:false,snapshot_path:`${i.root}/snapshots/restore`,selected_snapshot:{...journal.snapshots[0],transaction_id:'upgrade',created_at:snapshot.created_at},data_stage_path:`${i.root}/data-stage`};
  const plan=()=>planCommand('rollback',config,{authenticateRelease:async id=>id==='old'?old.bundle:i.bundle});
  return {i,p,r,go,ready,old,plan,config};
}
for(const boundary of ['planning','apply'])for(const verdict of ['REVISE','ACCEPT'])test(`selected snapshot refuses superseded READY authority after real ${verdict} at ${boundary}`,async t=>{
  const {i,p,r,go,ready,old,plan,config}=await governedRestore(t);
  const stale=JSON.parse(JSON.stringify(await plan()));
  go('start');go('submit');r.review.verdict=verdict;r.review.revision_instructions=verdict==='REVISE'?['private-requirement-marker']:[];go(verdict==='REVISE'?'revise':'accept');
  assert.equal(r.snapshot.state,verdict==='REVISE'?'REVISE':'COMPLETE');assert.equal(currentRevisionInstructions(r.snapshot)?.[0]??null,verdict==='REVISE'?'private-requirement-marker':null);
  assert.equal(transition({...r,snapshot:ready,event:'start'}).snapshot.state,'EXECUTE');assert.equal(checkSideEffect(r.packet,transition({...r,snapshot:ready,event:'start'}).snapshot,{action:'local_files_write',target:'summary.md'}).allowed,true);
  await fs.writeFile(p.state_path,JSON.stringify(r.snapshot));const before=await inventory(p.root_path),saved=await fs.readFile(config.selected_snapshot.path);
  const code=verdict==='REVISE'?'SNAPSHOT_REQUIREMENT_CONFLICT':'SNAPSHOT_GOVERNANCE_CONFLICT';
  if(boundary==='planning')await assert.rejects(plan(),error=>error.code===code&&!error.message.includes('private-requirement-marker'));
  // A deserialized plan with refreshed byte preconditions still cannot bypass governance.
  stale.projects[0].files=before;stale.data_change.resources[0].before_sha256=await resourceHash(p.root_path);
  if(boundary==='apply')await assert.rejects(operation(i,'rollback',stale,old),{code});
  assert.deepEqual(await inventory(p.root_path),before);assert.deepEqual(await fs.readFile(config.selected_snapshot.path),saved);
});
test('selected READY snapshot with identical governance remains usable without new project approval',async t=>{
  const {i,p,old,plan}=await governedRestore(t),before=await inventory(p.root_path);
  await fs.writeFile(`${p.root_path}/ordinary-note.txt`,'data-only change');
  const selected=await plan();await operation(i,'rollback',selected,old);
  assert.deepEqual(await inventory(p.root_path),before);
});

test('exact 46-file old product fixture agrees with provenance and unchanged public core',async()=>{
  const contents=await baselineContents();const provenance=JSON.parse(await fs.readFile(new URL('./fixtures/v1.1.3/provenance.json',import.meta.url)));
  assert.equal(Object.keys(contents).length,46);assert.equal(provenance.files.length,46);
  for(const f of provenance.files){assert.equal(contents[f.path].length,f.bytes);assert.equal(hash(contents[f.path]),f.sha256);}
  for(const name of ['contracts.mjs','migration.mjs','router.mjs','cli.mjs'])assert.deepEqual(await fs.readFile(new URL(`../scripts/${name}`,import.meta.url)),contents[`scripts/${name}`]);
});
test('exact V1.1.3 rollback validates actual data, retains manager and manager updates again',async t=>{
  const i=await setup(t,{project:true});await i.runnerInstall(i);
  const old=await authenticate(t,i,await baselineContents(),'1.1.3'),before=await inventory(i.plan.projects[0].root_path);
  const plan=await nextPlan(i,old.bundle);const receipt=await operation(i,'rollback',plan,old);
  assert.equal(receipt.installation.release.version,'1.1.3');assert.deepEqual(await inventory(i.plan.projects[0].root_path),before);
  await assertInventory(receipt.installation.active_path,old.bundle.manifest.payload.files,{relative:true});
  assert.equal(await exists(i.plan.active_path),false);assert.equal(await exists(`${receipt.manager_path}/scripts/distribution/update.mjs`),true);
  i.managerRoot=receipt.manager_path;
  const manager=await authenticate(t,i,i.contents,'1.2.0');i.managerBundle=manager.bundle;i.source=manager.source;
  // This exact manager bundle has a different upgrade_from field from setup;
  // authenticate the original bytes/manifest through the retained module.
  const sourceModule=await import(pathToFileURL(`${i.managerRoot}/scripts/distribution/source.mjs`));
  const storeModule=await import(pathToFileURL(`${i.managerRoot}/scripts/distribution/store.mjs`));
  const store=await storeModule.createScopedStore({roots:[plan.control_path]});
  i.managerBundle=await sourceModule.restoreAuthenticatedCache({store:storeModule.authenticatedCacheReader({store,control:plan.control_path}),release:i.bundle.descriptor});
  const upgrade=await nextPlan(i,manager.bundle,{operation:'update',id:'after-rollback'});
  const next=await operation(i,'update',upgrade,manager,{source:{recheck:b=>b===manager.bundle?manager.source.recheck(b):Promise.resolve(b)}});
  assert.equal(next.installation.release.version,'1.2.0');assert.deepEqual(await inventory(i.plan.projects[0].root_path),before);
});

async function restoreSetup(t,{fileScope=false,changeBeforeUpgrade=false}={}){
  const i=await setup(t,{project:true});const root=i.plan.projects[0].root_path;
  await fs.writeFile(`${root}/removed.txt`,'old retained file');await fs.mkdir(`${root}/old-empty`);
  i.plan.projects[0].files=await inventory(root);
  if(fileScope)i.plan.projects[0].directories=[];
  const old=await authenticate(t,i,await baselineContents(),'1.1.3');
  const originalPlan=i.plan;
  const active=i.plan.active_path.replace('chatgpt-conductor','project-orchestrator');
  const installPlan={...i.plan,active_path:active,target_active_path:active,target_release:old.bundle.descriptor,changelog:{body:old.bundle.changelog,sha256:old.bundle.descriptor.changelog_sha256}};
  await i.runnerInstall({...i,plan:installPlan,approval:approve(installPlan),bundle:old.bundle,source:{recheck:b=>b===old.bundle?old.source.recheck(b):i.source.recheck(b)},transactionId:'install-old'});
  i.plan=originalPlan;
  if(changeBeforeUpgrade){
    const state=JSON.parse(await fs.readFile(i.plan.projects[0].state_path));state.revision++;
    await fs.writeFile(i.plan.projects[0].state_path,JSON.stringify(state));
    await fs.writeFile(`${root}/before-upgrade.txt`,'normal project work before upgrade');
    i.plan.projects[0].files=await inventory(root);
  }
  const upgrade=await nextPlan(i,i.bundle,{operation:'update',id:'upgrade'});
  await operation(i,'update',upgrade,{bundle:i.bundle,source:i.source});
  const before=await inventory(root),dirs=await directoryList(root);
  await fs.unlink(`${root}/removed.txt`);await fs.rmdir(`${root}/old-empty`);await fs.mkdir(`${root}/new-empty`);await fs.writeFile(`${root}/added.txt`,'new loss');
  const state=JSON.parse(await fs.readFile(i.plan.projects[0].state_path));state.revision++;await fs.writeFile(i.plan.projects[0].state_path,JSON.stringify(state));
  const projects=structuredClone(i.plan.projects);projects[0].files=await inventory(root);
  const plan=await nextPlan(i,old.bundle,{id:'restore',projects});
  const journal=JSON.parse(await fs.readFile(`${plan.control_path}/transactions/${hash('upgrade')}.json`));
  const manifest=JSON.parse(await fs.readFile(journal.snapshots[0].path));
  const selection={...journal.snapshots[0],transaction_id:'upgrade',created_at:manifest.created_at};
  const store=await createScopedStore({roots:[plan.control_path,`${i.root}/snapshots`]});
  plan.data_change=await planSnapshotRestore({store,plan,snapshotRecord:selection,stagePath:`${i.root}/data-staging/restore`});
  return {i,old,plan,before,dirs,root,manifest};
}
for(const fileScope of [false,true])test(`snapshot-time fingerprints replace stale registration for ${fileScope?'explicit-file':'directory'} restore`,async t=>{
  const {i,old,plan,before,root,manifest}=await restoreSetup(t,{fileScope,changeBeforeUpgrade:true});
  const historical=manifest.installation_prestate.projects[0].files.find(f=>f.path===plan.projects[0].state_path);
  const snapshotted=before.find(f=>f.path===plan.projects[0].state_path);
  assert.notEqual(historical.sha256,snapshotted.sha256,'registration intentionally predates ordinary project work');
  assert.deepEqual(plan.data_change.after_projects[0].files,before);
  const receipt=await operation(i,'rollback',plan,old);
  assert.deepEqual(await inventory(root),before);
  assert.deepEqual(receipt.installation.projects[0].files,before);
  const unchanged=JSON.parse(await fs.readFile(plan.data_change.selected_snapshot.path));assert.deepEqual(unchanged.installation_prestate,manifest.installation_prestate);
});
test('selected rollback restores added/removed files and empty directories with loss window, current snapshot and after registration',async t=>{
  const {i,old,plan,before,dirs,root}=await restoreSetup(t),current=await inventory(root);
  const receipt=await operation(i,'rollback',plan,old);
  assert.deepEqual(await inventory(root),before);assert.deepEqual(await directoryList(root),dirs);
  assert.deepEqual(receipt.installation.projects,plan.data_change.after_projects);
  assert.equal(plan.migration_ids.length,0);assert.equal(plan.data_change.loss_window.from,plan.data_change.selected_snapshot.created_at);
  const saved=JSON.parse(await fs.readFile(`${receipt.snapshot_path}/snapshot.json`));
  for(const f of current){const c=saved.copies.find(x=>x.original_path===f.path);assert.equal(hash(await fs.readFile(c.path)),f.sha256);}
});
test('explicit file union creates absent old files and retains removed new files without moving unknown siblings',async t=>{
  const {i,old,plan,before,root}=await restoreSetup(t,{fileScope:true});
  await fs.writeFile(`${root}/outside-scope.txt`,'not managed');
  await operation(i,'rollback',plan,old);
  const after=await inventory(root);for(const f of before)assert.deepEqual(after.find(x=>x.path===f.path),f);
  assert.equal(await fs.readFile(`${root}/outside-scope.txt`,'utf8'),'not managed');assert.equal(await exists(`${root}/new-empty`),true);
  assert.equal(await exists(`${root}/added.txt`),false);
  const removed=plan.data_change.resources.findIndex(r=>r.path===`${root}/added.txt`);assert.equal(await fs.readFile(`${plan.data_change.stage_path}/old-${removed}`,'utf8'),'new loss');
});
for(const mode of ['empty-directory','file','snapshot','snapshot-empty-directory','foreign-snapshot'])test(`snapshot restore refuses ${mode} changes without touching current data`,async t=>{
  const {i,old,plan,root}=await restoreSetup(t);
  if(mode==='empty-directory')await fs.mkdir(`${root}/unapproved-empty`);
  if(mode==='file')await fs.writeFile(`${root}/foreign.txt`,'preserve');
  if(mode==='snapshot')await fs.writeFile(plan.data_change.selected_snapshot.path,'tamper');
  if(mode==='snapshot-empty-directory')await fs.mkdir(`${plan.data_change.selected_snapshot.path.slice(0,-'/snapshot.json'.length)}/unapproved-empty`);
  if(mode==='foreign-snapshot')plan.data_change.selected_snapshot.transaction_id='foreign';
  const before=await inventory(root),dirs=await directoryList(root);
  await assert.rejects(operation(i,'rollback',plan,old));
  assert.deepEqual(await inventory(root),before);assert.deepEqual(await directoryList(root),dirs);
});
async function adoptionSetup(t){
  const i=await setup(t,{project:true}),old=await authenticate(t,i,await baselineContents(),'1.1.3');
  const active=i.plan.active_path.replace('chatgpt-conductor','project-orchestrator');
  for(const [name,bytes]of Object.entries(await baselineContents())){const file=`${active}/${name}`;await fs.mkdir(file.slice(0,file.lastIndexOf('/')),{recursive:true});await fs.writeFile(file,bytes);}
  const plan={...i.plan,operation:'update',plan_id:'adopt',active_path:active,current_release:old.bundle.descriptor,current_files:await inventory(active),adoption:{source:'manual-v1.1.3',registry_absent:true},layout:{from:active,to:i.plan.target_active_path}};
  return {i,old,plan,active};
}
test('manual adoption matches exact authenticated 46-file inventory and explicitly renames layout',async t=>{
  const {i,old,plan,active}=await adoptionSetup(t);
  const receipt=await operation(i,'update',plan,{bundle:i.bundle,source:i.source},{currentBundle:old.bundle,source:{recheck:b=>b===old.bundle?old.source.recheck(b):i.source.recheck(b)}});
  assert.equal(receipt.installation.generation,1);assert.equal(await exists(active),false);
});
for(const change of ['extra','missing','dirty','both-paths'])test(`manual adoption refuses ${change} without creating registration`,async t=>{
  const {i,old,plan,active}=await adoptionSetup(t);
  if(change==='extra')await fs.writeFile(`${active}/local.txt`,'custom');
  if(change==='missing')await fs.unlink(`${active}/README.md`);
  if(change==='dirty')await fs.appendFile(`${active}/README.md`,'custom');
  if(change==='both-paths')await fs.mkdir(plan.target_active_path);
  plan.current_files=await inventory(active);
  const before=await inventory(active);
  await assert.rejects(operation(i,'update',plan,{bundle:i.bundle,source:i.source},{currentBundle:old.bundle,source:{recheck:b=>b===old.bundle?old.source.recheck(b):i.source.recheck(b)}}));
  assert.deepEqual(await inventory(active),before);assert.equal(await exists(`${plan.control_path}/installation.json`),false);
});
test('offline selected rollback uses only bound cached releases and explicitly reports stale freshness',async t=>{
  const {i,plan}=await restoreSetup(t);
  const result=await runChild(i,plan);assert.equal(result.code,0,result.out+result.err);
  const receipt=JSON.parse(result.out);assert.equal(receipt.freshness,'stale-offline');assert.equal(receipt.installation.release.version,'1.1.3');
});
for(const committed of [false,true])test(`snapshot rollback real crash ${committed?'COMMITTED':'directory retained'} recovers in a fresh offline manager`,async t=>{
  const {i,plan,root}=await restoreSetup(t),before=await inventory(root),dirs=await directoryList(root);
  const stop=committed?{stopPoint:'journal:after:COMMITTED'}:{stopPoint:'action:after-action',stopKind:'move',stopIndex:2};
  const killed=await runChild(i,plan,stop,true);assert.equal(killed.killed,true,killed.out+killed.err);
  const result=await runChild(i,plan,{recover:true});assert.equal(result.code,0,result.out+result.err);
  assert.equal(JSON.parse(result.out).status,committed?'SUCCEEDED':'RESTORED');
  if(committed){const registration=JSON.parse(await fs.readFile(`${plan.control_path}/installation.json`));assert.deepEqual(registration.projects,plan.data_change.after_projects);}
  else{assert.deepEqual(await inventory(root),before);assert.deepEqual(await directoryList(root),dirs);}
});
