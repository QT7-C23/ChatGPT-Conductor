import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fixture,zipBytes,hash } from './distribution-fixtures.mjs';
const request=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const base=request.managerRoot;
const sourceModule=await import(pathToFileURL(`${base}/scripts/distribution/source.mjs`));
const disposers=[];const t={after(fn){disposers.push(fn);}};
try {
  if(request.mode==='recover') {
    // Any accidental source transport use fails immediately in this process.
    globalThis.fetch=()=>{throw new Error('network disabled');};
    const {recover}=await import(pathToFileURL(`${base}/scripts/distribution/recovery.mjs`));
    const result=await recover({control:request.plan.control_path,transactionId:'update-one',fault:async(point,item)=>{
      if(request.failRename&&point==='rename')throw Object.assign(new Error('busy fixture'),{code:'EPERM'});
      if(point===request.recoveryStop&&item?.kind==='replace'){process.stdout.write('READY\n');await new Promise(()=>{});}
      if(request.recoveryPhase&&point==='json:after-replace'&&item.endsWith('/transactions/'+hash('update-one')+'.json')&&JSON.parse(await fs.readFile(item)).phase===request.recoveryPhase){process.stdout.write('READY\n');await new Promise(()=>{});}
    }});
    process.stdout.write(JSON.stringify(result));
  }else if(request.mode==='data') {
    const {canonicalSha256,canonicalJson}=await import(pathToFileURL(`${base}/scripts/distribution/contracts.mjs`));
    const {createScopedStore,hash,transitionJournal}=await import(pathToFileURL(`${base}/scripts/distribution/store.mjs`));
    const {createSnapshot}=await import(pathToFileURL(`${base}/scripts/distribution/snapshot.mjs`));
    const {commitDataResources}=await import(pathToFileURL(`${base}/scripts/distribution/recovery.mjs`));
    const plan={...request.plan,operation:'migrate',target_release:request.plan.current_release,migration_ids:['synthetic-preserve-json']};
    const approval={...request.approval,operation:'migrate',plan_sha256:canonicalSha256(plan)};
    const control=plan.control_path,transactionId='update-one';
    const store=await createScopedStore({roots:[control,plan.snapshot.path,...plan.projects.map(p=>p.root_path)]});
    await store.acquireLock(`${control}/writer.lock`,transactionId);await store.consumeApproval(control,approval);
    const installation=await store.readJson(`${control}/installation.json`);
    const snapshot=await createSnapshot({store,plan,transactionId,installation});
    const journal={journal_version:1,transaction_id:transactionId,plan,approval,plan_sha256:canonicalSha256(plan),approval_sha256:canonicalSha256(approval),manager_release:installation.release,before_generation:1,after_generation:2,paths:[control,plan.active_path,plan.snapshot.path],before_resources:plan.current_files,after_resources:plan.current_files,snapshots:[{path:snapshot.path,bytes:snapshot.bytes,sha256:snapshot.sha256}],phase:'COMMITTING',sequence:0,actions:[],verification:[],result:null};
    const file=`${control}/transactions/${hash(transactionId)}.json`;await transitionJournal({store,file,journal,phase:'COMMITTING'});
    const replacements=[];
    for(const [n,f] of plan.projects.flatMap(p=>p.files).entries()) {
      const source=`${control}/stage/data-new-${n}`;await store.writeNew(source,Buffer.concat([await fs.readFile(f.path),Buffer.from(' ')]));replacements.push({source,destination:f.path});
    }
    let count=0;
    await commitDataResources({store,file,journal,replacements,fault:async point=>{if(point==='action:after-action'&&++count===request.dataStop){process.stdout.write('READY\n');await new Promise(()=>{});}}});
  }else{
    async function bundleFor(contents,version) {
      const zip=await zipBytes(Object.entries(contents).map(([name,body])=>({name:`chatgpt-conductor/${name}`,body:Buffer.from(body,'base64')})));
      const f=await fixture(t,{zip,sourceFactory:sourceModule.createReleaseSource,mutateRelease:r=>{r.tag_name=`v${version}`;},mutateManifest:m=>{m.version=version;m.tag=`v${version}`;m.payload.name=`chatgpt-conductor-${version}.zip`;m.upgrade_from=['1.2.0'];m.payload.files=Object.entries(contents).map(([path,b])=>({path,bytes:Buffer.from(b,'base64').length,sha256:hash(Buffer.from(b,'base64'))}));}});
      return {bundle:await f.source.acquirePayload(await f.source.authenticateRelease('123')),source:f.source};
    }
    const manager=await bundleFor(request.managerContents,'1.2.0');
    const target=await bundleFor(request.targetContents,request.mode==='install'?'1.2.0':'1.2.1');
    const {canonicalSha256}=await import(pathToFileURL(`${base}/scripts/distribution/contracts.mjs`));
    request.plan.target_release=target.bundle.descriptor;
    request.plan.changelog={body:target.bundle.changelog,sha256:target.bundle.descriptor.changelog_sha256};
    request.approval.plan_sha256=canonicalSha256(request.plan);
    const operation=request.mode==='install'?(await import(pathToFileURL(`${base}/scripts/distribution/transaction.mjs`))).install:(await import(pathToFileURL(`${base}/scripts/distribution/update.mjs`))).update;
    let matches=0;
    const result=await operation({...request,bundle:target.bundle,managerBundle:manager.bundle,source:{recheck:b=>b===target.bundle?target.source.recheck(b):manager.source.recheck(b)},transactionId:request.transactionId??'update-one',deviceOptions:{volume:async()=>true},fault:async(point,item)=>{
      if(point===request.stopPoint&&(!request.stopKind||item?.kind===request.stopKind)&&(!request.stopJournal||item===`${request.plan.control_path}/transactions/${hash('update-one')}.json`)&&(!request.stopReceipt||typeof item==='string'&&item.endsWith('.receipt.json'))) {
        if(matches++===(request.stopIndex??0)){process.stdout.write('READY\n');await new Promise(()=>{});}
      }
    }});
    process.stdout.write(JSON.stringify(result));
  }
}catch(error){process.stdout.write(JSON.stringify({error:error.code??error.message}));process.exitCode=4;}
finally{for(const dispose of disposers.toReversed())await dispose();}
