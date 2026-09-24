import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { fixture,zipBytes,hash } from './helpers/distribution-fixtures.mjs';
import { install as installUnbound } from '../scripts/distribution/transaction.mjs';
import { extractVerifiedPayload } from '../scripts/distribution/archive.mjs';
import { canonicalSha256 } from '../scripts/distribution/contracts.mjs';
import { createScopedStore,canonicalPath,exists,authenticatedCacheReader,inventory } from '../scripts/distribution/store.mjs';
import { restoreAuthenticatedCache } from '../scripts/distribution/source.mjs';
import { createSnapshot,readProject } from '../scripts/distribution/snapshot.mjs';
import { transition } from '../scripts/router.mjs';

const install = input => input.runnerInstall(input);
async function managerFiles() {
  const root=await canonicalPath(fileURLToPath(new URL('..',import.meta.url)).replace(/[\\/]$/,''));
  const files={};
  for(const directory of ['scripts/distribution','node_modules/yauzl','node_modules/pend','node_modules/buffer-crc32']) {
    for(const file of await inventory(`${root}/${directory}`)) files[file.path.slice(root.length+1)]=await fs.readFile(file.path);
  }
  for(const file of ['scripts/contracts.mjs','scripts/migration.mjs','contracts/routing.json']) files[file]=await fs.readFile(`${root}/${file}`);
  return files;
}

async function setup(t,{script = 'if(process.env.GH_TOKEN || process.env.NODE_OPTIONS || process.env.PATH) process.exit(9);',project = false} = {}) {
  const root = await canonicalPath(await fs.mkdtemp(path.join(os.tmpdir(),'conductor-install-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const contents = {...await managerFiles(),'SKILL.md':'---\nname: chatgpt-conductor\nmetadata:\n  version: "1.2.0"\n---\n','package.json':JSON.stringify({name:'chatgpt-conductor',version:'1.2.0',type:'module'}),'scripts/verify.mjs':script};
  const zip = await zipBytes(Object.entries(contents).map(([name,body])=>({name:`chatgpt-conductor/${name}`,body})));
  const mutateManifest=m=>{m.payload.files=Object.entries(contents).map(([path,body])=>({path,bytes:Buffer.byteLength(body),sha256:hash(body)}));};
  const bootstrap = await fixture(t,{zip,mutateManifest});
  const originalBundle=await bootstrap.source.acquirePayload(await bootstrap.source.authenticateRelease('123'));
  // Genuine handoff: import only after M2 authenticates and extracts every byte.
  const extracted=await extractVerifiedPayload(originalBundle,{stagingParent:root,name:'bootstrap'});
  const managerRoot=await canonicalPath(extracted.archiveRoot);
  const managerSource=await import(pathToFileURL(`${managerRoot}/scripts/distribution/source.mjs`).href);
  const {install:runnerInstall}=await import(pathToFileURL(`${managerRoot}/scripts/distribution/transaction.mjs`).href);
  const f=await fixture(t,{zip,mutateManifest,sourceFactory:managerSource.createReleaseSource});
  const bundle = await f.source.acquirePayload(await f.source.authenticateRelease('123'));
  const control = `${root}/.agents/.conductor/local`;
  const active = `${root}/.agents/skills/chatgpt-conductor`;
  const projects = [];
  if(project) {
    const projectRoot = `${root}/data`; await fs.mkdir(projectRoot);
    const state = JSON.parse(await fs.readFile(new URL('../examples/project-state.json',import.meta.url),'utf8'));
    const bytes = JSON.stringify(state); await fs.writeFile(`${projectRoot}/state.json`,bytes);
    projects.push({project_id:state.project_id,root_path:projectRoot,state_path:`${projectRoot}/state.json`,directories:[projectRoot],files:[{path:`${projectRoot}/state.json`,bytes:Buffer.byteLength(bytes),sha256:hash(bytes)}],schema_version:2,profile:'po-1.1.3'});
  }
  const plan = {operation:'install',install_id:'local',scope:'user',active_path:active,target_active_path:active,control_path:control,generation:0,current_release:null,target_release:bundle.descriptor,current_files:[],channel:'stable',projects,software_only:!project,migration_ids:[],impact:'Synthetic install',changelog:{body:bundle.changelog,sha256:bundle.descriptor.changelog_sha256},writes:[active,control],recovery:[active,control],snapshot:{path:`${root}/snapshots/first`,capacity_bytes:0},checks:[],quiescence:[],requires_maintenance:false,expires_at:new Date(Date.now()+600000).toISOString(),plan_id:'plan-one',blockers:[],status:'ready'};
  const approval = {plan_id:plan.plan_id,plan_sha256:canonicalSha256(plan),operation:'install',install_id:'local',projects:projects.map(p=>p.project_id),approval_source:'synthetic user test',user_approved:true,writers_stopped:true,issued_at:new Date(Date.now()-1000).toISOString(),expires_at:plan.expires_at,use_id:'once'};
  return {root,plan,approval,bundle,originalBundle,managerRoot,runnerInstall,managerBundle:bundle,source:f.source,contents,deviceOptions:{volume:async()=>true}};
}

test('real authenticated synthetic install reads every file and restores only history-bound cache',async t=>{
  const input = await setup(t);
  delete input.deviceOptions;
  const result = await install(input);
  assert.equal(result.installation.generation,1);
  for(const [name,body] of Object.entries(input.contents)) assert.deepEqual(await fs.readFile(`${input.plan.target_active_path}/${name}`),Buffer.from(body));
  const store = await createScopedStore({roots:[input.plan.control_path]});
  const restored = await restoreAuthenticatedCache({store:authenticatedCacheReader({store,control:input.plan.control_path}),release:input.bundle.descriptor});
  assert.deepEqual(restored.descriptor,input.bundle.descriptor);
  assert.equal(await exists(`${input.plan.control_path}/writer.lock`),false);
  assert.equal((await store.readJson(`${input.plan.snapshot.path}/snapshot.json`).catch(()=>null)),null);
  const snapshot = JSON.parse(await fs.readFile(`${input.plan.snapshot.path}/snapshot.json`,'utf8'));
  assert.equal(snapshot.installation_prestate,null);
  assert.equal(snapshot.software_only,true);
  await assert.rejects(install(input),/exists/i);
});

test('unapproved expired changed plans and occupied targets do not activate',async t=>{
  for (const mutation of [i=>{i.approval.user_approved=false;},i=>{i.approval.expires_at='2000-01-01T00:00:00.000Z';},i=>{i.plan.snapshot.path+='/changed';},async i=>{await fs.mkdir(i.plan.target_active_path,{recursive:true});}]) {
    const i=await setup(t);await mutation(i);await assert.rejects(install(i));
    assert.equal(await exists(`${i.plan.control_path}/installation.json`),false);
  }
});

test('candidate failure preserves data; consumed approval cannot replay',async t=>{
  const i=await setup(t,{script:'process.exit(3)'});
  await assert.rejects(install(i),{code:'VERIFY_FAILED'});
  assert.equal(await exists(i.plan.target_active_path),false);
  await assert.rejects(install(i),{code:'APPROVAL_REPLAY'});
});

test('activation failure restores absent installation and retains snapshot',async t=>{
  const i=await setup(t);
  await assert.rejects(install({...i,fault:async point=>{if(point==='after-registration')throw new Error('injected');}}),/injected/);
  assert.equal(await exists(i.plan.target_active_path),false);
  assert.equal(await exists(`${i.plan.control_path}/installation.json`),false);
  assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);
  assert.equal(await exists(`${i.plan.snapshot.path}/snapshot.json`),true);
});

test('space and permission faults cannot activate',async t=>{
  const i=await setup(t);
  await assert.rejects(install({...i,deviceOptions:{volume:async()=>true,statfs:async()=>({type:0xef53,bavail:0,bsize:4096})}}),{code:'INSUFFICIENT_SPACE'});
  assert.equal(await exists(i.plan.target_active_path),false);
  const j=await setup(t);
  await assert.rejects(install({...j,fault:async point=>{if(point==='write')throw Object.assign(new Error('denied'),{code:'EACCES'});}}),{code:'EACCES'});
  assert.equal(await exists(j.plan.target_active_path),false);
});

test('snapshot rejects newly added/deleted files and corrupt copies',async t=>{
  for(const mode of ['added','deleted','corrupt']) {
    const i=await setup(t,{project:true});
    const store=await createScopedStore({roots:[i.plan.snapshot.path]});
    await assert.rejects(createSnapshot({store,plan:i.plan,transactionId:'snapshot-test',afterCopy:async({copies})=>{
      if(mode==='added')await fs.writeFile(`${i.root}/data/new.txt`,'new');
      if(mode==='deleted')await fs.unlink(`${i.root}/data/state.json`);
      if(mode==='corrupt')await fs.writeFile(copies[0].path,'bad');
    }}));
    assert.equal(await exists(i.plan.target_active_path),false);
  }
});

test('required active packet cannot be replaced by state-only backup',async t=>{
  const i=await setup(t,{project:true});
  const state = JSON.parse(await fs.readFile(`${i.root}/data/state.json`,'utf8'));
  const packet = JSON.parse(await fs.readFile(new URL('../examples/execution-packet.json',import.meta.url),'utf8'));
  const {packetIdentity}=await import('../scripts/contracts.mjs');
  state.active_packet=packetIdentity(packet);
  const bytes=JSON.stringify(state);await fs.writeFile(`${i.root}/data/state.json`,bytes);
  i.plan.projects[0].files[0]={path:`${i.root}/data/state.json`,bytes:Buffer.byteLength(bytes),sha256:hash(bytes)};
  await assert.rejects(readProject(i.plan.projects[0]),/packet|snapshot|state/i);
});

test('successful project snapshot preserves original bytes and revision/lifecycle',async t=>{
  const i=await setup(t,{project:true});
  const before=await fs.readFile(i.plan.projects[0].state_path);
  const receipt=await install(i);
  assert.deepEqual(await fs.readFile(i.plan.projects[0].state_path),before);
  const manifest=JSON.parse(await fs.readFile(`${receipt.snapshot_path}/snapshot.json`,'utf8'));
  assert.deepEqual(await fs.readFile(manifest.copies[0].path),before);
  assert.equal(manifest.projects[0].lifecycle,JSON.parse(before).lifecycle);
});

test('unexpected active modification requires recovery and owner liveness blocks takeover',async t=>{
  const i=await setup(t);
  await assert.rejects(install({...i,transactionId:'retained',fault:async(point,active)=>{
    if(point==='after-registration'){await fs.writeFile(`${active}/user-file.txt`,'preserve');throw new Error('fault');}
  }}),/fault/);
  assert.equal(await fs.readFile(`${i.plan.target_active_path}/user-file.txt`,'utf8'),'preserve');
  const store=await createScopedStore({roots:[i.plan.control_path]});
  const journalFile=`${i.plan.control_path}/transactions/${hash('retained')}.json`;
  const journal=await store.readJson(journalFile);
  assert.equal(journal.phase,'RECOVERY_REQUIRED');
  const options={file:`${i.plan.control_path}/writer.lock`,journalFile};
  await assert.rejects(store.recoverLock(options),/Live|unknown/);
  await assert.rejects(store.recoverLock({...options,probe:async()=> 'unknown'}),/unknown/);
  const recovered=await store.recoverLock({...options,probe:async()=> 'dead'});
  assert.equal(recovered.owner.transaction_id,'retained');
  await recovered.release('RESTORED');
});

test('packet/result/review require exact fingerprints and explicitly inventoried evidence',async t=>{
  const i=await setup(t,{project:true});
  const load=async name=>JSON.parse(await fs.readFile(new URL(`../examples/${name}.json`,import.meta.url),'utf8'));
  const r={snapshot:await load('project-state'),packet:await load('execution-packet'),result:await load('result-packet'),review:await load('review'),preflight:await load('preflight'),work_type:'general'};
  for(const event of ['prepare','start','submit','accept']) r.snapshot=transition({...r,event}).snapshot;
  const project=i.plan.projects[0];
  const bindings={packet_path:`${project.root_path}/packet.json`,result_path:`${project.root_path}/result.json`,reference_roots:[],evidence:[]};
  const refs=new Set();
  function collect(v){if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(['ref','evidence','evidence_ref'].includes(k)&&typeof x==='string'&&x.length)refs.add(x);else if(typeof x==='object')collect(x);}}
  collect(r.packet);collect(r.result);collect(r.snapshot.review_record);
  for(const ref of refs){
    const filename=(ref.includes('/')||ref.includes('\\')||/\.[a-z0-9]{1,8}$/i.test(ref))?ref:`evidence-${bindings.evidence.length}.txt`;
    const file=path.resolve(project.root_path,filename).replaceAll('\\','/');
    await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'synthetic evidence');
    bindings.evidence.push({ref,root_path:project.root_path,path:file,resolution:filename===ref?'relative':'bound'});
  }
  await fs.writeFile(project.state_path,JSON.stringify(r.snapshot));
  await fs.writeFile(bindings.packet_path,JSON.stringify(r.packet));
  await fs.writeFile(bindings.result_path,JSON.stringify(r.result));
  const {inventory}=await import('../scripts/distribution/store.mjs');
  project.bindings=bindings;project.files=await inventory(project.root_path);
  const read=await readProject(project);assert.equal(read.lifecycle,r.snapshot.lifecycle);
  const store=await createScopedStore({roots:[i.plan.snapshot.path]});
  const snapshot=await createSnapshot({store,plan:i.plan,transactionId:'bound'});
  const copy=snapshot.manifest.copies.find(f=>f.original_path===project.state_path);
  assert.deepEqual(JSON.parse(await fs.readFile(copy.path,'utf8')).review_record,r.snapshot.review_record);
  for(const edit of [p=>{p.bindings.result_path=null;},p=>{p.bindings.evidence=[];},p=>{p.files=p.files.filter(f=>f.path!==p.bindings.packet_path);}]) {
    const changed=structuredClone(project);edit(changed);await assert.rejects(readProject(changed));
  }
  r.result.summary='tampered identity';await fs.writeFile(bindings.result_path,JSON.stringify(r.result));
  project.files=await inventory(project.root_path);
  await assert.rejects(readProject(project),/Result identity/);
});

test('migrated historical packet remains evidence without becoming current execution authority',async t=>{
  const i=await setup(t,{project:true});
  const request=JSON.parse(await fs.readFile(new URL('../examples/migration-request.json',import.meta.url),'utf8'));
  const packet=JSON.parse(await fs.readFile(new URL('../examples/execution-packet.json',import.meta.url),'utf8'));
  const {resultDigest}=await import('../scripts/contracts.mjs');
  const {migrateSnapshot}=await import('../scripts/migration.mjs');
  delete packet.lifecycle;packet.schema_version=1;packet.inputs=[];
  request.packet=packet;
  request.snapshot.active_packet={packet_id:packet.packet_id,task_id:packet.task_id,packet_revision:packet.packet_revision,content_sha256:resultDigest(packet)};
  request.confirmation.executor_stopped=true;request.confirmation.effects_reconciled=true;
  request.confirmation.evidence_ref='historical-proof';
  const migrated=migrateSnapshot(request);assert.equal(migrated.status,'migrated');
  const project=i.plan.projects[0];
  await fs.writeFile(project.state_path,JSON.stringify(migrated.snapshot));
  await fs.writeFile(`${project.root_path}/old-packet.json`,JSON.stringify(packet));
  await fs.writeFile(`${project.root_path}/old-state.json`,JSON.stringify(request.snapshot));
  await fs.writeFile(`${project.root_path}/proof.txt`,'synthetic reconciliation');
  project.bindings={packet_path:`${project.root_path}/old-packet.json`,result_path:null,historical_source_path:`${project.root_path}/old-state.json`,reference_roots:[],evidence:[{ref:'historical-proof',root_path:project.root_path,path:`${project.root_path}/proof.txt`,resolution:'bound'}]};
  const {inventory}=await import('../scripts/distribution/store.mjs');project.files=await inventory(project.root_path);
  assert.equal((await readProject(project)).lifecycle,2);
  const stateBytes=await fs.readFile(project.state_path);
  const snapshot=await createSnapshot({store:await createScopedStore({roots:[i.plan.snapshot.path]}),plan:i.plan,transactionId:'historical'});
  assert.deepEqual(await fs.readFile(snapshot.manifest.copies.find(f=>f.original_path===project.state_path).path),stateBytes);
  delete project.bindings.historical_source_path;
  await assert.rejects(readProject(project),/Historical migration evidence/);
});

test('foreign journal actions and unknown journal schema cannot authorize recovery',async t=>{
  const i=await setup(t);await install(i);
  const {validateJournalScope}=await import('../scripts/distribution/store.mjs');
  const dir=`${i.plan.control_path}/transactions`;
  const name=(await fs.readdir(dir)).find(n=>n.endsWith('.json')&&!n.includes('.receipt'));
  const journal=JSON.parse(await fs.readFile(`${dir}/${name}`,'utf8'));
  const wrong=structuredClone(journal);wrong.actions[0].destination=`${i.root}/foreign.txt`;
  assert.throws(()=>validateJournalScope(wrong),{code:'JOURNAL_SCOPE'});
  assert.throws(()=>validateJournalScope({...journal,journal_version:99}),{code:'INVALID_CONTRACT'});
});

for (const partial of [false,true]) test(`registration ${partial?'partial':'complete'} write followed by EIO cannot leave false restored prestate`,async t=>{
  const i=await setup(t);
  const store=await createScopedStore({roots:[i.plan.control_path,path.dirname(i.plan.target_active_path),i.plan.snapshot.path]});
  const writeNew=store.writeNew;
  store.writeNew=async(file,bytes)=>{
    if(file===`${i.plan.control_path}/installation.json`){
      await writeNew(file,partial?bytes.slice(0,30):bytes);
      throw Object.assign(new Error('registration flush failed'),{code:'EIO'});
    }
    return writeNew(file,bytes);
  };
  await assert.rejects(install({...i,store,transactionId:'registration-fault'}),{code:'EIO'});
  const journal=await store.readJson(`${i.plan.control_path}/transactions/${hash('registration-fault')}.json`);
  if(partial){
    assert.equal(journal.phase,'RECOVERY_REQUIRED');
    assert.equal(await exists(`${i.plan.control_path}/writer.lock`),true);
    assert.equal(await exists(`${i.plan.control_path}/installation.json`),true);
  }else{
    assert.equal(journal.phase,'RESTORED');
    assert.equal(await exists(i.plan.target_active_path),false);
    assert.equal(await exists(`${i.plan.control_path}/installation.json`),false);
    assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);
  }
});

test('after-registration project corruption is preserved and blocks successful completion',async t=>{
  const i=await setup(t,{project:true});
  await assert.rejects(install({...i,transactionId:'project-conflict',fault:async point=>{
    if(point==='after-registration')await fs.writeFile(i.plan.projects[0].state_path,'new writer bytes');
  }}));
  assert.equal(await fs.readFile(i.plan.projects[0].state_path,'utf8'),'new writer bytes');
  const journal=JSON.parse(await fs.readFile(`${i.plan.control_path}/transactions/${hash('project-conflict')}.json`,'utf8'));
  assert.equal(journal.phase,'RECOVERY_REQUIRED');
  assert.equal(await exists(`${i.plan.control_path}/writer.lock`),true);
});

test('unbound checkout runner cannot claim authenticated synthetic manager identity',async t=>{
  const i=await setup(t);
  await assert.rejects(installUnbound({...i,bundle:i.originalBundle,managerBundle:i.originalBundle,verified:true}),{code:'MANAGER_IDENTITY'});
  assert.equal(await exists(i.plan.control_path),false);
  assert.equal(await exists(i.plan.target_active_path),false);
});
