// Synthetic GitHub/gh protocol fixtures; these do not assert real GitHub attestations.
import http from 'node:http';
import { createHash } from 'node:crypto';
import yazl from 'yazl';
import { createTransport, runGh } from '../../scripts/distribution/transport.mjs';
import { createReleaseSource, REPOSITORY } from '../../scripts/distribution/source.mjs';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function zipBytes(entries = [{ name: 'chatgpt-conductor/SKILL.md', body: 'hello' }]) {
  const zip = new yazl.ZipFile();
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.body), entry.name, { mode: entry.mode ?? 0o100644 });
  zip.end(); const chunks = []; for await (const chunk of zip.outputStream) chunks.push(chunk); return Buffer.concat(chunks);
}
export async function fixture(t, { zip = null, mutateManifest = () => {}, mutateRelease = () => {}, handle = null, authFailure = false, notes = Buffer.from('Exact notes\r\n'), sourceFactory = createReleaseSource } = {}) {
  zip ??= await zipBytes();
  const manifest = { manifest_version:1, product:'chatgpt-conductor', version:'1.3.0', channel:'stable', repository:REPOSITORY, tag:'v1.3.0', source_commit:'b'.repeat(40), release_id:'123', skill_id:'chatgpt-conductor', payload:{ name:'chatgpt-conductor-1.3.0.zip', bytes:zip.length, sha256:hash(zip), archive_root:'chatgpt-conductor', files:[{path:'SKILL.md',bytes:5,sha256:hash('hello')}] }, changelog:{name:'CHANGELOG.md',bytes:notes.length,sha256:hash(notes)}, runtime:{node_majors:[22,24],platforms:['win32-x64','linux-x64'],min_manager_version:'1.3.0'},data_contract:{schema_version:2,profile:'po-1.1.3',read_profiles:['po-1.1.3'],write_profile:'po-1.1.3'},upgrade_from:['1.1.3'],migrations:[],verification:{profile:'conductor-node-verify-v1'},baseline_provenance:null };
  mutateManifest(manifest);
  const raw = Buffer.from(JSON.stringify(manifest));
  const contents = new Map([['1',raw],['2',notes],['3',zip]]);
  const names = ['release-manifest.json','CHANGELOG.md',manifest.payload.name];
  const assets = [...contents].map(([id,body],i) => ({id:Number(id),name:names[i],state:'uploaded',size:body.length,digest:`sha256:${hash(body)}`}));
  const release = {id:123,tag_name:'v1.3.0',draft:false,immutable:true,prerelease:false,target_commitish:'ignored'};
  mutateRelease(release);
  const requests = []; const auth = [];
  const server = http.createServer((req,res) => {
    requests.push({url:req.url,headers:req.headers});
    if (handle?.(req,res,{assets,release})) return;
    const url = new URL(req.url,'http://localhost'); const p = url.pathname;
    let body;
    if (p.endsWith('/releases/123/assets')) body=assets;
    else if (p.includes('/releases/assets/')) body=contents.get(p.split('/').at(-1));
    else if (p.endsWith('/releases/123')) body=release;
    else if (p.endsWith('/releases')) body=[release];
    else if (p.includes('/git/ref/')) body={object:{type:'tag',sha:'a'.repeat(40)}};
    else if (p.includes('/git/tags/')) body={object:{type:'commit',sha:'b'.repeat(40)}};
    else body={id:1382745738,full_name:REPOSITORY.full_name};
    if (!body) {res.writeHead(404);res.end();return;}
    res.end(Buffer.isBuffer(body)?body:JSON.stringify(body));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const transport=createTransport({request:(url,options,callback)=>http.request(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,options,callback)});
  const authenticate=async input=>{
    auth.push(input);
    return runGh(['release',input.file?'verify-asset':'verify',input.tag,...(input.file?[input.file]:[]),'--repo',REPOSITORY.full_name,'--format','json'],{executable:process.execPath,prefixArgs:['-e',authFailure?'process.stderr.write("secret-token");process.exit(1)':'process.stdout.write(JSON.stringify({arguments:process.argv.slice(1)}))','--']});
  };
  return { source:sourceFactory({transport,authenticate}), transport, manifest, release, auth, requests, contents, assets };
}
