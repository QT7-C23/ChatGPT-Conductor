import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildCandidate,finalizeManifest} from '../scripts/package-release.mjs';
import {validateBuild,validateApproval,validateConfiguration,validateRepositoryProtection,validateMatrix,validatePublication,validateFinalFiles,sha256,githubClient,POLICY,ENVIRONMENTS} from '../scripts/release-workflow.mjs';

const sha='a'.repeat(40), digest='b'.repeat(64);
const identity={repository:'QT7-C23/ChatGPT-Conductor',workflow:'.github/workflows/package-candidate.yml',workflow_ref:'refs/heads/main',workflow_sha:'c'.repeat(40),run_id:'42',run_attempt:1,source_commit:sha};
const assets={'chatgpt-conductor-1.2.0.zip':digest,'CHANGELOG.md':'d'.repeat(64)};
const build=()=>({schema:1,kind:'candidate',...identity,version:'1.2.0',channel:'stable',assets,metadata:{'candidate.json':'1'.repeat(64),'payload-inventory.json':'2'.repeat(64)}});
const approval=purpose=>({schema:1,purpose,decision:purpose==='candidate'?'APPROVE_CANDIDATE':'ACCEPT_AND_PUBLISH',binding:build(),draft_id:purpose==='candidate'?null:'7',final_assets:purpose==='candidate'?null:{...assets,'release-manifest.json':'e'.repeat(64),SHA256SUMS:'f'.repeat(64)},accept_ref:purpose==='candidate'?null:'chat/ACCEPT/123',publish_ref:purpose==='candidate'?null:'chat/PUBLISH/456'});
test('candidate evidence binds workflow origin separately from reviewed checkout and all bytes',()=>{
  assert.deepEqual(validateBuild(build(),identity,assets),build());
  for(const key of Object.keys(identity))assert.throws(()=>validateBuild({...build(),[key]:key==='run_attempt'?2:'evil'},identity,assets));
  assert.throws(()=>validateBuild({...build(),release_id:'7'},identity,assets));
  assert.throws(()=>validateBuild(build(),identity,{...assets,'CHANGELOG.md':digest}));
  assert.throws(()=>validateBuild({...build(),source_commit:'$(touch pwn)'},identity,assets));
  assert.throws(()=>validateBuild(build(),identity,assets,{'candidate.json':'9'.repeat(64),'payload-inventory.json':'2'.repeat(64)}));
});
test('human approval is exact purpose, decision, candidate and final asset binding',()=>{
  assert.deepEqual(validateApproval(approval('candidate'),'candidate',build()),approval('candidate'));
  const final=approval('publish');
  validateApproval(final,'publish',build(),'7',final.final_assets);
  for(const change of [{decision:'APPROVE'},{draft_id:'8'},{final_assets:assets},{binding:{...build(),source_commit:'e'.repeat(40)}},{purpose:'candidate'},{accept_ref:null},{publish_ref:null},{publish_ref:final.accept_ref}])assert.throws(()=>validateApproval({...final,...change},'publish',build(),'7',final.final_assets));
  const altered={...final.final_assets,'CHANGELOG.md':'9'.repeat(64)};
  assert.throws(()=>validateApproval({...final,final_assets:altered},'publish',build(),'7',altered));
  assert.throws(()=>validateApproval({...approval('candidate'),binding:{...build(),run_attempt:2}},'candidate',build()));
});

test('API adapter fails closed and uses fixed-host binary reads and complete pagination',async()=>{
  const calls=[];
  const client=githubClient('local-fixture-token',async(url,options)=>{
    calls.push({url,options});
    if(url.includes('assets/7'))return new Response(Buffer.from('exact bytes'));
    if(new URL(url).searchParams.get('page')==='1')return Response.json({total_count:101,jobs:Array.from({length:100},(_,id)=>({id}))});
    return Response.json({total_count:101,jobs:[{id:100}]});
  });
  assert.equal((await client.list('actions/runs/42/jobs','jobs')).length,101);
  assert.equal((await client.request('releases/assets/7',{binary:true})).toString(),'exact bytes');
  assert.equal(calls[2].options.headers.Accept,'application/octet-stream');
  assert.ok(calls.every(c=>c.url.startsWith('https://api.github.com/repos/QT7-C23/ChatGPT-Conductor/')));
  await assert.rejects(githubClient('x',async()=>new Response('',{status:403})).request('immutable-releases'));
  await assert.rejects(githubClient('x',async()=>Response.json({total_count:3,jobs:[]})).list('actions/runs/42/jobs','jobs'));
});

const read=async p=>fs.readFile(new URL('../'+p,import.meta.url),'utf8');
const workflow=async n=>JSON.parse(await read(`.github/workflows/${n}.yml`));
test('actual workflow structures isolate candidate execution from write permissions and bind default workflow code',async()=>{
  const pins=new Set(['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1','actions/setup-node@820762786026740c76f36085b0efc47a31fe5020','actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a']);
  for(const name of ['verify','package-candidate','approve-release','prepare-release','publish-release','verify-published']){
    const w=await workflow(name);
    assert.equal(w.permissions.contents,'read');assert.equal(w.on.pull_request_target,undefined);
    if(name!=='verify')assert.deepEqual(Object.keys(w.on),['workflow_dispatch']);
    for(const job of Object.values(w.jobs)){
      if(name!=='verify')assert.ok(job.if.includes('github.event.repository.default_branch'));
      for(const step of job.steps){
        if(step.uses)assert.ok(pins.has(step.uses),step.uses);
        if(step.run)assert.ok(!step.run.includes('${{'),'inputs must be environment data, never shell interpolation');
        if(step.uses?.startsWith('actions/checkout@'))assert.equal(step.with['persist-credentials'],false);
        if(step.uses?.startsWith('actions/upload-artifact@')){assert.equal(step.with.archive,true);assert.equal(step.with.overwrite,false);assert.equal(step.with['if-no-files-found'],'error');assert.ok(!step.with.path.includes('*'));}
      }
      if(job.permissions?.contents==='write'){
        assert.ok(['release-prepare','release-publish'].includes(job.environment));
        assert.equal(job.needs,'check');
        const checkouts=job.steps.filter(s=>s.uses?.startsWith('actions/checkout@'));
        assert.equal(checkouts.length,1);assert.equal(checkouts[0].with.ref,'${{ github.sha }}');assert.equal(checkouts[0].with.path,'trusted');
        assert.equal(job.steps.filter(s=>s.run?.startsWith('node ')).length,1);
      }
    }
  }
  const verify=await workflow('verify');assert.deepEqual(verify.on,['push','pull_request']);
  assert.deepEqual(verify.jobs.verify.strategy.matrix,{os:['ubuntu-latest','windows-latest'],node:[22,24]});
  assert.deepEqual(verify.jobs.verify.steps.slice(-2).map(s=>s.run),['npm ci --ignore-scripts','node scripts/verify.mjs']);
  const publish=await workflow('publish-release');assert.equal(publish.jobs.verify.needs,'publish');assert.equal(publish.jobs.verify.permissions.contents,'read');
  assert.equal(POLICY.license,'MIT');assert.equal(POLICY.public_evidence_approval,null);
  assert.notEqual(ENVIRONMENTS.prepare,ENVIRONMENTS.publish);
});
test('all allowlisted product paths preserve committed bytes including immutable legacy fixture',async()=>{
  const list=JSON.parse(await read('scripts/distribution/product-files.json'));
  const rules=(await read('.gitattributes')).split(/\r?\n/).filter(s=>s&&!s.startsWith('#'));
  assert.deepEqual(rules,list.map(p=>'/'+p+' -text'));
  assert.ok(list.includes('tests/distribution-workflows.test.mjs'));
  assert.ok((await read('scripts/verify.mjs')).includes("'tests/distribution-workflows.test.mjs'"));
});
test('actual finalized files bind exact draft and candidate; altered sums or source refuse',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'conductor-workflow-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const candidate=await buildCandidate({out:path.join(root,'candidate'),sourceCommit:sha});
  const out=path.join(root,'final');
  await finalizeManifest({candidate,release:{release_id:'7',source_commit:sha,channel:'stable'},out});
  const hashes={};for(const n of ['CHANGELOG.md','release-manifest.json','SHA256SUMS'])hashes[n]=sha256(await fs.readFile(path.join(out,n)));
  hashes[candidate.payload.name]=candidate.payload.sha256;
  await validateFinalFiles(out,candidate,build(),'7',hashes);
  await assert.rejects(validateFinalFiles(out,candidate,build(),'8',hashes));
  await assert.rejects(validateFinalFiles(out,candidate,{...build(),source_commit:'9'.repeat(40)},'7',hashes));
  await fs.appendFile(path.join(out,'SHA256SUMS'),'extra\n');
  await assert.rejects(validateFinalFiles(out,candidate,build(),'7',hashes));
});
test('actual helper process rejects shell-like inputs and missing trusted context without echoing private data',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const marker='PRIVATE_DO_NOT_EXECUTE';
  const result=spawnSync(process.execPath,['scripts/release-workflow.mjs',`publish; ${marker}`],{cwd:root,encoding:'utf8',shell:false,env:{...process.env,GITHUB_REPOSITORY:'wrong/repository',CANDIDATE_COMMIT:`$(echo ${marker})`}});
  assert.equal(result.status,1);assert.doesNotMatch(result.stdout+result.stderr,new RegExp(marker));assert.match(result.stderr,/workflow blocked/);
});
test('configuration requires observed immutability, reviewer protection, exact branch and license approval',()=>{
  const config={license:'MIT',public_evidence_approval:'approved-123',reviewers:['alice'],default_branch:'main'};
  const env={protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{reviewer:{login:'alice'}}]}],deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}};
  const policies=[{name:'main',type:'branch'}];
  validateConfiguration(config,{enabled:true},env,policies);
  const singleOwner={...env,protection_rules:[{...env.protection_rules[0],prevent_self_review:false}]};
  assert.deepEqual(validateConfiguration(config,{enabled:true},singleOwner,policies),{prevent_self_review:false,reviewers:['alice']});
  for(const c of [{...config,license:null},{...config,public_evidence_approval:null},{...config,reviewers:[]}])assert.throws(()=>validateConfiguration(c,{enabled:true},env,policies));
  assert.throws(()=>validateConfiguration(config,{enabled:false},env,policies));
  assert.throws(()=>validateConfiguration(config,{enabled:true},{...env,protection_rules:[]},policies));
  assert.throws(()=>validateConfiguration(config,{enabled:true},env,[{name:'*',type:'branch'}]));
});
test('repository protection proves required matrix, PR review and separate exact tag creation and no-mutation rules',()=>{
  const contexts=['ubuntu-latest','windows-latest'].flatMap(os=>[22,24].map(n=>`verify (${os}, ${n})`));
  const branch={enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:1},required_status_checks:{strict:true,contexts},allow_force_pushes:{enabled:false},allow_deletions:{enabled:false}};
  const tag={target:'tag',enforcement:'active',conditions:{ref_name:{include:['refs/tags/v1.2.0'],exclude:[]}}};
  const creation={...tag,rules:[{type:'creation'}],bypass_actors:[{actor_id:123,actor_type:'Integration',bypass_mode:'always'}]};
  const protection={...tag,rules:[{type:'update'},{type:'deletion'}],bypass_actors:[]};
  validateRepositoryProtection(branch,creation,protection,123);
  for(const b of [{...branch,required_status_checks:{contexts:[]}},{...branch,enforce_admins:{enabled:false}}])assert.throws(()=>validateRepositoryProtection(b,creation,protection,123));
  assert.throws(()=>validateRepositoryProtection(branch,{...creation,enforcement:'evaluate'},protection,123));
  assert.throws(()=>validateRepositoryProtection(branch,creation,{...protection,bypass_actors:creation.bypass_actors},123));
  assert.throws(()=>validateRepositoryProtection(branch,creation,protection,456));
});
test('matrix requires exact SHA latest attempt and all four completed successful jobs',()=>{
  const run={head_sha:sha,path:'.github/workflows/verify.yml',event:'push',status:'completed',conclusion:'success',run_attempt:2};
  const jobs=['ubuntu-latest','windows-latest'].flatMap(os=>[22,24].map(n=>({name:`verify (${os}, ${n})`,status:'completed',conclusion:'success',run_attempt:2,head_sha:sha})));
  validateMatrix(run,jobs,sha);
  for(const patch of [{head_sha:'e'.repeat(40)},{conclusion:'failure'},{status:'in_progress'},{event:'pull_request_target'}])assert.throws(()=>validateMatrix({...run,...patch},jobs,sha));
  assert.throws(()=>validateMatrix(run,jobs.slice(1),sha));
  assert.throws(()=>validateMatrix(run,jobs.map(j=>({...j,run_attempt:1})),sha));
  assert.throws(()=>validateMatrix(run,jobs.map(j=>({...j,conclusion:'skipped'})),sha));
});
test('publication requires immutable exact tag target and full asset set',()=>{
  const r={id:7,draft:false,immutable:true,tag_name:'v1.2.0',prerelease:false,assets:Object.entries(assets).map(([name,h],i)=>({id:i+1,name,digest:`sha256:${h}`}))};
  validatePublication(r,'7',sha,sha,assets);
  for(const patch of [{immutable:false},{draft:true},{tag_name:'v1.2.1'},{assets:[]}])assert.throws(()=>validatePublication({...r,...patch},'7',sha,sha,assets));
  assert.throws(()=>validatePublication(r,'7',sha,'e'.repeat(40),assets));
  assert.equal(sha256(Buffer.from('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
