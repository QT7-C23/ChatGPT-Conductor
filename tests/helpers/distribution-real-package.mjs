// Standalone real-payload acceptance. Deliberately NOT part of scripts/verify.mjs.
// Inner candidate verification runs the full suite with synthetic small candidates.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {localRelease,localServer,cliChild} from './distribution-cli-fixture.mjs';
import {baselineContents,approve} from './distribution-m5-fixture.mjs';
import {canonicalPath,inventory} from '../../scripts/distribution/store.mjs';
const candidateFile=process.argv[2];if(!candidateFile)throw Error('Pass exact candidate.json');
const candidate=JSON.parse(await fs.readFile(candidateFile,'utf8')),folder=path.dirname(candidateFile),root=await canonicalPath(await fs.mkdtemp(path.join(os.tmpdir(),'conductor-real-')));
const cleanup=[];const t={after:fn=>cleanup.push(fn)};const measurements=[];
try{
  const old=await baselineContents();
  // Read exact original sources listed by the candidate and prove the inventory;
  // the supplied ZIP remains the actual generated package under acceptance.
  const contents={};for(const f of candidate.payload.files)contents[f.path]=Buffer.alloc(f.bytes);
  const newer=await localRelease(contents,'1.3.0','120',{zip:await fs.readFile(path.join(folder,candidate.payload.name)),notes:await fs.readFile(path.join(folder,'CHANGELOG.md'))});
  newer.manifest.payload.files=candidate.payload.files;newer.bodies[0]=Buffer.from(JSON.stringify(newer.manifest));
  const {hash}=await import('./distribution-fixtures.mjs');newer.assets[0].size=newer.bodies[0].length;newer.assets[0].digest=`sha256:${hash(newer.bodies[0])}`;
  const server=await localServer(t,[await localRelease(old,'1.1.3','113'),newer]);
  async function run(args){const r=await cliChild(root,server.port,args,{timeout:60*60000});measurements.push({command:args[0],mode:args.includes('--plan')?'plan':'apply',code:r.code,elapsed_ms:r.elapsed_ms});console.log(JSON.stringify(measurements.at(-1)));assert.equal(r.code,0,r.out+r.err);return r.body;}
  async function operation(command,config){const configFile=`${root}/config.json`;await fs.writeFile(configFile,JSON.stringify(config));const {plan}=await run([command,'--plan','--config',configFile]);const planFile=`${root}/plan.json`,approvalFile=`${root}/approval.json`;await fs.writeFile(planFile,JSON.stringify(plan));await fs.writeFile(approvalFile,JSON.stringify(approve(plan)));return run([command,'--apply',planFile,'--approval',approvalFile]);}
  const config={install_id:'real',scope:'user',control_path:`${root}/.agents/.conductor/real`,target_release_id:'120',channel:'stable',projects:[],software_only:true,snapshot_path:`${root}/snapshots/install`};
  const installed=await operation('install',config);assert.equal(installed.report.installation.release.version,'1.3.0');
  // Exact original manual installation, ordinary current project bytes untouched.
  const adopted=`${root}/adopt`,active=`${adopted}/.agents/skills/project-orchestrator`;await fs.mkdir(active,{recursive:true});for(const [name,bytes]of Object.entries(old)){await fs.mkdir(path.dirname(`${active}/${name}`),{recursive:true});await fs.writeFile(`${active}/${name}`,bytes);}
  const data=`${root}/data`;await fs.mkdir(data);const state=old['examples/project-state.json'];await fs.writeFile(`${data}/state.json`,state);const parsed=JSON.parse(state);const project={project_id:parsed.project_id,root_path:data,state_path:`${data}/state.json`,directories:[data],files:await inventory(data),schema_version:2,profile:'po-1.1.3'};const before=await inventory(data);
  const updated=await operation('update',{...config,control_path:`${adopted}/.agents/.conductor/real`,current_release_id:'113',manual_adoption:true,projects:[project],software_only:false,snapshot_path:`${root}/snapshots/adopt`});assert.deepEqual(await inventory(data),before);
  await operation('rollback',{...config,control_path:`${adopted}/.agents/.conductor/real`,projects:[project],software_only:false,target_release_id:'113',snapshot_path:`${root}/snapshots/rollback`});
  assert.equal((await inventory(active)).length,46);assert.ok((await fs.stat(updated.report.manager_path)).isDirectory());assert.deepEqual(await inventory(data),before);
  console.log(JSON.stringify({status:'PASS',root,measurements,authentication:'local protocol fixture; not live GitHub attestation'}));
}finally{for(const fn of cleanup.reverse())await fn();}
