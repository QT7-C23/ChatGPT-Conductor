import * as fs from 'node:fs/promises';
import path from 'node:path';
import { migrateSnapshot } from '../migration.mjs';
import { canonicalSha256, DistributionError } from './contracts.mjs';
import { readProject, validateProjectReferences } from './snapshot.mjs';
import { canonicalPath, exists, hash, inside } from './store.mjs';

const fail=message=>{throw new DistributionError('MIGRATION_BLOCKED',message);};

// Pure legacy transformation runs only on parsed copies. All source files and
// contract confirmation bytes are bound separately from the plan approval.
export async function prepareLegacyMigration({projects,requests}) {
  if(requests.length!==projects.filter(p=>p.profile!=='po-1.1.3').length)fail('One explicit request per legacy project required');
  const after=[],outputs=[];
  for(const project of projects) {
    if(project.profile==='po-1.1.3'){await readProject(project);after.push(structuredClone(project));continue;}
    await readProject(project,{allowLegacy:true});
    const matches=requests.filter(r=>r.project_id===project.project_id);
    if(matches.length!==1)fail('Missing or duplicate migration request');
    const request=matches[0];
    if(await canonicalPath(request.destination)!==request.destination||!inside(project.root_path,request.destination)||await exists(request.destination))fail('Migration requires an absent explicit state destination inside project');
    if(!(await fs.stat(path.dirname(request.destination))).isDirectory())fail('Migration destination parent must exist');
    const read=async file=>{
      if(file===null)return null;
      const record=project.files.find(f=>f.path===file);if(!record)fail('Migration input outside approved inventory');
      const bytes=await fs.readFile(await canonicalPath(file));
      if(bytes.length!==record.bytes||hash(bytes)!==record.sha256)fail('Migration input changed');
      return JSON.parse(bytes);
    };
    const input={snapshot:await read(project.state_path),packet:await read(request.packet_path),result:await read(request.result_path),review:await read(request.review_path),confirmation:await read(request.confirmation_path)};
    await validateProjectReferences(project,Object.values(input));
    const migrated=migrateSnapshot(structuredClone(input));
    if(migrated.status!=='migrated')fail(migrated.reasons.join('; '));
    const bytes=Buffer.from(JSON.stringify(migrated.snapshot));
    const output={path:request.destination,bytes:bytes.length,sha256:hash(bytes)};
    const bindings={...(project.bindings??{reference_roots:[],evidence:[]}),packet_path:request.packet_path,result_path:request.result_path,historical_source_path:project.state_path};
    if(request.review_path)bindings.historical_review_path=request.review_path;
    after.push({...structuredClone(project),state_path:request.destination,schema_version:2,profile:'po-1.1.3',bindings,files:[...project.files,output].sort((a,b)=>a.path.localeCompare(b.path))});
    outputs.push({path:request.destination,bytes});
  }
  if(new Set(requests.map(r=>r.project_id)).size!==requests.length)fail('Duplicate migration request');
  return {projects:after,outputs};
}

export async function validateMigrationPlan(plan) {
  const prepared=await prepareLegacyMigration({projects:plan.projects,requests:plan.data_change.migrations});
  if(canonicalSha256(prepared.projects)!==canonicalSha256(plan.data_change.after_projects))fail('Migrated output differs from approved after inventory');
  return prepared;
}
