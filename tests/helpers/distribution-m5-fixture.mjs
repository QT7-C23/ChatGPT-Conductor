import * as fs from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fixture,zipBytes,hash } from './distribution-fixtures.mjs';
import { inventory,canonicalPath } from '../../scripts/distribution/store.mjs';
import { canonicalSha256 } from '../../scripts/distribution/contracts.mjs';
import {spawn} from 'node:child_process';
export { setup } from './distribution-update-fixture.mjs';
export async function baselineContents(){
  const root=await canonicalPath(fileURLToPath(new URL('../fixtures/v1.1.3/project-orchestrator',import.meta.url)));
  const files={};for(const f of await inventory(root))files[f.path.slice(root.length+1)]=await fs.readFile(f.path);return files;
}
export async function authenticate(t,i,contents,version){
  const module=await import(pathToFileURL(`${i.managerRoot}/scripts/distribution/source.mjs`));
  const id=version==='1.1.3'?'project-orchestrator':'chatgpt-conductor';
  const zip=await zipBytes(Object.entries(contents).map(([name,body])=>({name:`${id}/${name}`,body})));
  const f=await fixture(t,{zip,sourceFactory:module.createReleaseSource,mutateRelease:r=>r.tag_name=`v${version}`,mutateManifest:m=>{m.version=version;m.tag=`v${version}`;m.skill_id=id;m.payload.archive_root=id;m.payload.name=`chatgpt-conductor-${version}.zip`;m.upgrade_from=['1.1.3','1.2.0'];m.payload.files=Object.entries(contents).map(([path,body])=>({path,bytes:Buffer.byteLength(body),sha256:hash(body)}));}});
  return {bundle:await f.source.acquirePayload(await f.source.authenticateRelease('123')),source:f.source};
}
export const approve=plan=>({plan_id:plan.plan_id,plan_sha256:canonicalSha256(plan),operation:plan.operation,install_id:plan.install_id,projects:plan.projects.map(p=>p.project_id),approval_source:'explicit local test',user_approved:true,writers_stopped:true,issued_at:new Date(Date.now()-1000).toISOString(),expires_at:plan.expires_at,use_id:plan.plan_id});
export async function nextPlan(i,target,{operation='rollback',id='rollback',projects=i.plan.projects,...extra}={}){
  const record=JSON.parse(await fs.readFile(`${i.plan.control_path}/installation.json`));
  const targetPath=record.active_path.replace(/[^/]+$/,target.descriptor.skill_id);
  return {...i.plan,operation,plan_id:id,current_release:record.release,target_release:target.descriptor,generation:record.generation,current_files:await inventory(record.active_path),active_path:record.active_path,target_active_path:targetPath,projects,software_only:projects.length===0,snapshot:{path:`${i.root}/snapshots/${id}`,capacity_bytes:0},changelog:{body:target.changelog,sha256:target.descriptor.changelog_sha256},...(record.active_path!==targetPath?{layout:{from:record.active_path,to:targetPath}}:{}),...extra};
}
export async function operation(i,name,plan,target,extra={}){
  const api=await import(pathToFileURL(`${i.managerRoot}/scripts/distribution/update.mjs`));
  return api[name]({...i,plan,approval:approve(plan),bundle:target.bundle,source:{recheck:b=>b===target.bundle?target.source.recheck(b):i.source.recheck(b)},transactionId:plan.plan_id,...extra});
}
export async function runChild(i,plan,extra={},kill=false){
  const file=`${i.root}/m5-request.json`;await fs.writeFile(file,JSON.stringify({managerRoot:i.managerRoot,manager_release:i.bundle.descriptor,plan,approval:approve(plan),...extra}));
  return new Promise((resolve,reject)=>{
    const p=spawn(process.execPath,[fileURLToPath(new URL('./distribution-m5-child.mjs',import.meta.url)),file],{shell:false,windowsHide:true});let out='',err='',killed=false;
    const timer=setTimeout(()=>{p.kill();reject(new Error(`Child timeout ${out} ${err}`));},60000);
    p.stdout.on('data',b=>{out+=b;if(kill&&out.includes('READY')&&!killed){killed=true;p.kill('SIGKILL');}});p.stderr.on('data',b=>err+=b);
    p.on('error',reject);p.on('exit',code=>{clearTimeout(timer);resolve({code,out,err,killed});});
  });
}

export const legacyMigrations=[1,2].map(schema=>({id:`po-legacy-schema${schema}-v1`,from_profile:`po-legacy-schema${schema}`,to_profile:'po-1.1.3',from_software_versions:['1.2.0'],target_software_version:'1.2.0',kind:'legacy-data',handler_id:'po-legacy-snapshot-v1',preconditions:['stopped and reconciled'],state_effect:'DISCUSS stays DISCUSS; all others PLAN',authorization_effect:'no inherited authorization',rollback_mode:'snapshot',impact_summary:'new approved state destination; legacy evidence unchanged'}));
