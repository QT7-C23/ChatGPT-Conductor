import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/distribution-fixtures.mjs';
import { createReleaseSource, LIMITS, requireAuthenticatedBundle } from '../scripts/distribution/source.mjs';
import { validateTransportUrl, runGh } from '../scripts/distribution/transport.mjs';
test('real HTTP and child process authenticate exact assets, recursive tag and raw notes', async t => {
  const f=await fixture(t); const found=await f.source.discover(); assert.equal(found.releases[0].release_id,'123');
  const b=await f.source.authenticateRelease('123'); assert.equal(b.changelog,'Exact notes\r\n'); assert.equal(b.descriptor.source_commit,'b'.repeat(40));
  assert.equal(b.payloadPath,null); const full=await f.source.acquirePayload(b); assert.ok(full.payloadPath.endsWith('.zip')); assert.equal(f.auth.length,4);
  assert.throws(()=>requireAuthenticatedBundle({...full}),{code:'UNAUTHENTICATED_BUNDLE'});
  await f.source.recheck(full); f.release.immutable=false; await assert.rejects(f.source.recheck(full));
});
test('authentication failure blocks and sanitizes executable output', async t => {
  const f=await fixture(t,{authFailure:true}); await assert.rejects(f.source.authenticateRelease('123'),e=>e.code==='AUTHENTICATION_FAILED'&&!e.message.includes('secret-token'));
  assert.equal(f.requests.some(r=>r.url.includes('/releases/assets/')),false);
  await assert.rejects(runGh([], {executable:'conductor-nonexistent-gh'}),{code:'AUTHENTICATION_FAILED'});
});
test('identity, tag, channel, hash and immutable mismatches fail closed', async t=>{
  for (const options of [{mutateRelease:r=>r.draft=true},{mutateRelease:r=>r.prerelease=true},{mutateManifest:m=>m.source_commit='c'.repeat(40)},{mutateManifest:m=>m.changelog.sha256='c'.repeat(64)}]) {
    const f=await fixture(t,options); await assert.rejects(f.source.authenticateRelease('123'));
  }
});
test('all release and asset pages are followed',async t=>{
  const f=await fixture(t,{handle:(req,res,{release,assets})=>{
    const u=new URL(req.url,'http://x'); const page=u.searchParams.get('page');
    if(u.pathname.endsWith('/releases')) {res.end(JSON.stringify(page==='1'?Array.from({length:100},(_,i)=>({...release,id:i+1})): [{...release,id:123}]));return true;}
    if(u.pathname.endsWith('/assets')) {res.end(JSON.stringify(page==='1'?Array.from({length:100},(_,i)=>({id:1000+i,name:`unused${i}`})):assets));return true;}
  }});
  assert.equal((await f.source.discover()).releases.length,101); await f.source.authenticateRelease('123');
  assert.ok(f.requests.some(r=>r.url.endsWith('assets?per_page=100&page=2')));
});
test('rate limits unavailable, host restrictions and streamed quotas enforced',async t=>{
  const f=await fixture(t,{handle:(req,res)=>{res.writeHead(429,{'retry-after':'60'});res.end();return true;}});
  assert.deepEqual(await f.source.discover(),{status:'unavailable',releases:[],reason:'GitHub request unavailable (429)',retryAfter:'60'});
  for(const url of ['http://api.github.com/x','https://evil.test/x','https://github.com:444/x','https://u:p@github.com/x']) assert.throws(()=>validateTransportUrl(url));
  const g=await fixture(t,{handle:(req,res)=>{res.write('12345');res.end('67890');return true;}});
  await assert.rejects(g.transport('https://api.github.com/x',{limit:4}),{code:'SOURCE_LIMIT'});
  assert.equal(LIMITS.zip,100*1024*1024); assert.equal(typeof createReleaseSource,'function');
});
test('cross-origin redirects remove all credentials permanently',async t=>{
  const f=await fixture(t,{handle:(req,res)=>{if(req.url==='/start'){res.writeHead(302,{location:'https://release-assets.githubusercontent.com/end'});res.end();}else{res.end('ok');}return true;}});
  await f.transport('https://api.github.com/start',{limit:10,headers:{authorization:'secret','x-token':'secret',cookie:'secret'}});
  assert.equal(f.requests[0].headers.authorization,'secret'); assert.equal(f.requests[0].headers.cookie,undefined);
  assert.equal(f.requests[1].headers.authorization,undefined);assert.equal(f.requests[1].headers['x-token'],undefined);
});
test('cyclic tag, wrong repository and changed API asset digest block',async t=>{
  const cycle=await fixture(t,{handle:(req,res)=>{if(req.url.includes('/git/tags/')){res.end(JSON.stringify({object:{type:'tag',sha:'a'.repeat(40)}}));return true;}}});
  await assert.rejects(cycle.source.authenticateRelease('123'));
  const wrong=await fixture(t,{handle:(req,res)=>{if(req.url==='/repos/QT7-C23/ChatGPT-Conductor'){res.end(JSON.stringify({id:123,full_name:'QT7-C23/ChatGPT-Conductor'}));return true;}}});
  await assert.rejects(wrong.source.discover());
  const f=await fixture(t);f.assets[0].digest='sha256:'+'c'.repeat(64);await assert.rejects(f.source.authenticateRelease('123'));
});
test('redirect loops stop at fixed bound and invalid destinations never requested',async t=>{
  const f=await fixture(t,{handle:(req,res)=>{res.writeHead(302,{location:'https://api.github.com/loop'});res.end();return true;}});
  await assert.rejects(f.transport('https://api.github.com/loop',{limit:10}),{code:'SOURCE_REDIRECT'});assert.equal(f.requests.length,6);
  const g=await fixture(t,{handle:(req,res)=>{res.writeHead(302,{location:'https://evil.test/asset'});res.end();return true;}});
  await assert.rejects(g.transport('https://api.github.com/start',{limit:10}),{code:'SOURCE_HOST'});assert.equal(g.requests.length,1);
});
test('public GitHub authentication pins child host and repository despite inherited overrides',async()=>{
  const { authenticateWithGh }=await import('../scripts/distribution/transport.mjs');
  const saved={GH_HOST:process.env.GH_HOST,GH_REPO:process.env.GH_REPO};
  process.env.GH_HOST='enterprise-fixture.invalid';process.env.GH_REPO='enterprise-fixture.invalid/other/repo';
  try {
    const environment=await runGh([],{executable:process.execPath,prefixArgs:['-e','process.stdout.write(JSON.stringify({host:process.env.GH_HOST,repo:process.env.GH_REPO??null}))','--']});
    assert.equal(environment.host,'github.com');assert.equal(environment.repo,null);
    for(const file of [undefined,'C:/synthetic/payload.zip']) {
      const result=await authenticateWithGh({tag:'v1.2.0',file},{executable:process.execPath,prefixArgs:['-e','process.stdout.write(JSON.stringify({args:process.argv.slice(1),host:process.env.GH_HOST,repo:process.env.GH_REPO??null}))','--']});
      assert.equal(result.host,'github.com');assert.equal(result.repo,null);
      assert.deepEqual(result.args,['release',file?'verify-asset':'verify','v1.2.0',...(file?[file]:[]),'--repo','github.com/QT7-C23/ChatGPT-Conductor','--format','json']);
    }
  } finally {for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test('authenticated BOM changelog preserves exact raw hash online and from cache',async t=>{
  const { restoreAuthenticatedCache }=await import('../scripts/distribution/source.mjs');
  const { hash }=await import('./helpers/distribution-fixtures.mjs');
  const notes=Buffer.from('\ufeffExact notes\r\n');
  const f=await fixture(t,{notes});const online=await f.source.acquirePayload(await f.source.authenticateRelease('123'));
  const cached=await restoreAuthenticatedCache({release:online.descriptor,store:{readAuthenticatedRelease:async()=>({descriptor:online.descriptor,manifestPath:online.evidence.manifestPath,changelogPath:online.evidence.changelogPath,payloadPath:online.payloadPath})}});
  for(const bundle of [online,cached]){assert.equal(bundle.changelog.codePointAt(0),0xfeff);assert.deepEqual(Buffer.from(bundle.changelog,'utf8'),notes);assert.equal(hash(bundle.changelog),bundle.descriptor.changelog_sha256);}
});
