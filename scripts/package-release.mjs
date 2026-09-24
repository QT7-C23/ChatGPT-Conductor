import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import yazl from 'yazl';
import {canonicalJson,validateManifest} from './distribution/contracts.mjs';
import {hash,canonicalPath} from './distribution/store.mjs';
import {REPOSITORY} from './distribution/source.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const dependencies={
  'buffer-crc32':{version:'1.0.0',files:['package.json','LICENSE','dist/index.cjs','dist/index.mjs']},
  pend:{version:'1.2.0',files:['package.json','LICENSE','index.js']},
  yauzl:{version:'3.4.0',files:['package.json','LICENSE','index.js','crc32.js','fd-slicer.js']},
  yazl:{version:'3.3.1',files:['package.json','LICENSE','index.js']},
};
const reject=()=>{throw new Error('Invalid locked package input');};
export async function packageFiles(root=ROOT){
  root=await canonicalPath(root);
  const list=JSON.parse(await fs.readFile(`${root}/scripts/distribution/product-files.json`,'utf8'));
  const gateFiles=new Set(['.gitattributes','.github/workflows/package-candidate.yml','.github/workflows/approve-release.yml','.github/workflows/prepare-release.yml','.github/workflows/publish-release.yml','.github/workflows/verify-published.yml','.github/workflows/verify.yml','.githooks/pre-commit',...['.github/workflows/verify.yml','.githooks/pre-commit','.gitignore'].map(p=>`tests/fixtures/v1.1.3/project-orchestrator/${p}`)]);
  if(!Array.isArray(list)||new Set(list).size!==list.length||list.some(p=>typeof p!=='string'||!/^([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(p)||!gateFiles.has(p)&&p.split('/').some(s=>s==='..'||s.startsWith('.'))||p.startsWith('node_modules/')))reject();
  const runtime=JSON.parse(await fs.readFile(`${root}/scripts/distribution/runtime-files.json`,'utf8'));
  const lock=JSON.parse(await fs.readFile(`${root}/package-lock.json`,'utf8'));
  const pkg=JSON.parse(await fs.readFile(`${root}/package.json`,'utf8'));
  if(canonicalJson(pkg.dependencies)!==canonicalJson({yauzl:'3.4.0',yazl:'3.3.1'})||canonicalJson(lock.packages[''].dependencies)!==canonicalJson(pkg.dependencies)||canonicalJson(Object.keys(lock.packages).sort())!==canonicalJson(['',...Object.keys(dependencies).map(n=>`node_modules/${n}`)].sort()))reject();
  const expectedDeps={yauzl:{pend:'~1.2.0'},yazl:{'buffer-crc32':'^1.0.0'},pend:{},'buffer-crc32':{}};
  for(const [name,d] of Object.entries(dependencies)){
    const entry=lock.packages[`node_modules/${name}`],installed=JSON.parse(await fs.readFile(`${root}/node_modules/${name}/package.json`,'utf8'));
    if(entry.version!==d.version||installed.version!==d.version||installed.name!==name||canonicalJson(entry.dependencies??{})!==canonicalJson(expectedDeps[name])||canonicalJson(installed.dependencies??{})!==canonicalJson(expectedDeps[name])||!entry.integrity?.startsWith('sha512-'))reject();
    list.push(...d.files.map(f=>`node_modules/${name}/${f}`));
  }
  list.sort();const files=[];
  if(canonicalJson(Object.keys(runtime).sort())!==canonicalJson(list.filter(p=>p.startsWith('node_modules/')).sort()))reject();
  for(const relative of list){const file=await canonicalPath(`${root}/${relative}`);if(file!==`${root}/${relative}`)reject();const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink())reject();const body=await fs.readFile(file);if(relative.startsWith('node_modules/')&&hash(body)!==runtime[relative])reject();files.push({path:relative,bytes:body.length,sha256:hash(body),body});}
  const skill=files.find(f=>f.path==='SKILL.md').body.toString('utf8');
  if(pkg.name!=='chatgpt-conductor'||pkg.version!=='1.2.0'||!/^name: chatgpt-conductor\r?$/m.test(skill)||!/^  version: ["']?1\.2\.0["']?\r?$/m.test(skill))reject();
  return files;
}
export async function buildCandidate({out,root=ROOT,sourceCommit=null}){
  if(sourceCommit!==null&&!/^[0-9a-f]{40}$/.test(sourceCommit))reject();
  const files=await packageFiles(root),zip=new yazl.ZipFile();
  for(const f of files)zip.addBuffer(f.body,`chatgpt-conductor/${f.path}`,{mtime:new Date('2000-01-01T00:00:00Z'),mode:0o100644,compress:true,compressionLevel:9});
  zip.end();const chunks=[];for await(const chunk of zip.outputStream)chunks.push(chunk);const bytes=Buffer.concat(chunks);
  await fs.mkdir(out,{recursive:true});
  const name='chatgpt-conductor-1.2.0.zip',payloadPath=path.resolve(out,name);
  const notes=await fs.readFile(path.join(root,'CHANGELOG.md'));
  const candidate={kind:'candidate',version:'1.2.0',source_commit:sourceCommit,payload:{name,bytes:bytes.length,sha256:hash(bytes),archive_root:'chatgpt-conductor',files:files.map(({body,...f})=>f)},changelog:{name:'CHANGELOG.md',bytes:notes.length,sha256:hash(notes)}};
  await fs.writeFile(payloadPath,bytes,{flag:'wx'});await fs.writeFile(path.join(out,'CHANGELOG.md'),notes,{flag:'wx'});
  await fs.writeFile(path.join(out,'payload-inventory.json'),canonicalJson(candidate.payload.files),{flag:'wx'});
  await fs.writeFile(path.join(out,'candidate.json'),canonicalJson(candidate),{flag:'wx'});
  return {...candidate,payload_path:payloadPath};
}
export const legacyRoutes=version=>[1,2].map(s=>({id:`po-legacy-schema${s}-v1`,from_profile:`po-legacy-schema${s}`,to_profile:'po-1.1.3',from_software_versions:[version],target_software_version:version,kind:'legacy-data',handler_id:'po-legacy-snapshot-v1',preconditions:['writers stopped; external effects reconciled; separately confirmed'],state_effect:'DISCUSS stays DISCUSS; all other phases return PLAN',authorization_effect:'authorization_inherited=false; explicit reauthorization required',rollback_mode:'snapshot',impact_summary:'Preserve legacy source and evidence; write approved new state destination'}));
export async function finalizeManifest({candidate,release,out}){
  if(candidate.kind!=='candidate'||!candidate.source_commit||release.source_commit!==candidate.source_commit||!/^\d+$/.test(release.release_id??'')||!['stable','preview'].includes(release.channel)||Object.keys(release).sort().join()!==['channel','release_id','source_commit'].sort().join())reject();
  const folder=path.dirname(candidate.payload_path??reject());
  for(const a of [candidate.payload,candidate.changelog]){const b=await fs.readFile(path.join(folder,a.name));if(b.length!==a.bytes||hash(b)!==a.sha256)reject();}
  const manifest=validateManifest({manifest_version:1,product:'chatgpt-conductor',version:candidate.version,channel:release.channel,repository:REPOSITORY,tag:`v${candidate.version}`,source_commit:release.source_commit,release_id:release.release_id,skill_id:'chatgpt-conductor',payload:candidate.payload,changelog:candidate.changelog,runtime:{node_majors:[22,24],platforms:['win32-x64','linux-x64'],min_manager_version:'1.2.0'},data_contract:{schema_version:2,profile:'po-1.1.3',read_profiles:['po-1.1.3'],write_profile:'po-1.1.3'},upgrade_from:['1.1.3'],migrations:legacyRoutes(candidate.version),verification:{profile:'conductor-node-verify-v1'},baseline_provenance:null});
  const raw=canonicalJson(manifest);await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(out,'release-manifest.json'),raw,{flag:'wx'});
  await fs.copyFile(path.join(folder,'CHANGELOG.md'),path.join(out,'CHANGELOG.md'),fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(out,'SHA256SUMS'),`${manifest.payload.sha256}  ${manifest.payload.name}\n${manifest.changelog.sha256}  CHANGELOG.md\n${hash(raw)}  release-manifest.json\n`,{flag:'wx'});
  return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [mode,...args]=process.argv.slice(2);if(mode==='candidate'&&args.length===2)console.log(JSON.stringify(await buildCandidate({out:args[0],sourceCommit:args[1]})));else if(mode==='manifest'&&args.length===3){const candidate=JSON.parse(await fs.readFile(args[0],'utf8'));candidate.payload_path=path.join(path.dirname(path.resolve(args[0])),candidate.payload.name);console.log(JSON.stringify(await finalizeManifest({candidate,release:JSON.parse(await fs.readFile(args[1],'utf8')),out:args[2]})));}else throw Error();}catch{console.error('Package input invalid or destination unavailable');process.exitCode=1;}
}
