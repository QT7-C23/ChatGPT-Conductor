import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { fixture,zipBytes,hash } from './distribution-fixtures.mjs';
import { extractVerifiedPayload } from '../../scripts/distribution/archive.mjs';
import { canonicalSha256 } from '../../scripts/distribution/contracts.mjs';
import { canonicalPath,inventory } from '../../scripts/distribution/store.mjs';

async function managerFiles() {
  const root=await canonicalPath(fileURLToPath(new URL('../..',import.meta.url)).replace(/[\\/]$/,''));
  const files={};
  for(const directory of ['scripts/distribution','node_modules/yauzl','node_modules/pend','node_modules/buffer-crc32']) {
    for(const file of await inventory(`${root}/${directory}`)) files[file.path.slice(root.length+1)]=await fs.readFile(file.path);
  }
  for(const file of ['scripts/contracts.mjs','scripts/migration.mjs','contracts/routing.json']) files[file]=await fs.readFile(`${root}/${file}`);
  return files;
}

export async function setup(t,{script = 'if(process.env.GH_TOKEN || process.env.NODE_OPTIONS || process.env.PATH) process.exit(9);',project = false, migrations = []} = {}) {
  const root = await canonicalPath(await fs.mkdtemp(path.join(os.tmpdir(),'conductor-install-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const contents = {...await managerFiles(),'SKILL.md':'---\nname: chatgpt-conductor\nmetadata:\n  version: "1.3.0"\n---\n','package.json':JSON.stringify({name:'chatgpt-conductor',version:'1.3.0',type:'module'}),'scripts/verify.mjs':script};
  const zip = await zipBytes(Object.entries(contents).map(([name,body])=>({name:`chatgpt-conductor/${name}`,body})));
  const mutateManifest=m=>{m.migrations=migrations;m.payload.files=Object.entries(contents).map(([path,body])=>({path,bytes:Buffer.byteLength(body),sha256:hash(body)}));};
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
    const state = JSON.parse(await fs.readFile(new URL('../../examples/project-state.json',import.meta.url),'utf8'));
    const bytes = JSON.stringify(state); await fs.writeFile(`${projectRoot}/state.json`,bytes);
    projects.push({project_id:state.project_id,root_path:projectRoot,state_path:`${projectRoot}/state.json`,directories:[projectRoot],files:[{path:`${projectRoot}/state.json`,bytes:Buffer.byteLength(bytes),sha256:hash(bytes)}],schema_version:2,profile:'po-1.1.3'});
  }
  const plan = {operation:'install',install_id:'local',scope:'user',active_path:active,target_active_path:active,control_path:control,generation:0,current_release:null,target_release:bundle.descriptor,current_files:[],channel:'stable',projects,software_only:!project,migration_ids:[],impact:'Synthetic install',changelog:{body:bundle.changelog,sha256:bundle.descriptor.changelog_sha256},writes:[active,control],recovery:[active,control],snapshot:{path:`${root}/snapshots/first`,capacity_bytes:0},checks:[],quiescence:[],requires_maintenance:false,expires_at:new Date(Date.now()+600000).toISOString(),plan_id:'plan-one',blockers:[],status:'ready'};
  const approval = {plan_id:plan.plan_id,plan_sha256:canonicalSha256(plan),operation:'install',install_id:'local',projects:projects.map(p=>p.project_id),approval_source:'synthetic user test',user_approved:true,writers_stopped:true,issued_at:new Date(Date.now()-1000).toISOString(),expires_at:plan.expires_at,use_id:'once'};
  return {root,plan,approval,bundle,originalBundle,managerRoot,runnerInstall,managerBundle:bundle,source:f.source,contents,deviceOptions:{volume:async()=>true}};
}
