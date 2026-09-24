import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setup } from './helpers/distribution-update-fixture.mjs';
import { inventory,hash,exists } from '../scripts/distribution/store.mjs';
import { canonicalSha256 } from '../scripts/distribution/contracts.mjs';
const child=fileURLToPath(new URL('./helpers/distribution-recovery-child.mjs',import.meta.url));
const publicCli=fileURLToPath(new URL('../scripts/distribution-cli.mjs',import.meta.url));
function publicRecover(i) {
  const r=spawnSync(process.execPath,[publicCli,'recover','--control',i.plan.control_path,'--transaction','update-one'],{encoding:'utf8',windowsHide:true});
  assert.equal(r.error,undefined);return {code:r.status,body:JSON.parse(r.stdout),out:r.stdout+r.stderr};
}
const journalFile=i=>`${i.plan.control_path}/transactions/${hash('update-one')}.json`;
async function setPhase(i,phase,mutate=()=>{}) {
  const j=JSON.parse(await fs.readFile(journalFile(i)));j.phase=phase;await mutate(j);await fs.writeFile(journalFile(i),JSON.stringify(j));return j;
}
async function requestFor(t) {
  const i=await setup(t,{project:true});
  await fs.writeFile(`${i.root}/data/evidence.txt`,'synthetic evidence');
  i.plan.projects[0].files=await inventory(`${i.root}/data`);i.approval.plan_sha256=canonicalSha256(i.plan);
  await i.runnerInstall(i);
  const plan={...i.plan,operation:'update',generation:1,current_release:i.bundle.descriptor,current_files:await inventory(i.plan.active_path),snapshot:{path:`${i.root}/snapshots/update`,capacity_bytes:0},plan_id:'update-plan'};
  const approval={...i.approval,operation:'update',plan_id:plan.plan_id,use_id:'update-once'};
  const managerContents=Object.fromEntries(Object.entries(i.contents).map(([k,v])=>[k,Buffer.from(v).toString('base64')]));
  const targetContents={...managerContents,'SKILL.md':Buffer.from('---\nname: chatgpt-conductor\nmetadata:\n  version: "1.2.1"\n---\n').toString('base64'),'package.json':Buffer.from(JSON.stringify({name:'chatgpt-conductor',version:'1.2.1',type:'module'})).toString('base64')};
  return {...i,request:{managerRoot:i.managerRoot,plan,approval,managerContents,targetContents}};
}
async function run(i,request,kill=false) {
  const file=`${i.root}/request.json`;await fs.writeFile(file,JSON.stringify(request));
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[child,file],{shell:false,windowsHide:true,env:{...process.env,GH_TOKEN:undefined,NODE_OPTIONS:undefined}});let out='',err='',killed=false;
    const timer=setTimeout(()=>{p.kill();reject(new Error(`Child timeout: ${out} ${err}`));},30000);
    p.stdout.on('data',b=>{out+=b;if(kill&&out.includes('READY')&&!killed){killed=true;if(kill==='hold'){clearTimeout(timer);resolve({process:p,out,err,alive:true});}else p.kill('SIGKILL');}});p.stderr.on('data',b=>err+=b);
    p.on('error',reject);p.on('exit',code=>{clearTimeout(timer);resolve({code,out,err,killed});});
  });
}
test('authenticated update preserves every project byte and advances registration',async t=>{
  const i=await requestFor(t),before=await fs.readFile(i.plan.projects[0].state_path);
  const result=await run(i,i.request);assert.equal(result.code,0,result.out+result.err);
  assert.equal(JSON.parse(await fs.readFile(`${i.plan.control_path}/installation.json`)).generation,2);
  assert.deepEqual(await fs.readFile(i.plan.projects[0].state_path),before);
});
for(const point of ['action:after-intent','action:before-action','action:after-action','action:before-completion','action:after-completion'])for(let index=0;index<4;index++)test(`real crash ${point} move ${index} restores in fresh offline manager`,async t=>{
  const i=await requestFor(t),before=await inventory(i.plan.active_path),registration=await fs.readFile(`${i.plan.control_path}/installation.json`),data=await fs.readFile(i.plan.projects[0].state_path);
  const stopped=await run(i,{...i.request,stopPoint:point,stopKind:'move',stopIndex:index},true);assert.equal(stopped.killed,true,stopped.out+stopped.err);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);assert.equal(JSON.parse(result.out).exit_code,3);
  assert.deepEqual(await inventory(i.plan.active_path),before);assert.deepEqual(await fs.readFile(`${i.plan.control_path}/installation.json`),registration);assert.deepEqual(await fs.readFile(i.plan.projects[0].state_path),data);
  assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);
});
test('committed crash finishes receipt; historical recovery blocks without rewinding later project writes',async t=>{
  const i=await requestFor(t);
  assert.equal((await run(i,{...i.request,stopPoint:'journal:after:COMMITTED'},true)).killed,true);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);assert.equal(JSON.parse(result.out).exit_code,0);
  await fs.writeFile(i.plan.projects[0].state_path,'later writer');
  const journal=await fs.readFile(journalFile(i));
  const again=await run(i,{...i.request,mode:'recover'});assert.equal(again.code,4,again.out+again.err);assert.equal(await fs.readFile(i.plan.projects[0].state_path,'utf8'),'later writer');
  assert.deepEqual(await fs.readFile(journalFile(i)),journal);assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);
});
for(const dataStop of [1,2,3,4])test(`partial multi-file data commit ${dataStop} restores all original bytes`,async t=>{
  const i=await requestFor(t),before=await inventory(`${i.root}/data`);
  const stopped=await run(i,{...i.request,mode:'data',dataStop},true);assert.equal(stopped.killed,true,stopped.out+stopped.err);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);assert.equal(JSON.parse(result.out).exit_code,3);
  assert.deepEqual(await inventory(`${i.root}/data`),before);
});
for(const mutation of ['truncated','missing-latest','unknown-schema','snapshot-missing','snapshot-extra','foreign-code','foreign-data','missing-journal','missing-lock'])test(`recovery boundary ${mutation}`,async t=>{
  const i=await requestFor(t);
  assert.equal((await run(i,{...i.request,stopPoint:'action:after-completion',stopKind:'move',stopIndex:1},true)).killed,true);
  const file=`${i.plan.control_path}/transactions/${hash('update-one')}.json`;
  if(mutation==='truncated')await fs.writeFile(file,'{');
  if(mutation==='missing-latest')await fs.unlink(file);
  if(mutation==='unknown-schema'){const j=JSON.parse(await fs.readFile(file));j.journal_version=99;await fs.writeFile(file,JSON.stringify(j));}
  if(mutation==='snapshot-missing')await fs.unlink(`${i.request.plan.snapshot.path}/snapshot.json`);
  if(mutation==='snapshot-extra')await fs.writeFile(`${i.request.plan.snapshot.path}/foreign.txt`,'foreign copy');
  if(mutation==='foreign-code')await fs.writeFile(`${i.plan.active_path}/foreign.txt`,'later bytes');
  if(mutation==='foreign-data')await fs.writeFile(`${i.root}/data/foreign.txt`,'later data');
  if(mutation==='missing-journal'){await fs.unlink(file);await fs.unlink(`${file}.prev`);}
  if(mutation==='missing-lock')await fs.unlink(`${i.plan.control_path}/writer.lock`);
  const result=await run(i,{...i.request,mode:'recover'});
  assert.equal(result.code,['truncated','missing-latest'].includes(mutation)?0:4,result.out+result.err);
  if(mutation==='foreign-code')assert.equal(await fs.readFile(`${i.plan.active_path}/foreign.txt`,'utf8'),'later bytes');
  if(mutation==='foreign-data')assert.equal(await fs.readFile(`${i.root}/data/foreign.txt`,'utf8'),'later data');
});
for(const phase of ['PLANNED','APPROVED','PREPARED','SNAPSHOTTED','STAGED','VERIFIED','COMMITTING','SUCCEEDED'])test(`fresh recovery after durable ${phase}`,async t=>{
  const i=await requestFor(t);
  const stopped=await run(i,{...i.request,stopPoint:`journal:after:${phase}`},true);assert.equal(stopped.killed,true,stopped.out+stopped.err);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);assert.equal(JSON.parse(result.out).exit_code,phase==='SUCCEEDED'?0:3);
  assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);
});
for(const point of ['json:after-temp','json:after-previous','replace-json','json:after-replace'])test(`actual journal persistence interruption ${point}`,async t=>{
  const i=await requestFor(t);
  const stopped=await run(i,{...i.request,stopPoint:point,stopJournal:true,stopIndex:1},true);assert.equal(stopped.killed,true,stopped.out+stopped.err);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);assert.equal(JSON.parse(result.out).exit_code,3);
});
test('receipt persistence crash finishes proven committed registration',async t=>{
  const i=await requestFor(t);
  assert.equal((await run(i,{...i.request,stopPoint:'json:after-replace',stopReceipt:true},true)).killed,true);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);assert.equal(JSON.parse(result.out).exit_code,0);
});

for(const mode of ['rename-failure','compensation-crash'])test(`recovery is repeatable after ${mode}`,async t=>{
  const i=await requestFor(t),before=await inventory(i.plan.active_path);
  assert.equal((await run(i,{...i.request,stopPoint:'action:after-completion',stopKind:'move',stopIndex:3},true)).killed,true);
  if(mode==='rename-failure')assert.equal((await run(i,{...i.request,mode:'recover',failRename:true})).code,4);
  else assert.equal((await run(i,{...i.request,mode:'recover',recoveryStop:'action:after-action'},true)).killed,true);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);assert.deepEqual(await inventory(i.plan.active_path),before);
});
test('real Windows exclusive file handle prevents rename without fallback overwrite',{skip:process.platform!=='win32'},async t=>{
  const i=await requestFor(t);
  assert.equal((await run(i,{...i.request,stopPoint:'action:after-completion',stopKind:'move',stopIndex:1},true)).killed,true);
  const locked=`${i.plan.active_path}/SKILL.md`,bytes=await fs.readFile(locked);
  const script='$h=[System.IO.File]::Open($env:CONDUCTOR_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None);[Console]::WriteLine("READY");[Console]::ReadLine();$h.Dispose()';
  const holder=spawn(`${process.env.SystemRoot}/System32/WindowsPowerShell/v1.0/powershell.exe`,['-NoProfile','-NonInteractive','-Command',script],{shell:false,windowsHide:true,env:{...process.env,CONDUCTOR_LOCK_FILE:locked}});
  await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Exclusive holder startup timed out')),10000);holder.stdout.on('data',b=>{text+=b;if(text.includes('READY')){clearTimeout(timer);resolve();}});holder.on('exit',code=>{if(!text.includes('READY')){clearTimeout(timer);reject(new Error(`Holder failed ${code}`));}});});
  t.after(()=>holder.kill());
  const blocked=await run(i,{...i.request,mode:'recover'});assert.equal(blocked.code,4,blocked.out+blocked.err);
  holder.stdin.end('\n');await new Promise(resolve=>holder.on('exit',resolve));
  assert.deepEqual(await fs.readFile(locked),bytes);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);
});


test('fresh process recovers interrupted initial install to proven absent prestate',async t=>{
  const i=await setup(t,{project:true});
  const contents=Object.fromEntries(Object.entries(i.contents).map(([k,v])=>[k,Buffer.from(v).toString('base64')]));
  const request={managerRoot:i.managerRoot,plan:i.plan,approval:i.approval,managerContents:contents,targetContents:contents,mode:'install'};
  const stopped=await run(i,{...request,stopPoint:'action:after-action',stopKind:'write'},true);assert.equal(stopped.killed,true,stopped.out+stopped.err);
  const result=await run(i,{...request,mode:'recover'});assert.equal(result.code,0,result.out+result.err);assert.equal(JSON.parse(result.out).exit_code,3);
  assert.equal(await exists(i.plan.active_path),false);assert.equal(await exists(`${i.plan.control_path}/installation.json`),false);
});
test('concurrent updater, consumed approval and transaction identity are rejected',async t=>{
  const i=await requestFor(t);
  const first=await run(i,{...i.request,stopPoint:'journal:after:VERIFIED'},'hold');assert.equal(first.alive,true);t.after(()=>first.process.kill());
  const competing=await run(i,{...i.request,transactionId:'competing'});assert.equal(competing.code,4);assert.equal(JSON.parse(competing.out).error,'LOCKED');
  const ended=new Promise(resolve=>first.process.on('exit',resolve));first.process.kill('SIGKILL');await ended;
  assert.equal((await run(i,{...i.request,mode:'recover'})).code,0);
  const reused=await run(i,i.request);assert.equal(reused.code,4);assert.equal(JSON.parse(reused.out).error,'TRANSACTION_EXISTS');
  const replay=await run(i,{...i.request,transactionId:'different'});assert.equal(replay.code,4);assert.equal(JSON.parse(replay.out).error,'APPROVAL_REPLAY');
});
test('fallback lacking executed action intent preserves ambiguous generations',async t=>{
  const i=await requestFor(t);
  assert.equal((await run(i,{...i.request,stopPoint:'action:after-action',stopKind:'move',stopIndex:1},true)).killed,true);
  await fs.writeFile(`${i.plan.control_path}/transactions/${hash('update-one')}.json`,'{');
  const active=await inventory(i.plan.active_path);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,4);assert.deepEqual(await inventory(i.plan.active_path),active);
});
test('interrupted takeover guard fails closed with retained evidence',async t=>{
  const i=await requestFor(t);
  assert.equal((await run(i,{...i.request,stopPoint:'journal:after:VERIFIED'},true)).killed,true);
  const lock=`${i.plan.control_path}/writer.lock`,bytes=await fs.readFile(lock);
  await fs.writeFile(`${lock}.takeover`,bytes);
  const result=await run(i,{...i.request,mode:'recover'});assert.equal(result.code,4);assert.equal(JSON.parse(result.out).error,'LOCKED');assert.deepEqual(await fs.readFile(lock),bytes);assert.deepEqual(await fs.readFile(`${lock}.takeover`),bytes);
});
test('prepublication failure preserves existing cache authority and permits fresh approved retry',async t=>{
  const i=await requestFor(t);
  const {fixture,zipBytes,hash:fixtureHash}=await import('./helpers/distribution-fixtures.mjs');
  const {pathToFileURL}=await import('node:url');
  const sourceModule=await import(pathToFileURL(`${i.managerRoot}/scripts/distribution/source.mjs`));
  const {update}=await import(pathToFileURL(`${i.managerRoot}/scripts/distribution/update.mjs`));
  const {createScopedStore,authenticatedCacheReader}=await import(pathToFileURL(`${i.managerRoot}/scripts/distribution/store.mjs`));
  const contents=i.request.targetContents;
  const zip=await zipBytes(Object.entries(contents).map(([name,body])=>({name:`chatgpt-conductor/${name}`,body:Buffer.from(body,'base64')})));
  const target=await fixture(t,{zip,sourceFactory:sourceModule.createReleaseSource,mutateRelease:r=>{r.tag_name='v1.2.1';},mutateManifest:m=>{m.version='1.2.1';m.tag='v1.2.1';m.payload.name='chatgpt-conductor-1.2.1.zip';m.upgrade_from=['1.2.0'];m.payload.files=Object.entries(contents).map(([path,b])=>({path,bytes:Buffer.from(b,'base64').length,sha256:fixtureHash(Buffer.from(b,'base64'))}));}});
  const bundle=await target.source.acquirePayload(await target.source.authenticateRelease('123'));
  const plan={...i.request.plan,target_release:bundle.descriptor,changelog:{body:bundle.changelog,sha256:bundle.descriptor.changelog_sha256}};
  const approval={...i.request.approval,plan_sha256:canonicalSha256(plan)};
  const options={plan,approval,bundle,managerBundle:i.bundle,source:{recheck:b=>b===bundle?target.source.recheck(b):i.source.recheck(b)},deviceOptions:i.deviceOptions};
  const beforeCode=await inventory(i.plan.active_path),beforeData=await inventory(`${i.root}/data`),beforeRegistration=await fs.readFile(`${plan.control_path}/installation.json`);
  const recordPath=`${plan.control_path}/cache/${canonicalSha256(i.bundle.descriptor)}/record.json`,beforeAuthority=await fs.readFile(recordPath);
  await assert.rejects(update({...options,transactionId:'prepublication-failure',fault:async point=>{if(point==='journal:before:PLANNED')throw new Error('prepared manager; publication failed');}}),/publication failed/);
  assert.deepEqual(await inventory(i.plan.active_path),beforeCode);assert.deepEqual(await inventory(`${i.root}/data`),beforeData);assert.deepEqual(await fs.readFile(`${plan.control_path}/installation.json`),beforeRegistration);
  assert.equal(await exists(`${plan.control_path}/writer.lock`),false);assert.equal(await exists(`${plan.control_path}/transactions/${hash('prepublication-failure')}.json`),false);
  const store=await createScopedStore({roots:[plan.control_path]});
  const restored=await sourceModule.restoreAuthenticatedCache({store:authenticatedCacheReader({store,control:plan.control_path}),release:i.bundle.descriptor});assert.deepEqual(restored.descriptor,i.bundle.descriptor);
  assert.deepEqual(await fs.readFile(recordPath),beforeAuthority);
  const result=await update({...options,approval:{...approval,use_id:'fresh-prepublication-retry'},transactionId:'prepublication-retry'});
  assert.equal(result.installation.generation,2);assert.deepEqual(await inventory(`${i.root}/data`),beforeData);
  const retried=await sourceModule.restoreAuthenticatedCache({store:authenticatedCacheReader({store,control:plan.control_path}),release:bundle.descriptor});assert.deepEqual(retried.descriptor,bundle.descriptor);
  assert.equal((await store.readJson(`${plan.control_path}/cache/${canonicalSha256(bundle.descriptor)}/record.json`)).transaction_id,'prepublication-retry');
});

for(const phase of ['SUCCEEDED','RESTORED','ABORTED'])test(`P1 R1/R2 premature ${phase} reconciles new code and old registry`,async t=>{
  const i=await requestFor(t),before=await inventory(i.plan.active_path),registry=await fs.readFile(`${i.plan.control_path}/installation.json`);
  assert.equal((await run(i,{...i.request,stopPoint:'action:after-action',stopKind:'move',stopIndex:1},true)).killed,true);
  const j=await setPhase(i,phase);
  assert.equal(JSON.parse(await fs.readFile(`${i.plan.active_path}/package.json`)).version,'1.2.1');
  assert.equal(JSON.parse(registry).release.version,'1.2.0');
  const r=publicRecover(i);t.diagnostic(JSON.stringify({phase,exit:r.code,status:r.body.status,lock:await exists(`${i.plan.control_path}/writer.lock`)}));
  assert.equal(r.code,3,r.out);assert.equal(r.body.status,'restored');
  assert.deepEqual(await inventory(i.plan.active_path),before);assert.deepEqual(await fs.readFile(`${i.plan.control_path}/installation.json`),registry);
  assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);
  assert.equal(await exists(`${j.plan.snapshot.path}/snapshot.json`),true);assert.equal(publicRecover(i).code,3);
});

for(const phase of ['SUCCEEDED','RESTORED'])test(`P1 R1 initial install new code missing registry ${phase}`,async t=>{
  const i=await setup(t,{project:true}),contents=Object.fromEntries(Object.entries(i.contents).map(([k,v])=>[k,Buffer.from(v).toString('base64')]));
  const request={managerRoot:i.managerRoot,plan:i.plan,approval:i.approval,managerContents:contents,targetContents:contents,mode:'install'};
  assert.equal((await run(i,{...request,stopPoint:'action:after-action',stopKind:'move'},true)).killed,true);
  await setPhase(i,phase);assert.equal(await exists(i.plan.active_path),true);assert.equal(await exists(`${i.plan.control_path}/installation.json`),false);
  const r=publicRecover(i);assert.equal(r.code,3,r.out);assert.equal(r.body.status,'restored');
  assert.equal(await exists(i.plan.active_path),false);assert.equal(await exists(`${i.plan.control_path}/installation.json`),false);assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);
});

test('P1 R3 genuine SUCCEEDED accepts full poststate without rollback and repeats',async t=>{
  const i=await requestFor(t);assert.equal((await run(i,{...i.request,stopPoint:'journal:after:SUCCEEDED'},true)).killed,true);
  const code=await inventory(i.plan.active_path),registry=await fs.readFile(`${i.plan.control_path}/installation.json`);
  for(let n=0;n<2;n++){const r=publicRecover(i);assert.equal(r.code,0,r.out);assert.equal(r.body.status,'succeeded');assert.deepEqual(await inventory(i.plan.active_path),code);assert.deepEqual(await fs.readFile(`${i.plan.control_path}/installation.json`),registry);assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);}
});
test('P1 R4/R5 genuine RESTORED with or without retained lock accepts full prestate',async t=>{
  const i=await requestFor(t),code=await inventory(i.plan.active_path),registry=await fs.readFile(`${i.plan.control_path}/installation.json`);
  assert.equal((await run(i,{...i.request,stopPoint:'action:after-action',stopKind:'move',stopIndex:1},true)).killed,true);
  assert.equal((await run(i,{...i.request,mode:'recover',recoveryPhase:'RESTORED'},true)).killed,true);
  for(let n=0;n<2;n++){const r=publicRecover(i);assert.equal(r.code,3,r.out);assert.deepEqual(await inventory(i.plan.active_path),code);assert.deepEqual(await fs.readFile(`${i.plan.control_path}/installation.json`),registry);assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);}
});
for(const mutation of ['foreign-code','snapshot-transaction','plan-digest','approval-missing','manager-missing','registry-manager','old-code-new-registry','old-code-new-registry-restored','missing-registry','lock-transaction'])test(`P1 R6 terminal durable mismatch blocks: ${mutation}`,async t=>{
  const i=await requestFor(t);
  const after=mutation.startsWith('old-code-new-registry')||mutation==='missing-registry'||mutation==='registry-manager';
  assert.equal((await run(i,{...i.request,...(after?{stopPoint:'journal:after:SUCCEEDED'}:{stopPoint:'action:after-action',stopKind:'move',stopIndex:1})},true)).killed,true);
  const j=await setPhase(i,mutation.endsWith('-restored')?'RESTORED':'SUCCEEDED',j=>{if(mutation==='plan-digest')j.plan_sha256='a'.repeat(64);});
  if(mutation==='approval-missing')await fs.rename(`${i.plan.control_path}/approvals/${hash(j.approval.use_id)}.json`,`${i.root}/retained-approval.json`);
  if(mutation==='foreign-code')await fs.writeFile(`${i.plan.active_path}/foreign.txt`,'preserve unknown bytes');
  if(mutation==='snapshot-transaction'){
    const f=`${j.plan.snapshot.path}/snapshot.json`,s=JSON.parse(await fs.readFile(f));s.transaction_id='another-transaction';const bytes=JSON.stringify(s);await fs.writeFile(f,bytes);await fs.writeFile(`${j.plan.snapshot.path}/snapshot.sha256`,canonicalSha256(s));
    await setPhase(i,'SUCCEEDED',j=>{j.snapshots[0].sha256=hash(bytes);j.snapshots[0].bytes=Buffer.byteLength(bytes);});
  }
  if(mutation==='manager-missing')await fs.rename(`${i.plan.control_path}/manager`,`${i.root}/retained-manager`);
  if(mutation==='registry-manager'){const f=`${i.plan.control_path}/installation.json`,r=JSON.parse(await fs.readFile(f));r.manager_version='1.1.3';await fs.writeFile(f,JSON.stringify(r));}
  if(mutation.startsWith('old-code-new-registry')){await fs.rename(i.plan.active_path,`${i.root}/retained-new-code`);await fs.rename(`${i.plan.control_path}/stage/${hash('update-one')}-old-code`,i.plan.active_path);}
  if(mutation==='missing-registry')await fs.rename(`${i.plan.control_path}/installation.json`,`${i.root}/retained-new-registry.json`);
  if(mutation==='lock-transaction'){const f=`${i.plan.control_path}/writer.lock`,l=JSON.parse(await fs.readFile(f));l.transaction_id='another-transaction';await fs.writeFile(f,JSON.stringify(l));}
  const before=await inventory(i.plan.active_path);
  for(let n=0;n<2;n++){const r=publicRecover(i);assert.equal(r.code,4,r.out);assert.equal(r.body.status,'recovery_required');assert.equal(await exists(`${i.plan.control_path}/writer.lock`),true);assert.deepEqual(await inventory(i.plan.active_path),before);assert.equal(await exists(journalFile(i)),true);}
});
test('P1 R2/R6 restored code with foreign project state stays blocked',async t=>{
  const i=await requestFor(t);assert.equal((await run(i,{...i.request,stopPoint:'action:after-action',stopKind:'move',stopIndex:1},true)).killed,true);
  assert.equal((await run(i,{...i.request,mode:'recover',recoveryPhase:'RESTORED'},true)).killed,true);
  await fs.appendFile(i.plan.projects[0].state_path,' ');
  const bytes=await fs.readFile(i.plan.projects[0].state_path),r=publicRecover(i);assert.equal(r.code,4,r.out);assert.equal(await exists(`${i.plan.control_path}/writer.lock`),true);assert.deepEqual(await fs.readFile(i.plan.projects[0].state_path),bytes);
});
test('P1 R5 forged terminal recovery interrupted again resumes without losing manager',async t=>{
  const i=await requestFor(t),before=await inventory(i.plan.active_path);
  assert.equal((await run(i,{...i.request,stopPoint:'action:after-completion',stopKind:'move',stopIndex:1},true)).killed,true);
  const j=await setPhase(i,'RESTORED');
  assert.equal((await run(i,{...i.request,mode:'recover',recoveryStop:'action:after-action'},true)).killed,true);
  const r=publicRecover(i);assert.equal(r.code,3,r.out);assert.deepEqual(await inventory(i.plan.active_path),before);assert.equal(await exists(`${i.plan.control_path}/manager/${canonicalSha256(j.manager_release)}/chatgpt-conductor/scripts/distribution/recovery.mjs`),true);assert.equal(await exists(`${i.plan.control_path}/writer.lock`),false);
});
