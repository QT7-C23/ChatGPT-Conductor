import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildCandidate,finalizeManifest} from '../scripts/package-release.mjs';
import {validateBuild,validateApproval,validateConfiguration,validatePublisher,configurationPreflight,validateRepositoryProtection,validateMatrix,validatePublication,validateFinalFiles,releasePreflight,postPublishVerification,releaseFailureEvidence,sha256,githubClient,POLICY,ENVIRONMENTS} from '../scripts/release-workflow.mjs';

const sha='a'.repeat(40), digest='b'.repeat(64);
const identity={repository:'QT7-C23/ChatGPT-Conductor',workflow:'.github/workflows/package-candidate.yml',workflow_ref:'refs/heads/main',workflow_sha:'c'.repeat(40),run_id:'42',run_attempt:1,source_commit:sha};
const assets={'chatgpt-conductor-1.3.0.zip':digest,'CHANGELOG.md':'d'.repeat(64)};
const build=()=>({schema:1,kind:'candidate',...identity,version:'1.3.0',channel:'stable',assets,metadata:{'candidate.json':'1'.repeat(64),'payload-inventory.json':'2'.repeat(64)}});
const approval=purpose=>({schema:1,purpose,decision:purpose==='candidate'?'APPROVE_CANDIDATE':'ACCEPT_AND_PUBLISH',binding:build(),draft_id:purpose==='candidate'?null:'7',final_assets:purpose==='candidate'?null:{...assets,'release-manifest.json':'e'.repeat(64),SHA256SUMS:'f'.repeat(64)},accept_ref:purpose==='candidate'?null:'chat/ACCEPT/123',publish_ref:purpose==='candidate'?null:'chat/PUBLISH/456'});
test('candidate evidence binds workflow origin separately from reviewed checkout and all bytes',()=>{
  assert.deepEqual(validateBuild(build(),identity,assets),build());
  for(const key of Object.keys(identity))assert.throws(()=>validateBuild({...build(),[key]:key==='run_attempt'?2:'evil'},identity,assets));
  assert.throws(()=>validateBuild({...build(),release_id:'7'},identity,assets));
  for(const version of ['1.2.0','1.3.1'])assert.throws(()=>validateBuild({...build(),version},identity,assets));
  assert.throws(()=>validateBuild(build(),identity,{...assets,'CHANGELOG.md':digest}));
  assert.throws(()=>validateBuild({...build(),source_commit:'$(touch pwn)'},identity,assets));
  assert.throws(()=>validateBuild(build(),identity,assets,{'candidate.json':'9'.repeat(64),'payload-inventory.json':'2'.repeat(64)}));
});
test('human approval is exact purpose, decision, candidate and final asset binding',()=>{
  assert.deepEqual(validateApproval(approval('candidate'),'candidate',build()),approval('candidate'));
  assert.throws(()=>validateApproval(null,'candidate',build()));
  assert.throws(()=>validateApproval({...approval('candidate'),task_authorization:true},'candidate',build()));
  const final=approval('publish');
  validateApproval(final,'publish',build(),'7',final.final_assets);
  assert.throws(()=>validateApproval(null,'publish',build(),'7',final.final_assets));
  for(const change of [{decision:'APPROVE'},{draft_id:'8'},{final_assets:assets},{binding:{...build(),source_commit:'e'.repeat(40)}},{purpose:'candidate'},{accept_ref:null},{publish_ref:null},{publish_ref:final.accept_ref}])assert.throws(()=>validateApproval({...final,...change},'publish',build(),'7',final.final_assets));
  const altered={...final.final_assets,'CHANGELOG.md':'9'.repeat(64)};
  assert.throws(()=>validateApproval({...final,final_assets:altered},'publish',build(),'7',altered));
  assert.throws(()=>validateApproval({...approval('candidate'),binding:{...build(),run_attempt:2}},'candidate',build()));
});

test('API adapter reads the canonical repository root without a trailing slash',async()=>{
  const root='https://api.github.com/repos/QT7-C23/ChatGPT-Conductor';
  const calls=[];
  const client=githubClient('fixture-only',async url=>{
    calls.push(url);
    return url===root?Response.json({id:1382745738,default_branch:'main'}):new Response('',{status:404});
  });
  assert.deepEqual(await client.request(''),{id:1382745738,default_branch:'main'});
  assert.deepEqual(calls,[root]);
});

test('artifact archive downloads use the Actions REST media type while preserving binary bytes',async()=>{
  const archive=Buffer.from([0x50,0x4b,0x03,0x04,0xff,0x00]);
  const client=githubClient('fixture-only',async(url,options)=>{
    assert.equal(url,'https://api.github.com/repos/QT7-C23/ChatGPT-Conductor/actions/artifacts/7/zip');
    if(options.headers.Accept!=='application/vnd.github+json')return new Response('',{status:415});
    return new Response(archive);
  });
  assert.deepEqual(await client.request('actions/artifacts/7/zip',{binary:true}),archive);
});

test('remote evidence failures report a fixed operation and HTTP status without private details',async()=>{
  const client=githubClient('fixture-only',async()=>new Response('private response marker',{status:415}));
  await assert.rejects(client.request('actions/artifacts/7/zip',{binary:true}),error=>{
    assert.deepEqual(releaseFailureEvidence(error),{stage:'workflow',status:'BLOCKED',evidence:{operation:'artifact_download',http_status:415}});
    assert.ok(!JSON.stringify(error).includes('private response marker'));
    return true;
  });
  const transport=githubClient('fixture-only',async()=>{throw Error('private transport marker');});
  await assert.rejects(transport.request('actions/artifacts/7/zip',{binary:true}),error=>{
    assert.deepEqual(releaseFailureEvidence(error),{stage:'workflow',status:'BLOCKED',evidence:{operation:'artifact_download',http_status:null}});
    assert.ok(!error.message.includes('private transport marker'));
    return true;
  });
  assert.deepEqual(releaseFailureEvidence({operation:'private operation',status:'403',message:'private marker'}),{stage:'workflow',status:'BLOCKED',evidence:{operation:null,http_status:null}});
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
  const pins=new Set(['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1','actions/setup-node@820762786026740c76f36085b0efc47a31fe5020','actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a','actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1']);
  for(const name of ['verify','package-candidate','approve-release','prepare-release','publish-release','verify-published','preflight-release']){
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
      assert.notEqual(job.permissions?.contents,'write','built-in GitHub Actions identity never writes release refs');
      const publisher=job.steps.find(s=>s.id==='publisher');
      if(publisher){
        assert.equal(publisher.with['client-id'],'Iv23liKIJaTalWOI0IwZ');
        assert.equal(publisher.with.owner,'QT7-C23');assert.equal(publisher.with.repositories,'ChatGPT-Conductor');
        assert.equal(publisher.with['permission-actions'],'read');assert.equal(publisher.with['permission-administration'],'read');
        assert.equal(publisher.with['skip-token-revoke'],undefined);
        const gate=job.steps.find(s=>s.run?.startsWith('node scripts/release-workflow.mjs'));
        assert.equal(gate.env.GH_TOKEN,'${{ steps.publisher.outputs.token }}');
        assert.equal(gate.env.PUBLISHER_INSTALLATION_ID,'${{ steps.publisher.outputs.installation-id }}');
        assert.equal(gate.env.PUBLISHER_SLUG,'${{ steps.publisher.outputs.app-slug }}');
      }else assert.ok(['verify','package-candidate'].includes(name));
      if(publisher?.with['permission-contents']==='write'){
        assert.equal(job.environment,undefined,'write jobs consume the protected approval receipt without a second environment prompt');
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
  assert.equal(POLICY.license,'MIT');assert.equal(POLICY.public_evidence_approval,'owner-public-scope/v1.3.0/2026-09-28');
  assert.deepEqual(POLICY.reviewers,['QT7-C23']);assert.equal(POLICY.publisher_integration_id,5109993);
  validatePublisher('165834076','qt7-c23-conductor-publisher');
  assert.throws(()=>validatePublisher('1','qt7-c23-conductor-publisher'));
  assert.throws(()=>validatePublisher('165834076','github-actions'));
  assert.deepEqual(ENVIRONMENTS,{approval:'release-approval'});
  const approvals=await workflow('approve-release');
  assert.deepEqual(Object.values(approvals.jobs).map(job=>job.environment),['release-approval','release-approval']);
  for(const name of ['prepare-release','publish-release','verify-published'])for(const job of Object.values((await workflow(name)).jobs))assert.equal(job.environment,undefined);
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
test('single-owner configuration requires one allowlisted reviewer, owner self-review and exact branch',()=>{
  const config={license:'MIT',public_evidence_approval:'approved-123',reviewers:['alice'],default_branch:'main'};
  const env={can_admins_bypass:false,protection_rules:[{type:'required_reviewers',prevent_self_review:true,reviewers:[{reviewer:{login:'alice'}}]}],deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}};
  const policies=[{name:'main',type:'branch'}];
  const singleOwner={...env,protection_rules:[{...env.protection_rules[0],prevent_self_review:false}]};
  assert.deepEqual(validateConfiguration(config,{enabled:true},singleOwner,policies),{prevent_self_review:false,required_reviewers:1});
  for(const c of [{...config,license:null},{...config,public_evidence_approval:null},{...config,reviewers:[]},{...config,reviewers:['alice','bob']}])assert.throws(()=>validateConfiguration(c,{enabled:true},singleOwner,policies));
  assert.throws(()=>validateConfiguration(config,{enabled:false},env,policies));
  assert.throws(()=>validateConfiguration(config,{enabled:true},{...env,protection_rules:[]},policies));
  assert.throws(()=>validateConfiguration(config,{enabled:true},env,[{name:'*',type:'branch'}]));
  assert.throws(()=>validateConfiguration(config,{enabled:true},{...singleOwner,protection_rules:[{...singleOwner.protection_rules[0],reviewers:[{reviewer:{login:'alice'}},{reviewer:{login:'bob'}}]}]},policies));
  assert.throws(()=>validateConfiguration(config,{enabled:true},{...singleOwner,can_admins_bypass:true},policies));
});
test('repository protection proves required matrix, no-force/delete and exact tag rules without requiring another PR reviewer',()=>{
  const contexts=['ubuntu-latest','windows-latest'].flatMap(os=>[22,24].map(n=>`verify (${os}, ${n})`));
  const branch={target:'branch',enforcement:'active',conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},bypass_actors:[],rules:[{type:'deletion'},{type:'non_fast_forward'},{type:'pull_request',parameters:{required_approving_review_count:0,require_code_owner_review:false,require_last_push_approval:false}},{type:'required_status_checks',parameters:{strict_required_status_checks_policy:false,do_not_enforce_on_create:false,required_status_checks:contexts.map(context=>({context,integration_id:15368}))}}]};
  const tag={target:'tag',enforcement:'active',conditions:{ref_name:{include:['refs/tags/v1.3.0'],exclude:[]}}};
  const creation={...tag,rules:[{type:'creation'}],bypass_actors:[{actor_id:123,actor_type:'Integration',bypass_mode:'always'}]};
  const protection={...tag,rules:[{type:'update'},{type:'deletion'}],bypass_actors:[]};
  validateRepositoryProtection(branch,creation,protection,123);
  for(const b of [{...branch,enforcement:'evaluate'},{...branch,bypass_actors:creation.bypass_actors},{...branch,conditions:{ref_name:{include:['~ALL'],exclude:[]}}},{...branch,rules:branch.rules.slice(1)}])assert.throws(()=>validateRepositoryProtection(b,creation,protection,123));
  const altered=(type,parameters)=>({...branch,rules:branch.rules.map(r=>r.type===type?{...r,parameters:{...r.parameters,...parameters}}:r)});
  for(const patch of [{required_status_checks:[]},{do_not_enforce_on_create:true},{required_status_checks:contexts.map(context=>({context,integration_id:123}))}])assert.throws(()=>validateRepositoryProtection(altered('required_status_checks',patch),creation,protection,123));
  for(const patch of [{required_approving_review_count:1},{require_last_push_approval:true},{require_code_owner_review:true}])assert.throws(()=>validateRepositoryProtection(altered('pull_request',patch),creation,protection,123));
  assert.throws(()=>validateRepositoryProtection({...branch,bypass_actors:undefined},creation,protection,123));
  assert.throws(()=>validateRepositoryProtection(branch,{...creation,enforcement:'evaluate'},protection,123));
  assert.throws(()=>validateRepositoryProtection(branch,creation,{...protection,bypass_actors:creation.bypass_actors},123));
  assert.throws(()=>validateRepositoryProtection(branch,creation,protection,456));
});
test('release preflight checks attestation capability, not the post-publish attestation result',()=>{
  const required={source_identity:true,local_verify:true,github_matrix:true,deterministic_candidate:true,owner_prepare_approval:true,owner_publish_approval:true,attestation_capability:true,immutable_releases:true,branch_protection:true};
  assert.equal(releasePreflight(required).status,'READY');
  assert.equal(releasePreflight({...required,github_matrix:false}).status,'BLOCKED');
  assert.equal(releasePreflight({...required,immutable_releases:null}).status,'UNKNOWN');
  assert.equal(releasePreflight({...required,attestation_capability:null,branch_protection:false}).status,'BLOCKED');
  assert.throws(()=>releasePreflight({...required,attestation:false}));
  assert.throws(()=>releasePreflight({}));
  assert.throws(()=>releasePreflight({...required,source_identity:'yes'}));
});
test('live configuration preflight reads fixed endpoints and preserves inaccessible bypass evidence as UNKNOWN',async()=>{
  const contexts=['ubuntu-latest','windows-latest'].flatMap(os=>[22,24].map(n=>`verify (${os}, ${n})`));
  const main={target:'branch',enforcement:'active',conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},bypass_actors:[],rules:[{type:'deletion'},{type:'non_fast_forward'},{type:'pull_request',parameters:{required_approving_review_count:0,require_code_owner_review:false,require_last_push_approval:false}},{type:'required_status_checks',parameters:{strict_required_status_checks_policy:false,do_not_enforce_on_create:false,required_status_checks:contexts.map(context=>({context,integration_id:15368}))}}]};
  const tag={target:'tag',enforcement:'active',conditions:{ref_name:{include:['refs/tags/v1.3.0'],exclude:[]}}};
  const config={...POLICY,public_evidence_approval:'fixture-only',tag_creation_ruleset:'11',tag_protection_ruleset:'12'};
  const data={'':{id:1382745738,default_branch:'main'},'immutable-releases':{enabled:true},'environments/release-approval':{can_admins_bypass:false,protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{reviewer:{login:'QT7-C23'}}]}],deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}},'environments/release-approval/deployment-branch-policies?per_page=100&page=1':{total_count:1,branch_policies:[{name:'main',type:'branch'}]},'rulesets/24122310':main,'rulesets/11':{...tag,rules:[{type:'creation'}],bypass_actors:[{actor_id:5109993,actor_type:'Integration',bypass_mode:'always'}]},'rulesets/12':{...tag,rules:[{type:'update'},{type:'deletion'}],bypass_actors:[]}};
  const calls=[];
  const client=githubClient('fixture-only',async(url,options)=>{
    calls.push({url,method:options.method});
    const root='https://api.github.com/repos/QT7-C23/ChatGPT-Conductor';
    if(url===root+'/')return new Response('',{status:404});
    const endpoint=url===root?'':url.startsWith(root+'/')?url.slice(root.length+1):null;
    return Object.hasOwn(data,endpoint)?Response.json(data[endpoint]):new Response('',{status:403});
  });
  const options={config,installation:'165834076',slug:'qt7-c23-conductor-publisher',capability:()=>true};
  const ready=await configurationPreflight(client,client,options);
  assert.equal(ready.status,'READY');assert.deepEqual(ready.evidence,{read_failures:[],hidden_bypass_rulesets:[]});
  assert.equal((await configurationPreflight(client,client,{...options,config:{...config,public_evidence_approval:null}})).gates.public_evidence_approval,false);
  assert.ok(calls.every(c=>c.method==='GET'),'preflight cannot mutate remote state');
  delete data['rulesets/11'].bypass_actors;
  const hidden=await configurationPreflight(client,client,options);
  assert.equal(hidden.gates.repository_protection,null);assert.equal(hidden.status,'UNKNOWN');
  assert.deepEqual(hidden.evidence.hidden_bypass_rulesets,['11']);
  delete data['immutable-releases'];
  const inaccessible=await configurationPreflight(client,client,options);
  assert.equal(inaccessible.gates.immutable_releases,null);
  assert.deepEqual(inaccessible.evidence.read_failures,[{gate:'immutable_releases',status:403}]);
  const creation=data['rulesets/11'];delete data['rulesets/11'];
  const missingRuleset=await configurationPreflight(client,client,options);
  assert.equal(missingRuleset.gates.repository_protection,null);
  assert.deepEqual(missingRuleset.evidence.read_failures,[{gate:'immutable_releases',status:403},{gate:'repository_protection',ruleset_id:'11',status:403}]);
  data['rulesets/11']=creation;
  const privateError=await configurationPreflight(client,client,{...options,capability:()=>{throw Error('PRIVATE_DO_NOT_LOG');}});
  assert.equal(privateError.gates.attestation_capability,null);
  assert.deepEqual(privateError.evidence.read_failures[0],{gate:'attestation_capability',status:null});
  assert.doesNotMatch(JSON.stringify(privateError),/PRIVATE_DO_NOT_LOG|fixture-only/);
  data['immutable-releases']={enabled:false};
  assert.equal((await configurationPreflight(client,client,options)).status,'BLOCKED');
  data['rulesets/11'].bypass_actors=[];
  assert.equal((await configurationPreflight(client,client,options)).gates.repository_protection,false);
  assert.equal((await configurationPreflight(client,client,{...options,installation:'1'})).gates.publisher_identity,false);
});
test('post-publish verification failure is published-unverified and not installable',()=>{
  const passed={published:true,release_identity:true,asset_bytes:true,attestation:true};
  assert.deepEqual(postPublishVerification(passed),{status:'VERIFIED',verification:'READY',installable:true,gates:passed});
  for(const gates of [
    {...passed,attestation:false},
    {...passed,asset_bytes:false},
    {...passed,release_identity:null},
  ]){
    const report=postPublishVerification(gates);
    assert.equal(report.status,'PUBLISHED_UNVERIFIED');
    assert.equal(report.installable,false);
    assert.equal(report.verification,gates.release_identity===null?'UNKNOWN':'BLOCKED');
  }
  assert.equal(postPublishVerification({...passed,published:null}).status,'PUBLICATION_UNKNOWN');
  assert.equal(postPublishVerification({...passed,published:false}).status,'NOT_PUBLISHED');
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
  const r={id:7,draft:false,immutable:true,tag_name:'v1.3.0',prerelease:false,assets:Object.entries(assets).map(([name,h],i)=>({id:i+1,name,digest:`sha256:${h}`}))};
  validatePublication(r,'7',sha,sha,assets);
  for(const patch of [{immutable:false},{draft:true},{tag_name:'v1.3.1'},{assets:[]}])assert.throws(()=>validatePublication({...r,...patch},'7',sha,sha,assets));
  assert.throws(()=>validatePublication(r,'7',sha,'e'.repeat(40),assets));
  assert.equal(sha256(Buffer.from('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
