// Trusted local protocol fixture, not a public source/executable override.
import http from 'node:http';
import * as fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {zipBytes,hash} from './distribution-fixtures.mjs';
import {REPOSITORY} from '../../scripts/distribution/source.mjs';
import {legacyRoutes} from '../../scripts/package-release.mjs';
export async function localRelease(contents,version,id,{zip=null,notes=Buffer.from('Local authenticated fixture; not GitHub attestation\n')}={}){
  const skill=version==='1.1.3'?'project-orchestrator':'chatgpt-conductor';
  zip??=await zipBytes(Object.entries(contents).map(([name,body])=>({name:`${skill}/${name}`,body})));
  const files=Object.entries(contents).map(([path,body])=>({path,bytes:Buffer.byteLength(body),sha256:hash(body)}));
  const manifest={manifest_version:1,product:'chatgpt-conductor',version,channel:'stable',repository:REPOSITORY,tag:`v${version}`,source_commit:'b'.repeat(40),release_id:id,skill_id:skill,payload:{name:`chatgpt-conductor-${version}.zip`,bytes:zip.length,sha256:hash(zip),archive_root:skill,files},changelog:{name:'CHANGELOG.md',bytes:notes.length,sha256:hash(notes)},runtime:{node_majors:[22,24],platforms:['win32-x64','linux-x64'],min_manager_version:'1.2.0'},data_contract:{schema_version:2,profile:'po-1.1.3',read_profiles:['po-1.1.3'],write_profile:'po-1.1.3'},upgrade_from:['1.1.3'],migrations:version==='1.2.0'?legacyRoutes(version):[],verification:{profile:'conductor-node-verify-v1'},baseline_provenance:null};
  const bodies=[Buffer.from(JSON.stringify(manifest)),notes,zip],names=['release-manifest.json','CHANGELOG.md',manifest.payload.name];
  const assets=bodies.map((body,i)=>({id:Number(id)*10+i,name:names[i],state:'uploaded',size:body.length,digest:`sha256:${hash(body)}`}));
  return {manifest,bodies,assets,release:{id:Number(id),tag_name:`v${version}`,draft:false,immutable:true,prerelease:false}};
}
export async function localServer(t,releases){
  const requests=[];const server=http.createServer((req,res)=>{
    requests.push(req.url);const u=new URL(req.url,'http://localhost'),p=u.pathname;let body;
    const asset=/\/releases\/assets\/(\d+)$/.exec(p),release=/\/releases\/(\d+)(\/assets)?$/.exec(p);
    if(asset){for(const r of releases){const index=r.assets.findIndex(a=>String(a.id)===asset[1]);if(index>=0)body=r.bodies[index];}}
    else if(release){const r=releases.find(r=>String(r.release.id)===release[1]);body=release[2]?r?.assets:r?.release;}
    else if(p.endsWith('/releases'))body=releases.map(r=>r.release);
    else if(p.includes('/git/ref/'))body={object:{type:'commit',sha:'b'.repeat(40)}};
    else body={id:1382745738,full_name:REPOSITORY.full_name};
    if(!body){res.statusCode=404;res.end();}else res.end(Buffer.isBuffer(body)?body:JSON.stringify(body));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {port:server.address().port,requests};
}
export async function cliChild(root,port,args,{fault=null,timeout=120000,kill=false}={}){
  const file=`${root}/host-${Date.now()}-${Math.random()}.json`;await fs.writeFile(file,JSON.stringify({port,args,fault}));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./distribution-cli-child.mjs',import.meta.url)),file],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});let out='',err='',killed=false;
    const start=Date.now(),timer=setTimeout(()=>{child.kill();reject(new Error('CLI child timeout'));},timeout);
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('message',m=>{if(kill&&m==='BOUNDARY'){killed=true;child.kill('SIGKILL');}});
    child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);resolve({code,out,err,killed,elapsed_ms:Date.now()-start,...(out?{body:JSON.parse(out)}:{})});});
  });
}
