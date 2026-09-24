import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareLegacyMigration } from '../scripts/distribution/migration-adapter.mjs';
import { canonicalPath, inventory, createScopedStore, hash, exists } from '../scripts/distribution/store.mjs';
import { resultDigest } from '../scripts/contracts.mjs';
import { transition } from '../scripts/router.mjs';
import { setup, nextPlan, operation, runChild, legacyMigrations } from './helpers/distribution-m5-fixture.mjs';
import { planLegacyMigration, stageDataChange } from '../scripts/distribution/data-change.mjs';
import { readProject } from '../scripts/distribution/snapshot.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const load=async name=>JSON.parse(await fs.readFile(new URL(`../examples/${name}.json`,import.meta.url),'utf8'));
export async function legacyProject(t,phase='PLAN',schema=1) {
  const root=await canonicalPath(await fs.mkdtemp(path.join(os.tmpdir(),'conductor-legacy-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const snapshot=await load('project-state'),packet=await load('execution-packet'),result=await load('result-packet');
  snapshot.schema_version=packet.schema_version=result.schema_version=schema;snapshot.state=phase;
  for(const k of ['lifecycle','revision_reviews','plan_approvals','migration_record','review_record','result_sha256'])delete snapshot[k];
  delete packet.lifecycle;delete result.lifecycle;delete packet.authorization.source_kind;
  for(const k of ['revision_instructions','known_capabilities','capability_preflight_required','side_effects'])delete packet[k];
  packet.inputs=[];
  const active=!['DISCUSS','PLAN'].includes(phase);
  snapshot.active_packet=active?{packet_id:packet.packet_id,packet_revision:packet.packet_revision,task_id:packet.task_id,content_sha256:resultDigest(packet)}:null;
  const review=['REVISE','COMPLETE'].includes(phase)?{packet_id:packet.packet_id,packet_revision:packet.packet_revision,decision:'accepted',reviewer:'CHAT',evidence:'history',revision_instructions:phase==='REVISE'?['preserve obligation']:[]}:null;
  const confirmation={source_kind:'user_instruction',approval_ref:'separate migration permission',executor_stopped:true,effects_reconciled:true,evidence_ref:'history',pending_revision_instructions:phase==='REVISE'?['preserve obligation']:[]};
  for(const [name,value]of Object.entries({state:snapshot,packet:active?packet:null,result:active?result:null,review,confirmation}))await fs.writeFile(`${root}/${name}.json`,JSON.stringify(value));
  await fs.writeFile(`${root}/proof.txt`,'reconciled historical actions');
  await fs.writeFile(`${root}/summary.md`,'historical delivered artifact');
  const refs=new Set(['history']);
  function collect(value){if(!value||typeof value!=='object')return;for(const[k,v]of Object.entries(value)){if(['ref','evidence','evidence_ref'].includes(k)&&typeof v==='string'&&v.length)refs.add(v);else if(typeof v==='object')collect(v);}}
  if(active){collect(packet);collect(result);collect(review);}collect(confirmation);
  const evidence=[...refs].map(ref=>({ref,root_path:root,path:`${root}/${ref==='summary.md'?'summary.md':'proof.txt'}`,resolution:ref==='summary.md'?'relative':'bound'}));
  const project={project_id:snapshot.project_id,root_path:root,state_path:`${root}/state.json`,directories:[root],files:await inventory(root),schema_version:schema,profile:`po-legacy-schema${schema}`,bindings:{packet_path:active?`${root}/packet.json`:null,result_path:active?`${root}/result.json`:null,reference_roots:[],evidence}};
  const request={project_id:project.project_id,destination:`${root}/migrated.json`,packet_path:project.bindings.packet_path,result_path:project.bindings.result_path,review_path:review?`${root}/review.json`:null,confirmation_path:`${root}/confirmation.json`};
  return {root,project,request,snapshot};
}
for(const schema of [1,2])for(const phase of ['DISCUSS','PLAN','READY_TO_EXECUTE','EXECUTE','REVIEW','REVISE','COMPLETE'])test(`bound filesystem legacy ${schema} ${phase} preserves bytes and obligations`,async t=>{
  const i=await legacyProject(t,phase,schema),before=await inventory(i.root);
  const result=await prepareLegacyMigration({projects:[i.project],requests:[i.request]});
  assert.deepEqual(await inventory(i.root),before);
  const state=JSON.parse(result.outputs[0].bytes);
  assert.equal(state.state,phase==='DISCUSS'?'DISCUSS':'PLAN');assert.equal(state.lifecycle,2);
  assert.equal(state.migration_record.authorization_inherited,false);assert.equal(state.migration_record.source_sha256,resultDigest(i.snapshot));
  assert.deepEqual(state.migration_record.pending_revision_instructions,phase==='REVISE'?['preserve obligation']:[]);
  assert.equal(result.projects[0].state_path,i.request.destination);
  assert.equal(result.projects[0].bindings.historical_source_path,i.project.state_path);
  assert.throws(()=>transition({snapshot:state,event:'start',work_type:'general'}));
});
test('historical artifact absent from inventory blocks migration planning',async t=>{
  const i=await legacyProject(t,'COMPLETE');await fs.unlink(`${i.root}/summary.md`);
  i.project.bindings.evidence=i.project.bindings.evidence.filter(e=>e.ref!=='summary.md');i.project.files=await inventory(i.root);
  const before=await inventory(i.root);
  await assert.rejects(planLegacyMigration({projects:[i.project],requests:[i.request],stagePath:`${i.root}-stage`}),/evidence|reference/i);
  assert.deepEqual(await inventory(i.root),before);
});
test('historical artifact and bound prose validate on copies, while changed references reject planning and staging',async t=>{
  const i=await legacyProject(t,'COMPLETE'),stagePath=`${i.root}-stage`;t.after(()=>fs.rm(stagePath,{recursive:true,force:true}));
  const before=await inventory(i.root),d=await planLegacyMigration({projects:[i.project],requests:[i.request],stagePath});
  const store=await createScopedStore({roots:[i.root,stagePath]});
  const staged=await stageDataChange({store,plan:{operation:'migrate',projects:[i.project],data_change:d}});
  assert.equal(staged.projects.length,1);assert.deepEqual(await inventory(i.root),before);
  const unbound=structuredClone(staged.projects[0]);unbound.bindings.evidence=unbound.bindings.evidence.filter(e=>e.ref!=='summary.md');
  await assert.rejects(readProject(unbound),/evidence/i,'migrated historical result references remain mandatory');
  const prose=i.project.bindings.evidence.find(e=>e.ref.includes('示例核对记录'));assert.equal(prose.resolution,'bound');assert.equal(prose.path,`${i.root}/proof.txt`);
  const result=JSON.parse(await fs.readFile(i.request.result_path));result.artifacts[0].ref='changed-missing.txt';await fs.writeFile(i.request.result_path,JSON.stringify(result));
  const stalePlan={operation:'migrate',projects:[structuredClone(i.project)],data_change:{...d,stage_path:`${stagePath}-changed`}};
  const changedStore=await createScopedStore({roots:[i.root,stalePlan.data_change.stage_path]});
  await assert.rejects(stageDataChange({store:changedStore,plan:stalePlan}),/inventory|input/i);
  i.project.files=await inventory(i.root);
  await assert.rejects(planLegacyMigration({projects:[i.project],requests:[i.request],stagePath:`${stagePath}-changed`}),/evidence|reference/i);
});
test('legacy adapter refuses existing lifecycle, unknown schema, changed evidence and unconfirmed effects',async t=>{
  for(const edit of ['lifecycle','future','effects','packet']){
    const i=await legacyProject(t,'EXECUTE');
    const file=edit==='effects'?i.request.confirmation_path:edit==='packet'?i.request.packet_path:i.project.state_path;
    const value=JSON.parse(await fs.readFile(file));
    if(edit==='lifecycle')value.lifecycle=1;if(edit==='future')value.schema_version=99;if(edit==='effects')value.effects_reconciled=false;if(edit==='packet')value.goal='tampered';
    await fs.writeFile(file,JSON.stringify(value));i.project.files=await inventory(i.root);
    await assert.rejects(prepareLegacyMigration({projects:[i.project],requests:[i.request]}));
  }
});

test('approved migration commits new state, registers after inventory, preserves all legacy bytes and refuses replay',async t=>{
  const i=await setup(t,{migrations:legacyMigrations});await i.runnerInstall(i);const legacy=await legacyProject(t,'COMPLETE');
  const registrationPath=`${i.plan.control_path}/installation.json`,record=JSON.parse(await fs.readFile(registrationPath));
  record.projects=[legacy.project];await fs.writeFile(registrationPath,JSON.stringify(record));
  i.plan.projects=[legacy.project];i.plan.software_only=false;
  const before=await inventory(legacy.root),plan=await nextPlan(i,i.bundle,{operation:'migrate',id:'legacy-migration',migration_ids:['po-legacy-schema1-v1']});
  plan.data_change=await planLegacyMigration({projects:plan.projects,requests:[legacy.request],stagePath:`${i.root}/data-stage/migrate`});
  await assert.rejects(operation(i,'migrate',{...plan,migration_ids:['undeclared-handler']},{bundle:i.bundle,source:i.source}),{code:'MIGRATION_ROUTE'});
  const receipt=await operation(i,'migrate',plan,{bundle:i.bundle,source:i.source});
  assert.deepEqual(receipt.installation.projects,plan.data_change.after_projects);
  assert.equal((await readProject(receipt.installation.projects[0])).lifecycle,2);
  const after=await inventory(legacy.root);for(const f of before)assert.deepEqual(after.find(x=>x.path===f.path),f);
  assert.equal(after.length,before.length+1);
  await assert.rejects(operation(i,'migrate',plan,{bundle:i.bundle,source:i.source}));
  const {recover}=await import(pathToFileURL(`${i.managerRoot}/scripts/distribution/recovery.mjs`));
  assert.equal((await recover({control:plan.control_path,transactionId:plan.plan_id})).status,'SUCCEEDED');
  assert.deepEqual(await inventory(legacy.root),after);
});
test('committed legacy migration crash completes only receipt with exact after-project registration',async t=>{
  const i=await setup(t,{migrations:legacyMigrations});await i.runnerInstall(i);const legacy=await legacyProject(t,'REVISE',2);
  const file=`${i.plan.control_path}/installation.json`,registration=JSON.parse(await fs.readFile(file));registration.projects=[legacy.project];await fs.writeFile(file,JSON.stringify(registration));
  i.plan.projects=[legacy.project];i.plan.software_only=false;
  const plan=await nextPlan(i,i.bundle,{operation:'migrate',id:'migration-crash',migration_ids:['po-legacy-schema2-v1']});
  plan.data_change=await planLegacyMigration({projects:plan.projects,requests:[legacy.request],stagePath:`${i.root}/data-stage/migration-crash`});
  const stopped=await runChild(i,plan,{stopPoint:'journal:after:COMMITTED'},true);assert.equal(stopped.killed,true,stopped.out+stopped.err);
  const after=await inventory(legacy.root),result=await runChild(i,plan,{recover:true});assert.equal(result.code,0,result.out+result.err);assert.equal(JSON.parse(result.out).status,'SUCCEEDED');
  assert.deepEqual(await inventory(legacy.root),after);assert.deepEqual(JSON.parse(await fs.readFile(file)).projects,plan.data_change.after_projects);
  const again=await runChild(i,plan,{recover:true});assert.equal(again.code,0,again.out);assert.deepEqual(await inventory(legacy.root),after);
});

test('P1 migration SUCCEEDED with complete code but missing migrated data preserves lock and evidence',async t=>{
  const i=await setup(t,{migrations:legacyMigrations});await i.runnerInstall(i);const legacy=await legacyProject(t,'REVISE',2);
  const file=`${i.plan.control_path}/installation.json`,registration=JSON.parse(await fs.readFile(file));registration.projects=[legacy.project];await fs.writeFile(file,JSON.stringify(registration));
  i.plan.projects=[legacy.project];i.plan.software_only=false;
  const plan=await nextPlan(i,i.bundle,{operation:'migrate',id:'terminal-migration',migration_ids:['po-legacy-schema2-v1']});
  plan.data_change=await planLegacyMigration({projects:plan.projects,requests:[legacy.request],stagePath:`${i.root}/data-stage/terminal-migration`});
  assert.equal((await runChild(i,plan,{stopPoint:'journal:after:SUCCEEDED'},true)).killed,true);
  await fs.rename(legacy.request.destination,`${i.root}/retained-migration.json`);
  const code=await inventory(plan.active_path),data=await inventory(legacy.root),registry=await fs.readFile(file);
  const r=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/distribution-cli.mjs',import.meta.url)),'recover','--control',plan.control_path,'--transaction',plan.plan_id],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,4,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).status,'recovery_required');assert.equal(await exists(`${plan.control_path}/writer.lock`),true);
  assert.deepEqual(await inventory(plan.active_path),code);assert.deepEqual(await inventory(legacy.root),data);assert.deepEqual(await fs.readFile(file),registry);assert.equal(await exists(`${plan.control_path}/transactions/${hash(plan.plan_id)}.json`),true);
});
