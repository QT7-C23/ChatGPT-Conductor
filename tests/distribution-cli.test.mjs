import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setup,legacyMigrations,approve} from './helpers/distribution-m5-fixture.mjs';
import {validateOperationPlan,canonicalSha256} from '../scripts/distribution/contracts.mjs';
import * as fs from 'node:fs/promises';
import {localRelease,localServer,cliChild} from './helpers/distribution-cli-fixture.mjs';
import {baselineContents} from './helpers/distribution-m5-fixture.mjs';
import {inventory,hash} from '../scripts/distribution/store.mjs';
import {runPublicCli} from '../scripts/distribution/cli.mjs';
import {runGh,resolveGh} from '../scripts/distribution/transport.mjs';
import {verifyCandidate,CANDIDATE_TIMEOUT_MS} from '../scripts/distribution/verify.mjs';
import path from 'node:path';
const cli=fileURLToPath(new URL('../scripts/distribution-cli.mjs',import.meta.url));
test('public help and bad calls emit one sanitized envelope with real exit codes',()=>{
  for(const [args,code,status] of [[['--help'],0,'read_only'],[['install','--yes','private-secret'],1,'bad_call'],[['install','--apply','missing.json'],2,'approval_required']]){
    const child=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
    assert.equal(child.status,code,child.stderr);const body=JSON.parse(child.stdout);assert.equal(body.status,status);
    for(const key of ['command','status','plan_id','transaction_id','current_release','target_release','checks','changes','recovery','errors'])assert.ok(Object.hasOwn(body,key));
    assert.ok(!child.stdout.includes('private-secret'));assert.ok(!child.stderr.includes('private-secret'));
  }
});
async function publicFixture(t){
  const i=await setup(t);const old=await baselineContents();const server=await localServer(t,[await localRelease(old,'1.1.3','113'),await localRelease(i.contents,'1.3.0','120')]);
  const config={install_id:'public',scope:'user',control_path:`${i.root}/.agents/.conductor/public`,target_release_id:'120',channel:'stable',projects:[],software_only:true,snapshot_path:`${i.root}/snapshots/public`};
  const run=(args,options)=>cliChild(i.root,server.port,args,options);
  async function plan(command,c=config){const file=`${i.root}/config.json`;await fs.writeFile(file,JSON.stringify(c));const r=await run([command,'--plan','--config',file]);assert.equal(r.code,0,r.out+r.err);return r.body.plan;}
  async function apply(command,p,options){const file=`${i.root}/plan.json`,receipt=`${i.root}/approval.json`;await fs.writeFile(file,JSON.stringify(p));await fs.writeFile(receipt,JSON.stringify(approve(p)));return run([command,'--apply',file,'--approval',receipt],options);}
  return {...i,server,config,run,plan,apply};
}
test('actual public child install update rollback retained manager and approved first legacy registration',async t=>{
  const i=await publicFixture(t);let p=await i.plan('install',{...i.config,target_release_id:'113'}),r=await i.apply('install',p);assert.equal(r.code,0,r.out);const retained=r.body.report.manager_path;
  const config={...i.config,snapshot_path:`${i.root}/snapshots/update`};p=await i.plan('update',config);r=await i.apply('update',p);assert.equal(r.code,0,r.out);
  p=await i.plan('rollback',{...config,target_release_id:'113',snapshot_path:`${i.root}/snapshots/rollback`});r=await i.apply('rollback',p);assert.equal(r.code,0,r.out);assert.equal((await inventory(p.target_active_path)).length,46);assert.ok((await fs.stat(retained)).isDirectory());
  p=await i.plan('update',{...config,snapshot_path:`${i.root}/snapshots/update-again`});r=await i.apply('update',p);assert.equal(r.code,0,r.out);
  const data=`${i.root}/legacy`;await fs.mkdir(data);const state=JSON.parse(await fs.readFile(new URL('../examples/project-state.json',import.meta.url),'utf8'));state.schema_version=1;state.state='PLAN';state.active_packet=null;for(const k of ['lifecycle','revision_reviews','plan_approvals','migration_record','review_record','result_sha256'])delete state[k];
  await fs.writeFile(`${data}/state.json`,JSON.stringify(state));await fs.writeFile(`${data}/proof.txt`,'historical reconciliation');await fs.writeFile(`${data}/confirmation.json`,JSON.stringify({source_kind:'user_instruction',approval_ref:'explicit migration confirmation',executor_stopped:true,effects_reconciled:true,evidence_ref:'proof',pending_revision_instructions:[]}));
  const project={project_id:state.project_id,root_path:data,state_path:`${data}/state.json`,directories:[data],files:await inventory(data),schema_version:1,profile:'po-legacy-schema1',bindings:{packet_path:null,result_path:null,reference_roots:[],evidence:[{ref:'proof',root_path:data,path:`${data}/proof.txt`,resolution:'bound'}]}};
  const before=await inventory(data),request={project_id:state.project_id,destination:`${data}/migrated.json`,packet_path:null,result_path:null,review_path:null,confirmation_path:`${data}/confirmation.json`};
  const migrationConfig={...config,projects:[project],software_only:false,migration_requests:[request],data_stage_path:`${i.root}/data-stage`,snapshot_path:`${i.root}/snapshots/migrate`};
  p=await i.plan('migrate',migrationConfig);assert.deepEqual(p.registration,{before_projects:[],added_project_ids:[state.project_id]});
  r=await i.apply('migrate',p,{fault:{kind:'throw',point:'action:after-action',destination:request.destination}});assert.equal(r.code,3,r.out);assert.deepEqual(await inventory(data),before);assert.deepEqual(JSON.parse(await fs.readFile(`${config.control_path}/installation.json`)).projects,[]);
  p=await i.plan('migrate',{...migrationConfig,data_stage_path:`${i.root}/data-stage-retry`,snapshot_path:`${i.root}/snapshots/migrate-retry`});r=await i.apply('migrate',p);assert.equal(r.code,0,r.out);
  const record=JSON.parse(await fs.readFile(`${config.control_path}/installation.json`));assert.equal(record.projects[0].state_path,request.destination);for(const f of before)assert.equal(hash(await fs.readFile(f.path)),f.sha256);assert.equal(JSON.parse(await fs.readFile(request.destination)).migration_record.authorization_inherited,false);
  const journal=JSON.parse(await fs.readFile(`${config.control_path}/transactions/${hash(r.body.transaction_id)}.json`));assert.equal(journal.phase,'SUCCEEDED');assert.deepEqual(journal.plan.registration.before_projects,[]);
});
for(const [kind,code,status] of [['throw',3,'restored'],['dirty',4,'recovery_required']])test(`public install failure maps durable ${status} to actual exit ${code}`,async t=>{
  const i=await publicFixture(t),p=await i.plan('install');const r=await i.apply('install',p,{fault:{kind,point:'after-registration',active:p.target_active_path}});assert.equal(r.code,code,r.out);assert.equal(r.body.status,status);assert.ok(!r.out.includes('private-secret'));assert.ok(!r.err.includes('private-secret'));
  if(code===3){await assert.rejects(fs.stat(p.target_active_path));await assert.rejects(fs.stat(`${p.control_path}/installation.json`));}else assert.equal(await fs.readFile(`${p.target_active_path}/foreign.txt`,'utf8'),'preserve unexpected writer');
});
test('unapproved altered plans, dirty targets and malformed private JSON fail without mutations',async t=>{
  const i=await publicFixture(t),p=await i.plan('install'),file=`${i.root}/plan.json`,receipt=`${i.root}/approval.json`;await fs.writeFile(file,JSON.stringify({...p,impact:'changed'}));await fs.writeFile(receipt,JSON.stringify(approve(p)));let r=await i.run(['install','--apply',file,'--approval',receipt]);assert.equal(r.code,2);await assert.rejects(fs.stat(p.target_active_path));
  await fs.writeFile(file,'{"private-secret-project":');r=await i.run(['install','--apply',file,'--approval',receipt]);assert.equal(r.code,1);assert.ok(!r.out.includes('private-secret-project'));assert.ok(!r.err.includes('private-secret-project'));
  await fs.mkdir(p.target_active_path,{recursive:true});await fs.writeFile(`${p.target_active_path}/foreign.txt`,'untouched');r=await i.apply('install',p);assert.equal(r.code,2);assert.equal(await fs.readFile(`${p.target_active_path}/foreign.txt`,'utf8'),'untouched');
});
test('actual killed public transaction recovers offline from authenticated sealed manager',async t=>{
  const i=await publicFixture(t),p=await i.plan('install');const killed=await i.apply('install',p,{fault:{kind:'crash',point:'after-registration'},kill:true});assert.equal(killed.killed,true);
  const lock=JSON.parse(await fs.readFile(`${p.control_path}/writer.lock`));const r=await cliChild(i.root,1,['recover','--control',p.control_path,'--transaction',lock.transaction_id]);assert.equal(r.code,3,r.out);assert.equal(r.body.status,'restored');await assert.rejects(fs.stat(p.target_active_path));
});
test('production gh lookup ignores shadow cwd and relative PATH; execution uses resolved safe cwd',async t=>{
  const i=await setup(t),shadow=`${i.root}/shadow`,trusted=`${i.root}/trusted`;await fs.mkdir(shadow);await fs.mkdir(trusted);
  const exe=process.platform==='win32'?'gh.exe':'gh';await fs.copyFile(process.execPath,`${shadow}/${exe}`);await fs.copyFile(process.execPath,`${trusted}/${exe}`);await fs.chmod(`${trusted}/${exe}`,0o755);
  await fs.writeFile(`${shadow}/release`,'process.stdout.write(JSON.stringify({shadow:true}))');
  const selected=await resolveGh({searchPath:['.',shadow,trusted].join(path.delimiter),cwd:shadow});assert.equal(selected,await fs.realpath(`${trusted}/${exe}`));
  const r=await runGh([],{executable:selected,prefixArgs:['-e','process.stdout.write(JSON.stringify({cwd:process.cwd()}))']});assert.equal(await fs.realpath(r.cwd),await fs.realpath(trusted));
  await assert.rejects(resolveGh({searchPath:'.',cwd:shadow}),{code:'AUTHENTICATION_FAILED'});
});
test('candidate finite production budget and trusted short timeout/output limits run actual children',async t=>{
  assert.equal(CANDIDATE_TIMEOUT_MS,1200000);
  for(const [script,options]of [['setInterval(()=>{},1000)',{timeoutMs:50}],['process.stdout.write("x".repeat(10000))',{outputLimit:100}]]){
    const i=await setup(t,{script});const before=Date.now();await assert.rejects(verifyCandidate({bundle:i.originalBundle,root:i.managerRoot,...options}),{code:'VERIFY_FAILED'});assert.ok(Date.now()-before<10000);
  }
});
test('source and native parse errors never disclose private project or token strings',async t=>{
  const i=await setup(t),file=`${i.root}/query.json`;await fs.writeFile(file,JSON.stringify({channel:'stable'}));
  const sourcePorts={transport:async()=>{throw new Error('secret-token-project-marker');}};
  const r=await runPublicCli(['check-update','--config',file],{sourcePorts});assert.equal(r.exitCode,1);assert.ok(!JSON.stringify(r).includes('secret-token-project-marker'));
});
test('public offline rollback binds stale freshness and refuses missing or altered sealed assets',async t=>{
  const i=await publicFixture(t),oldPlan=await i.plan('install',{...i.config,target_release_id:'113'});assert.equal((await i.apply('install',oldPlan)).code,0);
  const update=await i.plan('update',{...i.config,snapshot_path:`${i.root}/snapshots/new`});assert.equal((await i.apply('update',update)).code,0);
  const config={...i.config,target_release_id:'113',offline:true,snapshot_path:`${i.root}/snapshots/offline`},file=`${i.root}/offline-config.json`;await fs.writeFile(file,JSON.stringify(config));
  const offline=args=>cliChild(i.root,1,args);const oldPayload=`${i.config.control_path}/cache/${canonicalSha256(oldPlan.target_release)}/payload.zip`,bytes=await fs.readFile(oldPayload),before=await inventory(update.target_active_path);
  let r=await offline(['rollback','--plan','--config',file]);assert.equal(r.code,0,r.out);const plan=r.body.plan;assert.deepEqual(plan.offline,{freshness:'stale-offline',revocation:'unknown'});
  await fs.rename(oldPayload,`${oldPayload}.retained`);r=await offline(['rollback','--plan','--config',file]);assert.equal(r.code,2,r.out);await fs.rename(`${oldPayload}.retained`,oldPayload);
  const planFile=`${i.root}/offline-plan.json`,receipt=`${i.root}/offline-approval.json`;await fs.writeFile(planFile,JSON.stringify(plan));await fs.writeFile(receipt,JSON.stringify(approve(plan)));
  await fs.appendFile(oldPayload,'changed');r=await offline(['rollback','--apply',planFile,'--approval',receipt]);assert.equal(r.code,2,r.out);assert.deepEqual(await inventory(update.target_active_path),before);await fs.writeFile(oldPayload,bytes);
  r=await offline(['rollback','--apply',planFile,'--approval',receipt]);assert.equal(r.code,0,r.out);assert.equal(r.body.report.freshness,'stale-offline');assert.equal((await inventory(plan.target_active_path)).length,46);
});
test('public verify validates current project writes without changing historical registration',async t=>{
  const i=await publicFixture(t),data=`${i.root}/current-data`;await fs.mkdir(data);const state=JSON.parse(await fs.readFile(new URL('../examples/project-state.json',import.meta.url),'utf8'));await fs.writeFile(`${data}/state.json`,JSON.stringify(state));
  const project={project_id:state.project_id,root_path:data,state_path:`${data}/state.json`,directories:[data],files:await inventory(data),schema_version:2,profile:'po-1.1.3'};
  const p=await i.plan('install',{...i.config,projects:[project],software_only:false});assert.equal((await i.apply('install',p)).code,0);
  const registration=await fs.readFile(`${p.control_path}/installation.json`);state.revision++;await fs.writeFile(`${data}/state.json`,JSON.stringify(state));await fs.writeFile(`${data}/normal-note.txt`,'normal current project write');
  let r=await cliChild(i.root,1,['verify','--control',p.control_path]);assert.equal(r.code,0,r.out);assert.deepEqual(await fs.readFile(`${p.control_path}/installation.json`),registration);
  await fs.appendFile(`${p.target_active_path}/SKILL.md`,'dirty');r=await cliChild(i.root,1,['verify','--control',p.control_path]);assert.equal(r.code,2,r.out);
});
test('registration is an explicit migrate-only union bound to the prior registry',async t=>{
  const i=await setup(t,{migrations:legacyMigrations});
  const plan={...i.plan,registration:{before_projects:[],added_project_ids:[]}};
  assert.throws(()=>validateOperationPlan(plan));
});
test('public CLI plans and applies a nonempty external selected snapshot',async t=>{
  const i=await publicFixture(t),root=`${i.root}/external-project`;await fs.mkdir(root);
  const state=JSON.parse(await fs.readFile(new URL('../examples/project-state.json',import.meta.url)));await fs.writeFile(`${root}/state.json`,JSON.stringify(state));await fs.writeFile(`${root}/note.txt`,'original');
  const project={project_id:state.project_id,root_path:root,state_path:`${root}/state.json`,directories:[root],files:await inventory(root),schema_version:2,profile:'po-1.1.3'};
  const config={...i.config,projects:[project],software_only:false};
  let p=await i.plan('install',{...config,target_release_id:'113'});assert.equal((await i.apply('install',p)).code,0);
  p=await i.plan('update',{...config,snapshot_path:`${i.root}/external-backup/upgrade`});const upgraded=await i.apply('update',p);assert.equal(upgraded.code,0,upgraded.out);
  const journal=JSON.parse(await fs.readFile(`${config.control_path}/transactions/${hash(upgraded.body.transaction_id)}.json`)),record=journal.snapshots[0],manifest=JSON.parse(await fs.readFile(record.path));
  const original=await inventory(root),snapshotBytes=await fs.readFile(record.path);state.revision++;await fs.writeFile(project.state_path,JSON.stringify(state));await fs.writeFile(`${root}/note.txt`,'later');const current=await inventory(root);
  const selected={...config,target_release_id:'113',snapshot_path:`${i.root}/external-backup/restore`,selected_snapshot:{...record,transaction_id:journal.transaction_id,created_at:manifest.created_at},data_stage_path:`${i.root}/restore-stage`};
  const bad=`${i.root}/bad-selection.json`;await fs.writeFile(bad,JSON.stringify({...selected,selected_snapshot:{...selected.selected_snapshot,path:`${root}/state.json`}}));
  const rejected=await i.run(['rollback','--plan','--config',bad]);assert.equal(rejected.code,2);assert.deepEqual(await inventory(root),current);
  p=await i.plan('rollback',selected);const restored=await i.apply('rollback',p);assert.equal(restored.code,0,restored.out);assert.deepEqual(await inventory(root),original);assert.deepEqual(await fs.readFile(record.path),snapshotBytes);
  const retained=JSON.parse(await fs.readFile(`${restored.body.report.snapshot_path}/snapshot.json`));for(const f of current)assert.equal(hash(await fs.readFile(retained.copies.find(c=>c.original_path===f.path).path)),f.sha256);
});
for(const kind of ['unknown-schema','corrupt-both'])test(`recover entry ${kind} preserves evidence and reports actual exit 4`,async t=>{
  const i=await setup(t),control=`${i.root}/.agents/.conductor/recovery`,id=`recover-${kind}`,folder=`${control}/transactions`;await fs.mkdir(folder,{recursive:true});
  const file=`${folder}/${hash(id)}.json`;await fs.writeFile(file,kind==='unknown-schema'?JSON.stringify({journal_version:999,private:'private-project-token-marker'}):'{"private-project-token-marker":');
  if(kind==='corrupt-both')await fs.writeFile(`${file}.prev`,'private-project-token-marker unusable previous');
  const before=await inventory(control),r=await cliChild(i.root,1,['recover','--control',control,'--transaction',id]);assert.equal(r.code,4,r.out);assert.equal(r.body.status,'recovery_required');assert.equal(r.body.transaction_id,id);assert.deepEqual(r.body.recovery,{control,transaction_id:id});assert.deepEqual(await inventory(control),before);assert.ok(!r.out.includes('private-project-token-marker'));assert.ok(!r.err.includes('private-project-token-marker'));
});
for(const missing of ['manager','cache'])test(`recover entry identified transaction missing ${missing} stays recovery-required without writes`,async t=>{
  const i=await publicFixture(t),p=await i.plan('install');const crashed=await i.apply('install',p,{fault:{kind:'crash',point:'after-registration'},kill:true});assert.equal(crashed.killed,true);
  const lock=JSON.parse(await fs.readFile(`${p.control_path}/writer.lock`));await fs.rename(`${p.control_path}/${missing}`,`${p.control_path}/${missing}-retained`);const before=await inventory(p.control_path);
  const r=await cliChild(i.root,1,['recover','--control',p.control_path,'--transaction',lock.transaction_id]);assert.equal(r.code,4,r.out);assert.equal(r.body.status,'recovery_required');assert.equal(r.body.recovery.transaction_id,lock.transaction_id);assert.deepEqual(await inventory(p.control_path),before);
});
test('recover entry usable prior remains recoverable and unrelated absent transaction is not exit 4',async t=>{
  const i=await publicFixture(t),p=await i.plan('install');const crashed=await i.apply('install',p,{fault:{kind:'crash',point:'after-registration'},kill:true});assert.equal(crashed.killed,true);
  const lock=JSON.parse(await fs.readFile(`${p.control_path}/writer.lock`)),file=`${p.control_path}/transactions/${hash(lock.transaction_id)}.json`;await fs.writeFile(file,'{"private-project-token-marker":');
  const before=await inventory(p.control_path);
  for(const [args,code]of [[['recover','--yes'],1],[['recover','--control','relative','--transaction',lock.transaction_id],1],[['recover','--control',p.control_path,'--transaction','entirely-absent'],2]]){const r=await cliChild(i.root,1,args);assert.equal(r.code,code,r.out);assert.notEqual(r.body.status,'recovery_required');}
  assert.deepEqual(await inventory(p.control_path),before);
  const r=await cliChild(i.root,1,['recover','--control',p.control_path,'--transaction',lock.transaction_id]);assert.equal(r.code,3,r.out);assert.equal(r.body.status,'restored');assert.ok(!r.out.includes('private-project-token-marker'));await assert.rejects(fs.stat(p.target_active_path));
  const retained=(await fs.readdir(`${p.control_path}/transactions`)).find(n=>n.startsWith(`${hash(lock.transaction_id)}.json.invalid-`));assert.ok(retained);assert.equal(await fs.readFile(`${p.control_path}/transactions/${retained}`,'utf8'),'{"private-project-token-marker":');
});
