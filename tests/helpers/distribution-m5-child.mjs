import * as fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const request=JSON.parse(await fs.readFile(process.argv[2]));
try{
  const root=request.managerRoot,load=name=>import(pathToFileURL(`${root}/scripts/distribution/${name}.mjs`));
  if(request.recover){const {recover}=await load('recovery');process.stdout.write(JSON.stringify(await recover({control:request.plan.control_path,transactionId:request.plan.plan_id})));}
  else{
    const {createScopedStore,authenticatedCacheReader}=await load('store');const {restoreAuthenticatedCache}=await load('source');
    const store=await createScopedStore({roots:[request.plan.control_path]});const cache=authenticatedCacheReader({store,control:request.plan.control_path});
    const bundle=await restoreAuthenticatedCache({store:cache,release:request.plan.target_release});const managerBundle=await restoreAuthenticatedCache({store:cache,release:request.manager_release});
    const api=await load('update');let count=0;
    const result=await api[request.plan.operation]({...request,bundle,managerBundle,source:{recheck:async b=>b},transactionId:request.plan.plan_id,deviceOptions:{volume:async()=>true},fault:async(point,item)=>{
      if(point===request.stopPoint&&(!request.stopKind||item?.kind===request.stopKind)&&count++===(request.stopIndex??0)){process.stdout.write('READY\n');await new Promise(()=>{});}
    }});process.stdout.write(JSON.stringify(result));
  }
}catch(error){process.stdout.write(JSON.stringify({error:error.code??error.message,detail:error.message}));process.exitCode=4;}
