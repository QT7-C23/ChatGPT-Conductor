import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {canonicalJson,validateManifest} from './distribution/contracts.mjs';
import {REPOSITORY} from './distribution/source.mjs';
import {finalizeManifest} from './package-release.mjs';

// Deliberately unconfigured. Changing these is a reviewed configuration change,
// not a dispatch input and not evidence that the remote settings exist.
export const POLICY=Object.freeze({license:'MIT',public_evidence_approval:null,reviewers:[],default_branch:'main',tag_creation_ruleset:null,tag_protection_ruleset:null,publisher_integration_id:null});
export const ENVIRONMENTS=Object.freeze({approval:'release-approval'});
const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const HEX40=/^[0-9a-f]{40}$/,HEX64=/^[0-9a-f]{64}$/,ID=/^[1-9][0-9]*$/;
const fail=()=>{throw Error('Release gate rejected missing, mismatched or untrusted evidence');};
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);
const keys=(o,k)=>o&&equal(Object.keys(o).sort(),k.split(' ').sort());
export const sha256=b=>createHash('sha256').update(b).digest('hex');
const checkSha=s=>{if(!HEX40.test(s??''))fail();return s;};
const checkId=s=>{if(typeof s!=='string'||!ID.test(s))fail();return s;};
const checkDigest=s=>{if(!HEX64.test(s??''))fail();return s;};
const assertAssets=a=>{if(!a||typeof a!=='object'||Array.isArray(a)||Object.entries(a).some(([n,h])=>!['chatgpt-conductor-1.2.0.zip','CHANGELOG.md','release-manifest.json','SHA256SUMS'].includes(n)||!HEX64.test(h)))fail();};

export function validateBuild(b,origin,assets,metadata=b?.metadata){
  if(!keys(b,'schema kind repository workflow workflow_ref workflow_sha run_id run_attempt source_commit version channel assets metadata')||b.schema!==1||b.kind!=='candidate'||b.version!=='1.2.0'||b.channel!=='stable'||b.repository!==REPOSITORY.full_name||b.workflow!=='.github/workflows/package-candidate.yml'||b.workflow_ref!==`refs/heads/${POLICY.default_branch}`)fail();
  checkSha(b.source_commit);checkSha(b.workflow_sha);checkId(b.run_id);
  if(!Number.isSafeInteger(b.run_attempt)||b.run_attempt<1)fail();
  assertAssets(b.assets);
  if(!keys(b.metadata,'candidate.json payload-inventory.json')||Object.values(b.metadata).some(h=>!HEX64.test(h))||!equal(b.metadata,metadata)||!equal(Object.keys(b.assets).sort(),['CHANGELOG.md','chatgpt-conductor-1.2.0.zip'])||!equal(b.assets,assets)||Object.entries(origin).some(([k,v])=>!equal(b[k],v)))fail();
  return b;
}
export function validateApproval(a,purpose,b,draft=null,assets=null){
  if(!keys(a,'schema purpose decision binding draft_id final_assets accept_ref publish_ref')||a.schema!==1||a.purpose!==purpose||a.decision!==(purpose==='candidate'?'APPROVE_CANDIDATE':'ACCEPT_AND_PUBLISH')||!equal(a.binding,b)||a.draft_id!==draft||!equal(a.final_assets,assets))fail();
  validateBuild(b,{},b.assets);
  if(purpose==='publish'){
    checkId(draft);assertAssets(assets);
    if(!equal(Object.keys(assets).sort(),['CHANGELOG.md','SHA256SUMS','chatgpt-conductor-1.2.0.zip','release-manifest.json'])||Object.entries(b.assets).some(([n,h])=>assets[n]!==h)||![a.accept_ref,a.publish_ref].every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9:/._#-]{0,255}$/.test(v))||a.accept_ref===a.publish_ref)fail();
  }else if(purpose!=='candidate'||a.accept_ref!==null||a.publish_ref!==null)fail();
  return a;
}
export function releasePreflight(gates){
  if(!gates||typeof gates!=='object'||Array.isArray(gates)||!Object.keys(gates).length||Object.values(gates).some(v=>v!==true&&v!==false&&v!==null))fail();
  if(!Object.hasOwn(gates,'attestation_capability')||Object.hasOwn(gates,'attestation'))fail();
  const values=Object.values(gates);
  const status=values.includes(false)?'BLOCKED':values.some(v=>v!==true)?'UNKNOWN':'READY';
  return {status,gates:{...gates}};
}
export function postPublishVerification(gates){
  const expected=['asset_bytes','attestation','published','release_identity'];
  if(!gates||typeof gates!=='object'||Array.isArray(gates)||!equal(Object.keys(gates).sort(),expected))fail();
  const values=Object.values(gates);
  if(values.some(v=>v!==true&&v!==false&&v!==null))fail();
  if(gates.published!==true)return {status:gates.published===false?'NOT_PUBLISHED':'PUBLICATION_UNKNOWN',verification:gates.published===false?'BLOCKED':'UNKNOWN',installable:false,gates:{...gates}};
  const checks=[gates.release_identity,gates.asset_bytes,gates.attestation];
  const blocked=checks.includes(false),unknown=checks.includes(null);
  const verified=!blocked&&!unknown;
  return {status:verified?'VERIFIED':'PUBLISHED_UNVERIFIED',verification:verified?'READY':blocked?'BLOCKED':'UNKNOWN',installable:verified,gates:{...gates}};
}
export function validateConfiguration(config,immutable,environment,branches){
  if(!config.license||!config.public_evidence_approval||!Array.isArray(config.reviewers)||config.reviewers.length!==1||immutable?.enabled!==true)fail();
  const r=environment?.protection_rules?.find(x=>x.type==='required_reviewers');
  if(!r||r.prevent_self_review!==false||!r.reviewers?.length||!equal(r.reviewers.map(x=>x.reviewer?.login).sort(),[...config.reviewers].sort())||environment.deployment_branch_policy?.protected_branches!==false||environment.deployment_branch_policy?.custom_branch_policies!==true||!equal(branches.map(b=>({name:b.name,type:b.type})),[{name:config.default_branch,type:'branch'}]))fail();
  return {prevent_self_review:r.prevent_self_review,required_reviewers:r.reviewers.length};
}
export function validateRepositoryProtection(branch,creation,protection,publisher){
  const required=['ubuntu-latest','windows-latest'].flatMap(os=>[22,24].map(n=>`verify (${os}, ${n})`));
  if(branch.enforce_admins?.enabled!==true||branch.required_status_checks?.strict!==true||!required.every(n=>branch.required_status_checks.contexts?.includes(n))||branch.allow_force_pushes?.enabled!==false||branch.allow_deletions?.enabled!==false)fail();
  for(const r of [creation,protection])if(r.target!=='tag'||r.enforcement!=='active'||!equal(r.conditions?.ref_name,{include:['refs/tags/v1.2.0'],exclude:[]}))fail();
  if(!Number.isSafeInteger(publisher)||publisher<1||!equal(creation.rules,[{type:'creation'}])||!equal(creation.bypass_actors,[{actor_id:publisher,actor_type:'Integration',bypass_mode:'always'}])||!equal(protection.rules.map(r=>r.type).sort(),['deletion','update'])||!equal(protection.bypass_actors,[]))fail();
}
export function validateMatrix(run,jobs,commit){
  checkSha(commit);
  if(run.head_sha!==commit||run.path!=='.github/workflows/verify.yml'||run.event!=='push'||run.status!=='completed'||run.conclusion!=='success'||!Number.isSafeInteger(run.run_attempt))fail();
  for(const os of ['ubuntu-latest','windows-latest'])for(const n of [22,24]){
    const matches=jobs.filter(j=>j.name===`verify (${os}, ${n})`);
    if(matches.length!==1||matches[0].run_attempt!==run.run_attempt||matches[0].head_sha!==commit||matches[0].status!=='completed'||matches[0].conclusion!=='success')fail();
  }
}
export function validatePublication(r,id,commit,tagCommit,assets){
  assertAssets(assets);
  if(String(r.id)!==id||r.draft!==false||r.immutable!==true||r.tag_name!=='v1.2.0'||r.prerelease!==false||tagCommit!==commit||!equal(Object.fromEntries(r.assets.map(a=>[a.name,a.digest?.replace(/^sha256:/,'')])),assets)||new Set(r.assets.map(a=>a.name)).size!==r.assets.length)fail();
}

function child(exe,args,cwd=ROOT,env=process.env){
  const r=spawnSync(exe,args,{cwd,env,encoding:'utf8',shell:false,maxBuffer:32*1024*1024,timeout:1200000});
  if(r.error||r.status!==0)fail();return r.stdout.trim();
}
function cleanEnv(){return Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k)));}
async function json(file){const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)fail();return JSON.parse(await fs.readFile(file,'utf8'));}
async function write(file,data){await fs.writeFile(file,canonicalJson(data),{flag:'wx'});}
function trustedContext(env=process.env){
  if(env.GITHUB_REPOSITORY!==REPOSITORY.full_name||env.GITHUB_REF!==`refs/heads/${POLICY.default_branch}`||env.GITHUB_EVENT_NAME!=='workflow_dispatch')fail();
  checkSha(env.GITHUB_SHA);checkId(env.GITHUB_RUN_ID);
  if(!/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT??''))fail();
  if(child('git',['rev-parse','HEAD'])!==env.GITHUB_SHA)fail();
  return {repository:REPOSITORY.full_name,workflow_ref:env.GITHUB_REF,workflow_sha:env.GITHUB_SHA,run_id:env.GITHUB_RUN_ID,run_attempt:Number(env.GITHUB_RUN_ATTEMPT)};
}
async function build(out,source,commit){
  checkSha(commit);
  if(child('git',['rev-parse','HEAD'],source)!==commit||child('git',['status','--porcelain','--untracked-files=no'],source))fail();
  const env=cleanEnv();
  child(process.execPath,['scripts/verify.mjs'],source,env);
  const a=path.join(out,'a'),b=path.join(out,'b');
  child(process.execPath,['scripts/package-release.mjs','candidate',a,commit],source,env);
  child(process.execPath,['scripts/package-release.mjs','candidate',b,commit],source,env);
  const candidate=await json(path.join(a,'candidate.json'));
  for(const name of ['candidate.json','payload-inventory.json','CHANGELOG.md',candidate.payload.name])if(!(await fs.readFile(path.join(a,name))).equals(await fs.readFile(path.join(b,name))))fail();
  if(candidate.kind!=='candidate'||'release_id'in candidate||candidate.source_commit!==commit||candidate.version!=='1.2.0')fail();
  const metadata={};for(const n of ['candidate.json','payload-inventory.json'])metadata[n]=sha256(await fs.readFile(path.join(a,n)));
  return {folder:a,candidate,metadata,assets:{[candidate.payload.name]:sha256(await fs.readFile(path.join(a,candidate.payload.name))),'CHANGELOG.md':sha256(await fs.readFile(path.join(a,'CHANGELOG.md')))}};
}

// Every URL comes from fixed repository endpoints. Caller data only enters validated
// path components; no remote URL, executable, shell fragment or source script input.
export function githubClient(token,transport=fetch){
  if(!token)fail();
  async function request(endpoint,{method='GET',body,binary=false,upload=false}={}){
    const base=upload?'https://uploads.github.com':'https://api.github.com';
    const r=await transport(`${base}/repos/${REPOSITORY.full_name}/${endpoint}`,{method,signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${token}`,Accept:binary&&method==='GET'?'application/octet-stream':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(body?{'Content-Type':binary?'application/octet-stream':'application/json'}:{})},body:body?(binary?body:JSON.stringify(body)):undefined});
    if(!r.ok)fail();if(r.status===204)return null;
    if(Number(r.headers.get('content-length')??0)>40*1024*1024)fail();
    const data=Buffer.from(await r.arrayBuffer());if(data.length>40*1024*1024)fail();
    return binary&&method==='GET'?data:JSON.parse(data.toString('utf8'));
  }
  async function list(endpoint,key){
    const all=[];
    for(let page=1;page<=100;page++){const v=await request(`${endpoint}${endpoint.includes('?')?'&':'?'}per_page=100&page=${page}`);const a=key?v[key]:v;if(!Array.isArray(a))fail();all.push(...a);if(a.length<100){if(key&&v.total_count!==undefined&&all.length!==v.total_count)fail();return all;}}
    fail();
  }
  return {request,list};
}
async function configuration(client,purpose){
  if(!POLICY.license||!POLICY.public_evidence_approval)fail();
  const configClient=githubClient(process.env.RELEASE_CONFIG_TOKEN);
  const immutable=await configClient.request('immutable-releases');
  if(!ENVIRONMENTS.approval)fail();
  const name=ENVIRONMENTS.approval;
  const environment=await client.request(`environments/${name}`);
  const branches=await client.list(`environments/${name}/deployment-branch-policies`,'branch_policies');
  const observed=validateConfiguration(POLICY,immutable,environment,branches);
  console.log(JSON.stringify({gate:'owner-approval-environment',name,...observed}));
  const repo=await client.request('');if(String(repo.id)!==REPOSITORY.id||repo.default_branch!==POLICY.default_branch)fail();
  const branch=await configClient.request(`branches/${POLICY.default_branch}/protection`);
  const creation=await configClient.request(`rulesets/${checkId(POLICY.tag_creation_ruleset)}`);
  const protection=await configClient.request(`rulesets/${checkId(POLICY.tag_protection_ruleset)}`);
  validateRepositoryProtection(branch,creation,protection,POLICY.publisher_integration_id);
}
async function runOrigin(client,runId,workflow,attempt=null){
  checkId(runId);const r=await client.request(`actions/runs/${runId}`);
  const w=await client.request(`actions/workflows/${workflow}.yml`);
  if(r.workflow_id!==w.id||w.path!==`.github/workflows/${workflow}.yml`||r.path!==w.path||r.head_branch!==POLICY.default_branch||r.event!=='workflow_dispatch'||r.status!=='completed'||r.conclusion!=='success'||r.repository?.id!==Number(REPOSITORY.id)||attempt!==null&&r.run_attempt!==attempt)fail();
  checkSha(r.head_sha);
  return r;
}
async function artifact(client,{run,id,digest,workflow},folder){
  const origin=await runOrigin(client,checkId(run),workflow);checkId(id);checkDigest(digest);
  const a=await client.request(`actions/artifacts/${id}`);
  if(a.expired||a.workflow_run?.id!==Number(run)||a.workflow_run?.head_sha!==origin.head_sha||a.name!==(workflow==='package-candidate'?'candidate':'approval')||a.digest!==`sha256:${digest}`||!Number.isFinite(Date.parse(a.created_at))||!Number.isFinite(Date.parse(origin.run_started_at))||Date.parse(a.created_at)<Date.parse(origin.run_started_at))fail();
  // gh uses fixed argv to retrieve only the authenticated immutable artifact ID.
  // GitHub artifact archives are extracted by the pinned download-artifact action
  // in workflows; here gh API returns archive bytes for bounded safe extraction.
  const bytes=await client.request(`actions/artifacts/${id}/zip`,{binary:true});
  if(sha256(bytes)!==digest)fail();
  const {default:yauzl}=await import('yauzl');
  await fs.mkdir(folder,{recursive:false});
  await new Promise((resolve,reject)=>yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true},(err,zip)=>{
    if(err)return reject(err);let total=0;const seen=new Set();
    zip.on('error',reject);zip.on('end',resolve);zip.on('entry',entry=>{
      const allowed=workflow==='package-candidate'?['candidate.json','payload-inventory.json','CHANGELOG.md','chatgpt-conductor-1.2.0.zip','build-evidence.json']:['approval.json'];
      if(!allowed.includes(entry.fileName)||seen.has(entry.fileName)||entry.uncompressedSize>32*1024*1024||(total+=entry.uncompressedSize)>40*1024*1024||((entry.externalFileAttributes>>>16)&0o170000)===0o120000){zip.close();return reject(Error('Invalid artifact'));}
      seen.add(entry.fileName);zip.openReadStream(entry,(e,s)=>{if(e)return reject(e);const chunks=[];s.on('data',b=>chunks.push(b));s.on('error',reject);s.on('end',async()=>{try{await fs.writeFile(path.join(folder,entry.fileName),Buffer.concat(chunks),{flag:'wx'});zip.readEntry();}catch(e){reject(e);}});});
    });zip.readEntry();
  }));
  return origin;
}
function inputReference(prefix,workflow){return {run:process.env[`${prefix}_RUN`],id:process.env[`${prefix}_ARTIFACT`],digest:process.env[`${prefix}_DIGEST`],workflow};}
async function inputs(client,folder,purpose){
  const cdir=path.join(folder,'candidate'),adir=path.join(folder,'approval');
  const origin=await artifact(client,inputReference('CANDIDATE','package-candidate'),cdir);
  const b=await json(path.join(cdir,'build-evidence.json')),candidate=await json(path.join(cdir,'candidate.json'));
  const assets={};for(const n of ['chatgpt-conductor-1.2.0.zip','CHANGELOG.md'])assets[n]=sha256(await fs.readFile(path.join(cdir,n)));
  const metadata={};for(const n of ['candidate.json','payload-inventory.json'])metadata[n]=sha256(await fs.readFile(path.join(cdir,n)));
  validateBuild(b,{repository:REPOSITORY.full_name,workflow:'.github/workflows/package-candidate.yml',workflow_ref:`refs/heads/${POLICY.default_branch}`,workflow_sha:origin.head_sha,run_id:String(origin.id),run_attempt:origin.run_attempt,source_commit:checkSha(process.env.CANDIDATE_COMMIT)},assets,metadata);
  if(candidate.kind!=='candidate'||'release_id'in candidate||candidate.source_commit!==b.source_commit||candidate.payload.name!=='chatgpt-conductor-1.2.0.zip'||candidate.payload.sha256!==assets[candidate.payload.name]||candidate.changelog.sha256!==assets['CHANGELOG.md'])fail();
  const humanRun=await artifact(client,inputReference('APPROVAL','approve-release'),adir);
  if(!POLICY.reviewers.includes(humanRun.actor?.login)||!POLICY.reviewers.includes(humanRun.triggering_actor?.login))fail();
  const approval=await json(path.join(adir,'approval.json'));
  validateApproval(approval,purpose,b,purpose==='publish'?checkId(process.env.DRAFT_ID):null,purpose==='publish'?approval.final_assets:null);
  candidate.payload_path=path.join(cdir,candidate.payload.name);
  return {candidate,b,approval,cdir};
}
async function matrix(client,commit){
  const runs=await client.list(`actions/workflows/verify.yml/runs?head_sha=${checkSha(commit)}&event=push`,'workflow_runs');
  if(!runs.length)fail();
  const run=runs.sort((a,b)=>b.id-a.id)[0];
  const current=await client.request(`actions/runs/${checkId(String(run.id))}`);
  const workflow=await client.request('actions/workflows/verify.yml');
  if(current.workflow_id!==workflow.id||workflow.path!=='.github/workflows/verify.yml')fail();
  const jobs=await client.list(`actions/runs/${run.id}/attempts/${current.run_attempt}/jobs`,'jobs');
  validateMatrix(current,jobs,commit);
}
async function tagCommit(client){
  const ref=await client.request('git/ref/tags/v1.2.0');
  // Lightweight refs only: no ambiguous tag peeling or tag reuse in this path.
  if(ref.ref!=='refs/tags/v1.2.0'||ref.object?.type!=='commit')fail();return checkSha(ref.object.sha);
}
async function draftAssets(client,r,folder,expected){
  if(r.tag_name!=='v1.2.0'||r.prerelease!==false||new Set(r.assets.map(a=>a.name)).size!==r.assets.length||!equal(r.assets.map(a=>a.name).sort(),Object.keys(expected).sort()))fail();
  await fs.mkdir(folder,{recursive:false});
  for(const a of r.assets){checkId(String(a.id));const bytes=await client.request(`releases/assets/${a.id}`,{binary:true});if(sha256(bytes)!==expected[a.name])fail();await fs.writeFile(path.join(folder,a.name),bytes,{flag:'wx'});}
}
export async function validateFinalFiles(folder,candidate,b,id,assets){
  const manifest=validateManifest(await json(path.join(folder,'release-manifest.json')));
  if(manifest.release_id!==id||manifest.source_commit!==b.source_commit||manifest.channel!==b.channel||!equal(manifest.payload,candidate.payload)||!equal(manifest.changelog,candidate.changelog))fail();
  const sums=`${assets[candidate.payload.name]}  ${candidate.payload.name}\n${assets['CHANGELOG.md']}  CHANGELOG.md\n${assets['release-manifest.json']}  release-manifest.json\n`;
  if(await fs.readFile(path.join(folder,'SHA256SUMS'),'utf8')!==sums)fail();
}
export async function main(mode){
  const context=trustedContext();
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'conductor-release-'));
  if(mode==='candidate'){
    const commit=checkSha(process.env.CANDIDATE_COMMIT),built=await build(folder,path.resolve(ROOT,'../candidate-source'),commit);
    const b={schema:1,kind:'candidate',...context,workflow:'.github/workflows/package-candidate.yml',source_commit:commit,version:'1.2.0',channel:'stable',assets:built.assets,metadata:built.metadata};
    validateBuild(b,{},built.assets);await write(path.join(built.folder,'build-evidence.json'),b);
    await fs.cp(built.folder,path.join(ROOT,'candidate-output'),{recursive:true,errorOnExist:true,force:false});return;
  }
  const client=githubClient(process.env.GH_TOKEN);
  if(mode==='approve'){
    const a=JSON.parse(process.env.APPROVAL_PACKET??'null');
    if(!a||!['candidate','publish'].includes(a.purpose)||a.purpose!==process.env.APPROVAL_PURPOSE)fail();
    await configuration(client,a.purpose);
    validateApproval(a,a.purpose,a.binding,a.draft_id,a.final_assets);
    await fs.mkdir(path.join(ROOT,'approval-output'));await write(path.join(ROOT,'approval-output/approval.json'),a);return;
  }
  if(!['prepare-check','prepare','publish-check','publish','verify-published'].includes(mode))fail();
  const purpose=mode.startsWith('prepare')?'candidate':'publish';
  await configuration(client,purpose==='candidate'?'prepare':'publish');
  const {candidate,b,approval}=await inputs(client,folder,purpose);
  if(mode==='prepare-check'){
    const built=await build(path.join(folder,'rebuild'),path.resolve(ROOT,'../candidate-source'),b.source_commit);
    if(!equal(built.assets,b.assets)||!equal(built.metadata,b.metadata))fail();return;
  }
  if(mode==='prepare'){
    // Ref creation fails if tag exists. Never update/reuse/force an existing tag.
    await client.request('git/refs',{method:'POST',body:{ref:'refs/tags/v1.2.0',sha:b.source_commit}});
    if(await tagCommit(client)!==b.source_commit)fail();
    const draft=await client.request('releases',{method:'POST',body:{tag_name:'v1.2.0',target_commitish:b.source_commit,name:'v1.2.0',draft:true,prerelease:false,generate_release_notes:false}});
    const id=checkId(String(draft.id));if(draft.draft!==true)fail();
    const out=path.join(folder,'final');await finalizeManifest({candidate,release:{release_id:id,source_commit:b.source_commit,channel:b.channel},out});
    await fs.copyFile(candidate.payload_path,path.join(out,candidate.payload.name));
    const assets={};for(const n of ['chatgpt-conductor-1.2.0.zip','CHANGELOG.md','release-manifest.json','SHA256SUMS']){
      const bytes=await fs.readFile(path.join(out,n));assets[n]=sha256(bytes);
      await client.request(`releases/${id}/assets?name=${encodeURIComponent(n)}`,{method:'POST',body:bytes,binary:true,upload:true});
    }
    const current=await client.request(`releases/${id}`);if(current.draft!==true)fail();await draftAssets(client,current,path.join(folder,'download'),assets);
    await fs.mkdir(path.join(ROOT,'draft-output'));await write(path.join(ROOT,'draft-output/publish-packet.json'),{schema:1,purpose:'publish',decision:'ACCEPT_AND_PUBLISH',binding:b,draft_id:id,final_assets:assets,accept_ref:null,publish_ref:null});
    // This is only a proposed packet; a separate human approval artifact is required.
    return;
  }
  const id=checkId(process.env.DRAFT_ID),r=await client.request(`releases/${id}`),target=await tagCommit(client);
  if(target!==b.source_commit)fail();
  await draftAssets(client,r,path.join(folder,'published-assets'),approval.final_assets);
  await validateFinalFiles(path.join(folder,'published-assets'),candidate,b,id,approval.final_assets);
  if(mode==='verify-published'){
    validatePublication(r,id,b.source_commit,target,approval.final_assets);
    try{
      child('gh',['release','verify','v1.2.0','--repo',REPOSITORY.full_name],folder);
      for(const name of Object.keys(approval.final_assets))child('gh',['release','verify-asset','v1.2.0',path.join(folder,'published-assets',name),'--repo',REPOSITORY.full_name],folder);
    }catch{
      console.log(JSON.stringify(postPublishVerification({published:true,release_identity:true,asset_bytes:true,attestation:null})));
      throw Error('Post-publish attestation verification failed');
    }
    console.log(JSON.stringify(postPublishVerification({published:true,release_identity:true,asset_bytes:true,attestation:true})));
    return;
  }
  if(r.draft!==true)fail();await matrix(client,b.source_commit);
  if(mode==='publish')await client.request(`releases/${id}`,{method:'PATCH',body:{draft:false}});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==3)fail();await main(process.argv[2]);}catch{
    if(process.argv[2]==='verify-published')console.log(JSON.stringify(postPublishVerification({published:null,release_identity:null,asset_bytes:null,attestation:null})));
    console.error('Release workflow blocked: required authenticated evidence or configuration was not verified');process.exitCode=1;
  }
}
