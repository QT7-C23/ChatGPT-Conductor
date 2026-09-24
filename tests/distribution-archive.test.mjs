import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractVerifiedPayload } from '../scripts/distribution/archive.mjs';
import { restoreAuthenticatedCache } from '../scripts/distribution/source.mjs';
import { fixture, zipBytes } from './helpers/distribution-fixtures.mjs';
const stage=()=>mkdtemp(path.join(tmpdir(),'conductor-extract-test-'));
async function full(f){return f.source.acquirePayload(await f.source.authenticateRelease('123'));}
function renameZip(bytes,name) {
  const original=Buffer.from('chatgpt-conductor/SKILL.md');
  assert.equal(Buffer.byteLength(name),original.length);
  const output=Buffer.from(bytes);let at=0;
  while((at=output.indexOf(original,at))>=0){output.write(name,at);at+=original.length;}
  return output;
}
test('forged authentication cannot extract',async()=>{await assert.rejects(extractVerifiedPayload({verified:true},{stagingParent:'.',name:'forged'}),{code:'UNAUTHENTICATED_BUNDLE'});});
test('real ZIP extracts exact inventory without executing candidate and trusted cache restores',async t=>{
  const f=await fixture(t);const b=await full(f);const parent=await stage();
  const result=await extractVerifiedPayload(b,{stagingParent:parent,name:'new'});
  assert.equal(await readFile(path.join(result.archiveRoot,'SKILL.md'),'utf8'),'hello');
  const restored=await restoreAuthenticatedCache({release:b.descriptor,store:{readAuthenticatedRelease:async()=>({descriptor:b.descriptor,manifestPath:b.evidence.manifestPath,changelogPath:b.evidence.changelogPath,payloadPath:b.payloadPath})}});
  assert.equal(restored.changelog,b.changelog);
  await writeFile(b.payloadPath,'tampered');
  await assert.rejects(extractVerifiedPayload(b,{stagingParent:parent,name:'tampered'}));
  assert.deepEqual(await readdir(parent),['new']);
});
test('existing staging evidence is never deleted or reused',async t=>{
  const f=await fixture(t);const b=await full(f);const parent=await stage();await mkdir(path.join(parent,'existing'));await writeFile(path.join(parent,'existing','evidence'),'preserve');
  await assert.rejects(extractVerifiedPayload(b,{stagingParent:parent,name:'existing'}));assert.equal(await readFile(path.join(parent,'existing','evidence'),'utf8'),'preserve');
});
test('crafted unsafe ZIP paths reject before output',async t=>{
  const valid=await zipBytes();
  for(const prefix of ['../','/','C:/','\\\\host\\','safe/../','safe/./','safe//','safe/NUL/','safe/a:/','safe/a./','safe/a /','safe/\x01/']) {
    const name=prefix+'x'.repeat(26-prefix.length);const f=await fixture(t,{zip:renameZip(valid,name)});const parent=await stage();
    await assert.rejects(extractVerifiedPayload(await full(f),{stagingParent:parent,name:'attack'}),undefined,prefix);
    assert.deepEqual(await readdir(parent),[]);
  }
});
test('extra, missing, duplicate, case collision, symlink and mismatched hash reject',async t=>{
  const original={name:'chatgpt-conductor/SKILL.md',body:'hello'};
  const cases=[
    {zip:await zipBytes([original,{name:'chatgpt-conductor/extra',body:'x'}])},
    {zip:await zipBytes([])},
    {zip:await zipBytes([original,original])},
    {zip:await zipBytes([original,{...original,name:'chatgpt-conductor/skill.md'}])},
    {zip:await zipBytes([{...original,mode:0o120777}])},
    {mutateManifest:m=>m.payload.files[0].sha256='c'.repeat(64)},
    {mutateManifest:m=>m.payload.files[0].bytes=51*1024*1024},
  ];
  for(const options of cases){const f=await fixture(t,options);const parent=await stage();await assert.rejects(extractVerifiedPayload(await full(f),{stagingParent:parent,name:'attack'}));}
});

test('special types, reparse flags, Unix link fields, file-parent and component-case conflicts reject',async t=>{
  const valid=await zipBytes(); const attacks=[];
  for(const kind of ['special','reparse','unixlink']) {
    const zip=Buffer.from(valid);const central=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    if(kind==='special')zip.writeUInt32LE((0o060644*65536)>>>0,central+38);
    if(kind==='reparse')zip.writeUInt32LE((zip.readUInt32LE(central+38)|0x400)>>>0,central+38);
    if(kind==='unixlink'){const extra=central+46+zip.readUInt16LE(central+28);assert.ok(zip.readUInt16LE(central+30)>=4);zip.writeUInt16LE(0x000d,extra);}
    attacks.push({zip});
  }
  attacks.push({mutateManifest:m=>m.payload.files.push({path:'SKILL.md/child',bytes:1,sha256:'c'.repeat(64)})});
  attacks.push({mutateManifest:m=>m.payload.files.push({path:'Folder/a',bytes:1,sha256:'c'.repeat(64)},{path:'folder/b',bytes:1,sha256:'c'.repeat(64)})});
  for(const options of attacks){const f=await fixture(t,options);const parent=await stage();await assert.rejects(extractVerifiedPayload(await full(f),{stagingParent:parent,name:'bad'}));assert.deepEqual(await readdir(parent),[]);}
});
