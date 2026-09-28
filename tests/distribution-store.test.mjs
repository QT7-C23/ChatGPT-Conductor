import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createScopedStore, canonicalPath, inventory } from '../scripts/distribution/store.mjs';

test('scoped store refuses escapes and existing rename targets, durable JSON reads back', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conductor-store-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const store = await createScopedStore({roots:[root]});
  await assert.rejects(store.mkdir(path.join(root,'..','outside')), /scope|path/i);
  await store.mkdir(path.join(root,'a'));
  await store.mkdir(path.join(root,'b'));
  await assert.rejects(store.renameAbsent(path.join(root,'a'),path.join(root,'b')), /exist/i);
  await store.writeJson(path.join(root,'record.json'), {x:1});
  await store.writeJson(path.join(root,'record.json'), {x:2});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'record.json'),'utf8')), {x:2});
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'record.json.prev'),'utf8')), {x:1});
  assert.equal((await inventory(path.join(root,'a'))).length,0);
  assert.equal(await canonicalPath(root),(await fs.realpath(root)).replaceAll('\\','/'));
});

test('two real child processes contend for one installation namespace',async t=>{
  const root = await canonicalPath(await fs.mkdtemp(path.join(os.tmpdir(),'conductor-process-lock-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const module = new URL('../scripts/distribution/store.mjs',import.meta.url).href;
  const script = `import {createScopedStore} from ${JSON.stringify(module)};
    const store=await createScopedStore({roots:[process.argv[1]]});
    try {const lock=await store.acquireLock(process.argv[1]+'/writer.lock','child-'+process.pid);
      console.log('acquired');process.stdin.once('data',async()=>{await lock.release('ABORTED');process.exit(0)});
    }catch(e){console.log(e.code);process.exit(0)}`;
  const children = [1,2].map(()=>spawn(process.execPath,['--input-type=module','-e',script,root],{shell:false,stdio:['pipe','pipe','pipe'],windowsHide:true}));
  t.after(()=>children.forEach(c=>c.kill()));
  const outcomes=await Promise.all(children.map(c=>new Promise((resolve,reject)=>{c.stdout.once('data',b=>resolve(b.toString().trim()));c.once('error',reject);})));
  assert.deepEqual(outcomes.slice().sort(),['LOCKED','acquired']);
  await Promise.all(children.map((c,i)=>new Promise((resolve,reject)=>{
    const exited=code=>{try{assert.equal(code,0);resolve();}catch(error){reject(error);}};
    if(c.exitCode!==null)return exited(c.exitCode);
    c.once('exit',exited);
    // The LOCKED contender exits naturally. Writing to its closing stdin races
    // with the exit notification on Windows and can raise EPIPE.
    if(outcomes[i]==='acquired'){c.stdin.once('error',reject);c.stdin.end('release');}
  })));
});

test('link ancestors are rejected and interrupted JSON replacement retains valid old record',async t=>{
  const root = await canonicalPath(await fs.mkdtemp(path.join(os.tmpdir(),'conductor-path-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(`${root}/real`);
  await fs.symlink(`${root}/real`,`${root}/link`,process.platform==='win32'?'junction':'dir');
  await assert.rejects(canonicalPath(`${root}/link/new`),/Links/);
  let interrupt=false;
  const store=await createScopedStore({roots:[root],fault:async point=>{if(interrupt && point==='replace-json')throw new Error('crash boundary');}});
  await store.writeJson(`${root}/journal.json`,{v:1});interrupt=true;
  await assert.rejects(store.writeJson(`${root}/journal.json`,{v:2}),/crash/);
  assert.deepEqual(await store.readJson(`${root}/journal.json`),{v:1});
  assert.deepEqual(await store.readJson(`${root}/journal.json.prev`),{v:1});
});

test('exclusive lock cannot be stolen by age or second writer', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'conductor-lock-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const store = await createScopedStore({roots:[root]});
  const lock = await store.acquireLock(path.join(root,'writer.lock'),'tx-one');
  await assert.rejects(store.acquireLock(path.join(root,'writer.lock'),'tx-two'), /lock/i);
  await lock.release('SUCCEEDED');
  const next = await store.acquireLock(path.join(root,'writer.lock'),'tx-two');
  await assert.rejects(next.release('PREPARED'),/terminal/i);
  await next.release('ABORTED');
});
