import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { DistributionError, canonicalJson, canonicalSha256, validateJournal } from './contracts.mjs';
import { requireAuthenticatedBundle } from './source.mjs';

const fail = (code, message) => { throw new DistributionError(code, message); };
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const inside = (root, value) => {
  const normalize = s => process.platform === 'win32' ? s.toLowerCase() : s;
  return normalize(value) === normalize(root) || normalize(value).startsWith(`${normalize(root)}/`);
};
export async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function canonicalPath(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.startsWith('\\\\') || input.startsWith('//')) fail('UNSAFE_PATH','Unsafe absolute path');
  const raw = input.replaceAll('\\','/');
  const parts = raw.replace(/^[A-Za-z]:\//,'').replace(/^\//,'').split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) fail('UNSAFE_PATH','Unsafe path component');
  let current = path.parse(input).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('UNSAFE_PATH','Links and special files are unsupported');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let ancestor = current;
  const missing = [];
  while (!(await exists(ancestor))) { missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  return path.join(await fs.realpath(ancestor),...missing).replaceAll('\\','/');
}
export async function inventory(root) {
  root = await canonicalPath(root);
  const out = [];
  async function walk(directory) {
    for (const entry of (await fs.readdir(directory)).sort()) {
      const file = await canonicalPath(`${directory}/${entry}`);
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) await walk(file);
      else { const bytes = await fs.readFile(file); out.push({path:file,bytes:bytes.length,sha256:hash(bytes)}); }
    }
  }
  await walk(root);
  return out;
}
export async function assertInventory(root, files, {relative = false} = {}) {
  const actual = await inventory(root);
  const expected = files.map(f => ({...f,path:relative ? `${root}/${f.path}` : f.path}));
  const sorted = list => list.slice().sort((a,b) => a.path.localeCompare(b.path));
  if (canonicalSha256(sorted(actual)) !== canonicalSha256(sorted(expected))) fail('DIRTY_INPUT','File inventory changed');
  return actual;
}
async function nearestStat(file) {
  while (!(await exists(file))) file = path.dirname(file);
  return {root:file, stat:await fs.stat(file)};
}
export async function localVolume(root) {
  if (process.platform !== 'win32') return true;
  const drive = /^[A-Za-z]:/.exec(root)?.[0];
  if (!drive) fail('UNSUPPORTED_FILESYSTEM','Unknown Windows volume');
  const script = `$volume = New-Object System.IO.DriveInfo('${drive}/'); @{DriveType=[int]$volume.DriveType;FileSystem=$volume.DriveFormat} | ConvertTo-Json -Compress`;
  const executable = path.join(process.env.SystemRoot ?? 'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    const {stdout} = await promisify(execFile)(executable,['-NoProfile','-NonInteractive','-Command',script],{shell:false,windowsHide:true,timeout:15000,maxBuffer:4096});
    const value = JSON.parse(stdout);
    return value.DriveType === 3 && value.FileSystem === 'NTFS';
  } catch { fail('UNSUPPORTED_FILESYSTEM','Unable to verify local Windows filesystem'); }
}
export async function checkDevices({code, data, requiredCodeBytes = 0, requiredDataBytes = 0, statfs = fs.statfs, volume = localVolume}) {
  async function check(paths, bytes) {
    const roots = await Promise.all(paths.map(nearestStat));
    if (new Set(roots.map(x => x.stat.dev)).size > 1) fail('CROSS_DEVICE','Resource group spans devices');
    for (const {root} of roots) {
      const volume = await statfs(root);
      // Explicit local filesystem allowlist. Unknown filesystems are unsupported.
      const types = new Set([0x5346544e,0xef53,0x58465342,0x9123683e,0x01021994,0x794c7630]);
      if (!(process.platform === 'win32' && Number(volume.type) === 0) && !types.has(Number(volume.type))) fail('UNSUPPORTED_FILESYSTEM','Filesystem type is not supported');
      if (BigInt(volume.bavail) * BigInt(volume.bsize) < BigInt(bytes)) fail('INSUFFICIENT_SPACE','Insufficient transaction space');
    }
  }
  for (const p of [...code,...data]) if (!(await volume((await nearestStat(p)).root))) fail('UNSUPPORTED_FILESYSTEM','Network or unknown filesystem refused');
  const codeDevice = code.length ? (await nearestStat(code[0])).stat.dev : null;
  const dataDevice = data.length ? (await nearestStat(data[0])).stat.dev : null;
  await check(code,requiredCodeBytes + (codeDevice !== null && codeDevice === dataDevice ? requiredDataBytes : 0));
  await check(data,requiredDataBytes);
  return {durability:'process-crash',host_isolation:'same-os-user',power_loss_verified:false};
}

export async function createScopedStore({roots, fault = async () => {}}) {
  const scopes = await Promise.all(roots.map(canonicalPath));
  async function guard(file) {
    const canonical = await canonicalPath(file);
    if (!scopes.some(root => inside(root,canonical))) fail('OUTSIDE_SCOPE','Path outside filesystem scope');
    return canonical;
  }
  async function mkdir(file) { file = await guard(file); await fs.mkdir(file,{recursive:true,mode:0o700}); return file; }
  async function writeNew(file, bytes) {
    file = await guard(file); await fault('write',file);
    const handle = await fs.open(file,'wx',0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  async function writeJson(file, value, validate = () => {}) {
    validate(value); file = await guard(file);
    const temporary = `${file}.tmp-${randomUUID()}`;
    await writeNew(temporary,canonicalJson(value));
    await fault('json:after-temp',file);
    if (await exists(file)) {
      const old = JSON.parse(await fs.readFile(file,'utf8')); validate(old);
      const backup = `${file}.prev.tmp-${randomUUID()}`;
      await writeNew(backup,canonicalJson(old));
      await fs.rename(backup,await guard(`${file}.prev`));
      await fault('json:after-previous',file);
    }
    await fault('replace-json',file);
    await fs.rename(temporary,file);
    await fault('json:after-replace',file);
    // Windows does not support opening a directory for fsync. File sync and
    // previous-valid backup provide process-crash recovery, not power-loss proof.
    if (process.platform !== 'win32') { const dir = await fs.open(path.dirname(file),'r'); try { await dir.sync(); } finally { await dir.close(); } }
  }
  async function readJson(file, validate = () => {}) {
    const value = JSON.parse(await fs.readFile(await guard(file),'utf8')); validate(value); return value;
  }
  async function renameAbsent(source,destination) {
    source = await guard(source); destination = await guard(destination);
    if (await exists(destination)) fail('TARGET_EXISTS','Rename destination exists');
    await fault('rename',destination);
    await fs.rename(source,destination);
  }
  async function acquireLock(file, transactionId, recovery = false) {
    file = await guard(file);
    if (!recovery) await assertNoUnfinishedTransactions(path.dirname(file));
    const owner = {lock_version:1,transaction_id:transactionId,host:os.hostname(),pid:process.pid,started_at:new Date(Date.now()-process.uptime()*1000).toISOString(),nonce:randomUUID()};
    try { await writeNew(file,canonicalJson(owner)); } catch (error) { if (error.code === 'EEXIST') fail('LOCKED','Installation lock exists; explicit recovery required'); throw error; }
    return {owner, async release(phase) {
      if (!['SUCCEEDED','ABORTED','RESTORED'].includes(phase)) fail('LOCKED','Only terminal transactions release the lock');
      if (canonicalSha256(await readJson(file)) !== canonicalSha256(owner)) fail('LOCKED','Lock ownership changed');
      await fs.unlink(await guard(file));
    }};
  }
  async function recoverLock({file,journalFile,journal:providedJournal,allowTerminal = false,probe = probeLockOwner}) {
    file = await guard(file); journalFile = await guard(journalFile);
    const owner = await readJson(file,validateLockOwner);
    const journal = await readDurableJournal({readJson,guard},journalFile);
    if(providedJournal&&canonicalSha256(validateJournalScope(providedJournal))!==canonicalSha256(journal))fail('LOCKED','Recovery journal changed before takeover');
    if (journal.transaction_id !== owner.transaction_id || file !== `${journal.plan.control_path}/writer.lock` || journalFile !== `${journal.plan.control_path}/transactions/${hash(owner.transaction_id)}.json` || (!allowTerminal && ['SUCCEEDED','ABORTED','RESTORED'].includes(journal.phase))) fail('LOCKED','Lock does not bind an unfinished journal');
    if (await probe(owner) !== 'dead') fail('LOCKED','Live, unknown or reused process identity blocks recovery');
    const takeover = `${file}.takeover`;
    try { await writeNew(takeover,canonicalJson(owner)); } catch (error) { if (error.code === 'EEXIST') fail('LOCKED',`Recovery takeover requires operator review: preserve ${takeover}, ${file} and retained lock copies; verify owner termination before retry`); throw error; }
    try {
      if (canonicalSha256(await readJson(file,validateLockOwner)) !== canonicalSha256(owner) || await probe(owner) !== 'dead') fail('LOCKED','Lock owner changed');
      await renameAbsent(file,`${file}.retained-${owner.nonce}`);
      return await acquireLock(file,owner.transaction_id,true);
    } finally { await fs.unlink(await guard(takeover)); }
  }
  async function consumeApproval(control, receipt) {
    const directory = await mkdir(`${control}/approvals`);
    try { await writeNew(`${directory}/${hash(receipt.use_id)}.json`,canonicalJson(receipt)); }
    catch (error) { if (error.code === 'EEXIST') fail('APPROVAL_REPLAY','Approval was already consumed'); throw error; }
  }
  return {roots:scopes,guard,mkdir,writeNew,writeJson,readJson,renameAbsent,acquireLock:(file,transactionId)=>acquireLock(file,transactionId),recoverLock,consumeApproval,
    async copyNew(source,destination) {
      source = await canonicalPath(source); const bytes = await fs.readFile(source);
      await writeNew(destination,bytes);
      if (hash(await fs.readFile(await guard(destination))) !== hash(bytes)) fail('COPY_CORRUPT','Copied file failed readback');
      return {path:destination,bytes:bytes.length,sha256:hash(bytes)};
    },
    async unlink(file) { await fs.unlink(await guard(file)); },
  };
}

export function validateLockOwner(owner) {
  if (!owner || Object.keys(owner).sort().join() !== ['lock_version','transaction_id','host','pid','started_at','nonce'].sort().join() || owner.lock_version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.transaction_id !== 'string' || !owner.transaction_id || typeof owner.host !== 'string' || !Number.isFinite(Date.parse(owner.started_at)) || !/^[0-9a-f-]{36}$/.test(owner.nonce)) fail('LOCKED','Invalid lock owner');
  return owner;
}
export async function probeLockOwner(owner) {
  validateLockOwner(owner);
  if (owner.host !== os.hostname()) return 'unknown';
  try { process.kill(owner.pid,0); return 'alive-or-reused'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

export function validateJournalScope(journal) {
  validateJournal(journal);
  if(journal.actions.some((a,i)=>a.sequence!==i))fail('JOURNAL_SCOPE','Action sequence is not contiguous');
  const p = journal.plan;
  const permitted = value => inside(p.control_path,value) || inside(p.snapshot.path,value) || value === p.active_path || value === p.target_active_path || p.projects.some(project => project.files.some(f => f.path === value)) || p.data_change && (inside(p.data_change.stage_path,value)||p.data_change.resources.some(r=>r.path===value));
  for (const value of [...journal.paths,...journal.actions.flatMap(a => [a.source,a.destination].filter(Boolean))]) if (!permitted(value)) fail('JOURNAL_SCOPE','Journal action outside approved resources');
  return journal;
}

export async function transitionJournal({store,file,journal,phase}) {
  journal.phase = phase; journal.sequence++;
  await store.writeJson(file,journal,validateJournalScope);
}
export async function journalAction({store,file,journal,kind,source = null,destination,beforeSha256 = null,afterSha256 = null,fault = async () => {},run}) {
  const item = {sequence:journal.actions.length,kind,source,destination,before_sha256:beforeSha256,after_sha256:afterSha256,intent:true,completed:false};
  journal.actions.push(item);
  await transitionJournal({store,file,journal,phase:journal.phase});
  await fault('action:after-intent',item);
  await fault('action:before-action',item);
  const result = await run();
  await fault('action:after-action',item);
  await fault('action:before-completion',item);
  item.completed = true;
  await transitionJournal({store,file,journal,phase:journal.phase});
  await fault('action:after-completion',item);
  return result;
}

export async function persistAuthenticatedRelease({store,control,bundle,transactionId,managerRelease}) {
  requireAuthenticatedBundle(bundle,{payload:true});
  const root = `${control}/cache/${canonicalSha256(bundle.descriptor)}`;
  await store.mkdir(root);
  const record = {cache_version:1,descriptor:bundle.descriptor,transaction_id:transactionId,manager_release:managerRelease,proof:bundle.evidence.method};
  for (const [name,source] of [['manifest.json',bundle.evidence.manifestPath],['CHANGELOG.md',bundle.evidence.changelogPath],['payload.zip',bundle.payloadPath]]) {
    const dest = `${root}/${name}`;
    if (!(await exists(dest))) await store.copyNew(source,dest);
    if (hash(await fs.readFile(dest)) !== hash(await fs.readFile(source))) fail('CACHE_CONFLICT','Managed cache content differs');
  }
  if (await exists(`${root}/record.json`)) {
    try {
      // A descriptor's established authority is reusable. Do not replace it
      // with a transaction whose first journal may not yet be published.
      await authenticatedCacheReader({store,control}).readAuthenticatedRelease(bundle.descriptor);
      return root;
    } catch (error) {
      // A prior preparation can leave a record with no published history.
      // Only a fresh authenticated capability plus the byte checks above may
      // rebind that orphan. Invalid schemas or conflicting history still fail.
      if (error.code !== 'ENOENT') throw error;
      const previous=await store.readJson(`${root}/record.json`);
      const history=`${control}/transactions/${hash(previous.transaction_id)}.json`;
      if(await exists(history)||await exists(`${history}.prev`))throw error;
    }
  }
  await store.writeJson(`${root}/record.json`,record);
  return root;
}
export function authenticatedCacheReader({store,control}) {
  return {async readAuthenticatedRelease(expected) {
    const root = `${control}/cache/${canonicalSha256(expected)}`;
    const record = await store.readJson(`${root}/record.json`);
    if (Object.keys(record).sort().join() !== ['cache_version','descriptor','manager_release','proof','transaction_id'].sort().join() || record.cache_version !== 1 || !['github-release-attestation','trusted-local-record'].includes(record.proof) || typeof record.transaction_id !== 'string' || canonicalSha256(record.descriptor) !== canonicalSha256(expected)) fail('CACHE_UNTRUSTED','Invalid managed cache record');
    const journal = await readDurableJournal(store,`${control}/transactions/${hash(record.transaction_id)}.json`);
    if (journal.transaction_id !== record.transaction_id || canonicalSha256(journal.manager_release) !== canonicalSha256(record.manager_release) || ![journal.plan.target_release,journal.plan.current_release,journal.manager_release].filter(Boolean).some(r => canonicalSha256(r) === canonicalSha256(expected))) fail('CACHE_UNTRUSTED','Cache is not bound to transaction history');
    return {descriptor:record.descriptor,manifestPath:await store.guard(`${root}/manifest.json`),changelogPath:await store.guard(`${root}/CHANGELOG.md`),payloadPath:await store.guard(`${root}/payload.zip`)};
  }};
}

export async function checkPlanPaths(plan) {
  const control = await canonicalPath(plan.control_path);
  const active = await canonicalPath(plan.active_path);
  const target = await canonicalPath(plan.target_active_path);
  const base = path.posix.dirname(path.posix.dirname(control));
  if (control !== `${base}/.conductor/${plan.install_id}` || !/^[a-zA-Z0-9_-]+$/.test(plan.install_id) || target !== `${base}/skills/${plan.target_release.skill_id}` || active !== `${base}/skills/${plan.current_release?.skill_id ?? plan.target_release.skill_id}`) fail('LAYOUT','Invalid installation layout');
  const snapshot = await canonicalPath(plan.snapshot.path);
  if (control !== plan.control_path || active !== plan.active_path || target !== plan.target_active_path || snapshot !== plan.snapshot.path) fail('NONCANONICAL_PATH','Plan paths must be canonical');
  if (inside(control,snapshot) && !inside(`${control}/snapshots`,snapshot)) fail('OVERLAP','Snapshot overlaps control resources');
  for (const project of plan.projects) {
    for (const value of [project.root_path,...(project.bindings?.reference_roots ?? [])]) {
      const root = await canonicalPath(value);
      if (root !== value) fail('NONCANONICAL_PATH','Project root must be canonical');
      for (const other of [control,active,target,snapshot]) if (inside(root,other) || inside(other,root)) fail('OVERLAP','Project and transaction paths overlap');
    }
  }
  if ([active,target].some(p => inside(p,snapshot) || inside(snapshot,p)) || (inside(snapshot,control))) fail('OVERLAP','Snapshot and code paths overlap');
  for (let i=0;i<plan.projects.length;i++) for (let j=i+1;j<plan.projects.length;j++) if (inside(plan.projects[i].root_path,plan.projects[j].root_path) || inside(plan.projects[j].root_path,plan.projects[i].root_path)) fail('OVERLAP','Project roots overlap');
  if(plan.data_change){
    const d=plan.data_change;
    if(await canonicalPath(d.stage_path)!==d.stage_path)fail('NONCANONICAL_PATH','Data stage must be canonical');
    for(const other of [control,active,target,snapshot,...plan.projects.flatMap(p=>[p.root_path,...(p.bindings?.reference_roots??[])])])if(inside(other,d.stage_path)||inside(d.stage_path,other))fail('OVERLAP','Data stage overlaps live or snapshot scope');
    for(let i=0;i<d.resources.length;i++){const r=d.resources[i];
      if(await canonicalPath(r.path)!==r.path||!plan.projects.some((p,n)=>r.kind==='directory'?p.directories.includes(r.path)&&d.after_projects[n].directories.includes(r.path):[...p.files,...d.after_projects[n].files].some(f=>f.path===r.path)))fail('DATA_SCOPE','Data resource outside approved inventory');
      if(d.resources.some((x,n)=>n!==i&&(inside(x.path,r.path)||inside(r.path,x.path))))fail('OVERLAP','Data resources overlap');
    }
  }
  const dataRoots = plan.projects.flatMap(p => [p.root_path,...(p.bindings?.reference_roots ?? [])]);
  for (let i=0;i<dataRoots.length;i++) for (let j=i+1;j<dataRoots.length;j++) if (inside(dataRoots[i],dataRoots[j]) || inside(dataRoots[j],dataRoots[i])) fail('OVERLAP','Declared data roots overlap');
  return {control,active,target,snapshot};
}


export async function readDurableJournal(store,file) {
  let text;
  try { text=await fs.readFile(await store.guard(file),'utf8'); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  if(text!==undefined) {
    let value;
    try {value=JSON.parse(text);}catch{}
    if(value!==undefined)return validateJournalScope(value);
  }
  return store.readJson(`${file}.prev`,validateJournalScope);
}
async function assertNoUnfinishedTransactions(control) {
  const directory=`${control}/transactions`;
  if(!(await exists(directory)))return;
  for(const name of await fs.readdir(directory)) {
    if(!/^[a-f0-9]{64}\.json(?:\.prev)?$/.test(name))continue;
    let journal;
    try {journal=validateJournalScope(JSON.parse(await fs.readFile(`${directory}/${name}`,'utf8')));}
    catch {fail('LOCKED','Invalid transaction history requires recovery');}
    if(!['SUCCEEDED','ABORTED','RESTORED'].includes(journal.phase)) {
      // Previous records can precede a valid terminal latest record.
      if(name.endsWith('.prev')) {
        try {const latest=validateJournalScope(JSON.parse(await fs.readFile(`${directory}/${name.slice(0,-5)}`,'utf8')));if(['SUCCEEDED','ABORTED','RESTORED'].includes(latest.phase))continue;}catch{}
      }
      fail('LOCKED','Unfinished transaction requires explicit recovery');
    }
  }
}
