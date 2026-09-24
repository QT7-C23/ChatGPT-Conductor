import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildCandidate,finalizeManifest} from '../scripts/package-release.mjs';

test('local release export carries project and dependency license notices in the actual payload',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'conductor-license-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const candidate=await buildCandidate({out:path.join(root,'candidate'),sourceCommit:'b'.repeat(40)});
  for(const name of ['LICENSE','THIRD-PARTY-NOTICES.md',...['yauzl','yazl','pend','buffer-crc32'].map(n=>`node_modules/${n}/LICENSE`)])assert.ok(candidate.payload.files.some(f=>f.path===name),`missing ${name}`);
  const {default:yauzl}=await import('yauzl');
  const bodies=await new Promise((resolve,reject)=>yauzl.open(candidate.payload_path,{lazyEntries:true},(error,zip)=>{
    if(error)return reject(error);const entries={};zip.on('error',reject);zip.on('end',()=>resolve(entries));zip.on('entry',entry=>zip.openReadStream(entry,(err,stream)=>{
      if(err)return reject(err);const chunks=[];stream.on('error',reject);stream.on('data',b=>chunks.push(b));stream.on('end',()=>{entries[entry.fileName]=Buffer.concat(chunks);zip.readEntry();});
    }));zip.readEntry();
  }));
  assert.equal(JSON.parse(bodies['chatgpt-conductor/package.json']).license,'MIT');
  assert.match(bodies['chatgpt-conductor/LICENSE'].toString(),/Permission is hereby granted, free of charge/);
  for(const name of ['LICENSE','THIRD-PARTY-NOTICES.md',...['yauzl','yazl','pend','buffer-crc32'].map(n=>`node_modules/${n}/LICENSE`)])assert.deepEqual(bodies[`chatgpt-conductor/${name}`],await fs.readFile(new URL(`../${name}`,import.meta.url)));
});
test('candidate is deterministic, first-boot complete and cannot impersonate a release',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'conductor-package-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const a=await buildCandidate({out:path.join(root,'a'),sourceCommit:'b'.repeat(40)}),b=await buildCandidate({out:path.join(root,'b'),sourceCommit:'b'.repeat(40)});
  assert.equal(a.payload.sha256,b.payload.sha256);assert.deepEqual(await fs.readFile(a.payload_path),await fs.readFile(b.payload_path));
  assert.equal(a.release_id,undefined);assert.equal(a.kind,'candidate');
  assert.ok(a.payload.files.some(f=>f.path==='node_modules/yauzl/index.js'));assert.ok(a.payload.files.some(f=>f.path==='node_modules/yazl/LICENSE'));
  assert.ok(!a.payload.files.some(f=>f.path.includes('.superpowers')||f.path==='release-manifest.json'));
  await assert.rejects(finalizeManifest({candidate:a,release:{}}));
  const manifest=await finalizeManifest({candidate:a,release:{release_id:'123',source_commit:'b'.repeat(40),channel:'stable'},out:path.join(root,'final')});assert.deepEqual(manifest.migrations.map(m=>m.from_profile),['po-legacy-schema1','po-legacy-schema2']);
  assert.equal(manifest.payload.sha256,a.payload.sha256);assert.ok((await fs.readFile(path.join(root,'final','SHA256SUMS'),'utf8')).includes('release-manifest.json'));
  await fs.appendFile(a.payload_path,'changed');await assert.rejects(finalizeManifest({candidate:a,release:{release_id:'124',source_commit:'b'.repeat(40),channel:'stable'},out:path.join(root,'tampered')}));
});
