import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalSha256, validateInstallationRecord, DistributionError } from './contracts.mjs';
import { validateApprovalForPlan } from './plan.mjs';
import { requireAuthenticatedBundle } from './source.mjs';
import { extractVerifiedPayload } from './archive.mjs';
import { verifyCandidate } from './verify.mjs';
import { createSnapshot, readProject } from './snapshot.mjs';
import { resourceHash } from './recovery.mjs';
import { createScopedStore, checkPlanPaths, checkDevices, exists, hash, inside, canonicalPath, assertInventory, transitionJournal, journalAction, persistAuthenticatedRelease } from './store.mjs';

const fail = (code,message) => { throw new DistributionError(code,message); };
export async function install({plan,approval,bundle,managerBundle,source,store:providedStore,verify = verifyCandidate,transactionId = randomUUID(),fault = async () => {},snapshotOptions = {},deviceOptions = {}}) {
  // Capture caller objects before asynchronous boundaries; receipt binds these bytes.
  plan = structuredClone(plan); approval = structuredClone(approval);
  validateApprovalForPlan(plan,approval);
  if (plan.operation !== 'install' || plan.current_release !== null || plan.generation !== 0 || plan.current_files.length) fail('INSTALL_STATE','Initial install requires absent prestate');
  requireAuthenticatedBundle(bundle,{payload:true});
  requireAuthenticatedBundle(managerBundle,{payload:true});
  if (canonicalSha256(bundle.descriptor) !== canonicalSha256(plan.target_release) || managerBundle.descriptor.version !== '1.2.0') fail('RELEASE_CHANGED','Target or manager identity differs');
  const paths = await checkPlanPaths(plan);
  const running = await canonicalPath(fileURLToPath(import.meta.url));
  if (inside(paths.active,running) || inside(paths.target,running)) fail('RUNNER_LOCATION','Use trusted manager handoff outside replaced directories');
  const runningRoot = await canonicalPath(fileURLToPath(new URL('../../',import.meta.url)).replace(/[\\/]$/,''));
  try { await assertInventory(runningRoot,managerBundle.manifest.payload.files,{relative:true}); }
  catch { fail('MANAGER_IDENTITY','Running manager inventory differs from authenticated manager bundle; authenticated handoff required'); }
  if (await exists(paths.target) || await exists(`${paths.control}/installation.json`)) fail('TARGET_EXISTS','Install target or registration already exists');
  const store = providedStore ?? await createScopedStore({roots:[paths.control,path.dirname(paths.target),paths.snapshot],fault});
  await store.mkdir(paths.control);
  const lock = await store.acquireLock(`${paths.control}/writer.lock`,transactionId);
  let journal = null, journalFile = null, activated = false, installation = null;
  const writeJournal = async phase => {
    await transitionJournal({store,file:journalFile,journal,phase});
  };
  async function action(kind,sourcePath,destination,run,afterSha256 = null) {
    const beforeSha256=kind==='move'?await resourceHash(sourcePath):null;
    return journalAction({store,file:journalFile,journal,kind,source:sourcePath,destination,run,beforeSha256,afterSha256:beforeSha256??afterSha256,fault});
  }
  try {
    validateApprovalForPlan(plan,approval);
    await checkPlanPaths(plan);
    if (await exists(paths.target) || await exists(`${paths.control}/installation.json`)) fail('TARGET_EXISTS','Install target or registration changed');
    await Promise.all(plan.projects.map(readProject));
    for (const original of [bundle,managerBundle]) {
      const fresh = await source.recheck(original);
      requireAuthenticatedBundle(fresh);
      if (canonicalSha256(fresh.descriptor) !== canonicalSha256(original.descriptor)) fail('RELEASE_CHANGED','Release changed at apply boundary');
    }
    await store.consumeApproval(paths.control,approval);
    await store.mkdir(`${paths.control}/transactions`);
    journalFile = `${paths.control}/transactions/${hash(transactionId)}.json`;
    if (await exists(journalFile)) fail('TRANSACTION_EXISTS','Transaction ID already exists');
    journal = {journal_version:1,transaction_id:transactionId,plan,approval,plan_sha256:canonicalSha256(plan),approval_sha256:canonicalSha256(approval),manager_release:managerBundle.descriptor,before_generation:0,after_generation:1,paths:[paths.control,paths.target,paths.snapshot],before_resources:[],after_resources:[],snapshots:[],phase:'APPROVED',sequence:0,actions:[],verification:[],result:null};
    await writeJournal('APPROVED');
    const codeBytes = bundle.manifest.payload.files.reduce((n,f) => n+f.bytes,0);
    const managerBytes = managerBundle.manifest.payload.files.reduce((n,f) => n+f.bytes,0);
    const dataBytes = plan.projects.flatMap(p => p.files).reduce((n,f) => n+f.bytes,0);
    await checkDevices({code:[paths.control,paths.target],data:[paths.snapshot,...plan.projects.flatMap(p => [p.root_path,...(p.bindings?.reference_roots ?? [])])],requiredCodeBytes:codeBytes*3+managerBytes*2+bundle.manifest.payload.bytes+managerBundle.manifest.payload.bytes,requiredDataBytes:Math.max(plan.snapshot.capacity_bytes,dataBytes*3+65536),...deviceOptions});
    await persistAuthenticatedRelease({store,control:paths.control,bundle,transactionId,managerRelease:managerBundle.descriptor});
    await persistAuthenticatedRelease({store,control:paths.control,bundle:managerBundle,transactionId,managerRelease:managerBundle.descriptor});
    const stageParent = await store.mkdir(`${paths.control}/stage`);
    const managerParent = await store.mkdir(`${paths.control}/manager`);
    const managerName = canonicalSha256(managerBundle.descriptor);
    const managerRoot = `${managerParent}/${managerName}/${managerBundle.manifest.skill_id}`;
    if (!(await exists(`${managerParent}/${managerName}`))) await extractVerifiedPayload(managerBundle,{stagingParent:managerParent,name:managerName});
    await assertInventory(managerRoot,managerBundle.manifest.payload.files,{relative:true});
    if (!managerBundle.manifest.payload.files.some(f => f.path === 'scripts/distribution/transaction.mjs')) fail('MANAGER_MISSING','Authenticated manager bundle lacks transaction manager');
    await verify({bundle:managerBundle,root:managerRoot,managerVersion:managerBundle.manifest.version});
    await writeJournal('PREPARED');
    let snapshot;
    await action('snapshot',null,paths.snapshot,async () => { snapshot = await createSnapshot({store,plan,transactionId,...snapshotOptions}); });
    journal.snapshots = [{path:snapshot.path,bytes:snapshot.bytes,sha256:snapshot.sha256}];
    await writeJournal('SNAPSHOTTED');
    const candidate = await extractVerifiedPayload(bundle,{stagingParent:stageParent,name:hash(transactionId)});
    const candidateRoot = await canonicalPath(candidate.archiveRoot);
    await writeJournal('STAGED');
    await verify({bundle,root:candidateRoot,managerVersion:managerBundle.manifest.version});
    journal.verification.push('conductor-node-verify-v1');
    await writeJournal('VERIFIED');
    validateApprovalForPlan(plan,approval);
    await checkPlanPaths(plan);
    await Promise.all(plan.projects.map(readProject));
    await assertInventory(candidateRoot,bundle.manifest.payload.files,{relative:true});
    await assertInventory(managerRoot,managerBundle.manifest.payload.files,{relative:true});
    await checkDevices({code:[paths.control,paths.target],data:[paths.snapshot,...plan.projects.flatMap(p => [p.root_path,...(p.bindings?.reference_roots ?? [])])],...deviceOptions});
    if (await exists(paths.target) || await exists(`${paths.control}/installation.json`)) fail('TARGET_EXISTS','Install destination changed');
    await store.mkdir(path.dirname(paths.target));
    await writeJournal('COMMITTING');
    await action('move',candidateRoot,paths.target,async () => { await store.renameAbsent(candidateRoot,paths.target); activated = true; });
    installation = {installation_version:1,install_id:plan.install_id,manager_version:managerBundle.manifest.version,generation:1,channel:plan.channel,scope:plan.scope,active_path:paths.target,control_path:paths.control,release:bundle.descriptor,projects:plan.projects,last_transaction_id:transactionId,last_snapshot_path:paths.snapshot};
    await action('write',null,`${paths.control}/installation.json`,async () => {
      validateInstallationRecord(installation);
      await store.writeNew(`${paths.control}/installation.json`,JSON.stringify(installation));
    },hash(JSON.stringify(installation)));
    await fault('after-registration',paths.target);
    journal.after_resources = await assertInventory(paths.target,bundle.manifest.payload.files,{relative:true});
    if (canonicalSha256(await store.readJson(`${paths.control}/installation.json`,validateInstallationRecord)) !== canonicalSha256(installation)) fail('REGISTRATION_CHANGED','Registration readback differs');
    await Promise.all(plan.projects.map(readProject));
    await writeJournal('COMMITTED');
    const receipt = {transaction_id:transactionId,installation,snapshot_path:paths.snapshot,manager_path:managerRoot,reload_required:true,durability:'process-crash',power_loss_verified:false};
    await store.writeJson(`${paths.control}/transactions/${hash(transactionId)}.receipt.json`,receipt);
    journal.result = 'Installed; reload Skill'; await writeJournal('SUCCEEDED');
    await lock.release('SUCCEEDED'); return receipt;
  } catch (error) {
    if (!journal) { await lock.release('ABORTED'); throw error; }
    try {
      if (activated) {
        await writeJournal('RECOVERING');
        // Other project writers do not share our lock. Preserve their bytes and
        // require recovery if the approved data state cannot be established.
        await Promise.all(plan.projects.map(readProject));
        // Never delete/replace user-created files after candidate activation.
        await assertInventory(paths.target,bundle.manifest.payload.files,{relative:true});
        const retained = `${paths.control}/stage/${hash(transactionId)}-failed`;
        await action('move',paths.target,retained,() => store.renameAbsent(paths.target,retained));
        if (await exists(`${paths.control}/installation.json`)) {
          const intended = journal.actions.find(a => a.kind === 'write' && a.destination === `${paths.control}/installation.json` && a.intent);
          const record = await store.readJson(`${paths.control}/installation.json`,validateInstallationRecord);
          const bytes = await readFile(await store.guard(`${paths.control}/installation.json`));
          if (!intended || installation === null || hash(bytes) !== intended.after_sha256 || canonicalSha256(record) !== canonicalSha256(installation)) fail('REGISTRATION_CHANGED','Registration changed during recovery');
          await action('move',`${paths.control}/installation.json`,`${paths.control}/transactions/${hash(transactionId)}.failed-installation.json`,() => store.renameAbsent(`${paths.control}/installation.json`,`${paths.control}/transactions/${hash(transactionId)}.failed-installation.json`));
        }
        if (await exists(paths.target) || await exists(`${paths.control}/installation.json`)) fail('RESTORE_INCOMPLETE','Absent installation prestate was not restored');
        journal.result = error.code ?? 'INSTALL_FAILED'; await writeJournal('RESTORED'); await lock.release('RESTORED');
      } else { journal.result = error.code ?? 'INSTALL_FAILED'; await writeJournal('ABORTED'); await lock.release('ABORTED'); }
    } catch { journal.phase = 'RECOVERY_REQUIRED'; journal.result = 'Recovery requires validated journal and retained lock'; try { await writeJournal('RECOVERY_REQUIRED'); } catch { /* Prior durable journal and lock are the recovery boundary. */ } }
    throw error;
  }
}
