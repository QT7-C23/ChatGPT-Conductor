import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { DistributionError, compareSemVer } from './contracts.mjs';
import { requireAuthenticatedBundle } from './source.mjs';
import { assertInventory } from './store.mjs';

export async function verifyProjectCompatibility({bundle,root,projects}) {
  requireAuthenticatedBundle(bundle,{payload:true});
  await assertInventory(root,bundle.manifest.payload.files,{relative:true});
  if(projects.some(p=>p.profile!=='po-1.1.3'||!bundle.manifest.data_contract.read_profiles.includes(p.profile)))throw new DistributionError('DATA_PROFILE','Target cannot read registered profile');
  if(!projects.length)return;
  // Fixed target-owned validator, no package scripts or request-supplied code.
  const script="import fs from 'node:fs';import {validateSnapshot,validateExecution,validateResult,validateReview} from './scripts/contracts.mjs';const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));for(const p of JSON.parse(process.argv[1])){const s=read(p.state_path);validateSnapshot(s);const packet=p.bindings?.packet_path?read(p.bindings.packet_path):null;if(s.active_packet?.lifecycle===s.lifecycle)validateExecution(packet,s);if(s.result_sha256!==null){const result=read(p.bindings.result_path);validateResult(result,packet);if(s.review_record&&!Object.hasOwn(s.review_record,'inherited_requirement'))validateReview(s.review_record,packet,result);}}";
  const env={PATH:''};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script,JSON.stringify(projects.map(p=>({state_path:p.state_path,bindings:p.bindings??null})))],{cwd:root,shell:false,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
    let count=0;const timer=setTimeout(()=>child.kill(),120000);
    for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{count+=b.length;if(count>1048576)child.kill();});
    child.on('error',()=>{clearTimeout(timer);reject(new DistributionError('DATA_PROFILE','Target validator could not start'));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new DistributionError('DATA_PROFILE','Target validator rejected project state'));else resolve();});
  });
  await assertInventory(root,bundle.manifest.payload.files,{relative:true});
}

// The Windows full gate measured 485 seconds before public distribution tests.
// Twenty minutes is a finite per-candidate budget; approval covers two candidates.
export const CANDIDATE_TIMEOUT_MS = 20 * 60 * 1000;
export async function verifyCandidate({bundle,root,managerVersion = '1.3.0',timeoutMs = CANDIDATE_TIMEOUT_MS,outputLimit = 1024*1024}) {
  requireAuthenticatedBundle(bundle,{payload:true});
  const manifest = bundle.manifest;
  if (!manifest.runtime.node_majors.includes(Number(process.versions.node.split('.')[0])) || !manifest.runtime.platforms.includes(`${process.platform}-${process.arch}`) || compareSemVer(managerVersion,manifest.runtime.min_manager_version)<0) throw new DistributionError('UNSUPPORTED_RUNTIME','Candidate runtime is unsupported');
  await assertInventory(root,manifest.payload.files,{relative:true});
  const pkg = JSON.parse(await fs.readFile(`${root}/package.json`,'utf8'));
  const skill = await fs.readFile(`${root}/SKILL.md`,'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill)?.[1];
  const name = /^name:\s*([^\r\n]+)$/m.exec(frontmatter ?? '')?.[1]?.trim();
  const version = /^  version:\s*["']?([0-9A-Za-z.-]+)["']?\s*$/m.exec(frontmatter ?? '')?.[1];
  if (pkg.name !== manifest.skill_id || pkg.version !== manifest.version || name !== manifest.skill_id || version !== manifest.version || !manifest.payload.files.some(f => f.path === 'scripts/verify.mjs')) throw new DistributionError('PACKAGE_IDENTITY','Package metadata differs from authenticated manifest');
  const env = {PATH:''};
  for (const key of ['SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  await new Promise((resolve,reject) => {
    let bytes = 0, failure = null;
    const child = spawn(process.execPath,['scripts/verify.mjs'],{cwd:root,shell:false,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    const timer = setTimeout(() => { failure = 'Candidate verification timed out'; child.kill(); },timeoutMs);
    for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk => { bytes += chunk.length; if (bytes>outputLimit) { failure = 'Candidate output limit exceeded'; child.kill(); } });
    child.on('error',() => { clearTimeout(timer); reject(new DistributionError('VERIFY_FAILED','Candidate could not start')); });
    child.on('close',code => { clearTimeout(timer); if (failure || code !== 0) reject(new DistributionError('VERIFY_FAILED',failure ?? 'Candidate verification failed')); else resolve(); });
  });
  await assertInventory(root,manifest.payload.files,{relative:true});
  return {profile:'conductor-node-verify-v1',passed:true};
}
