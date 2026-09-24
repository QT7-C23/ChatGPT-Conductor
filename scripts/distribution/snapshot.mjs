import * as fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256, DistributionError, validateProjectInventory, validateOperationPlan } from './contracts.mjs';
import { validateSnapshot, packetIdentity, resultDigest, validateResult, validateReview, validateExecution } from '../contracts.mjs';
import { canonicalPath, inventory, hash, exists, inside } from './store.mjs';

const fail = message => { throw new DistributionError('SNAPSHOT_INVALID',message); };
const sorted = list => list.slice().sort((a,b) => a.path.localeCompare(b.path));
async function readObject(file) { return JSON.parse(await fs.readFile(await canonicalPath(file),'utf8')); }
export async function readProject(project,{allowLegacy=false}={}) {
  validateProjectInventory(project);
  const declared = new Map(project.files.map(f => [f.path,f]));
  const actual = new Map();
  for (const file of project.files) {
    const canonical = await canonicalPath(file.path);
    if (canonical !== file.path) fail('Project paths must be canonical');
    const bytes = await fs.readFile(canonical);
    actual.set(canonical,{path:canonical,bytes:bytes.length,sha256:hash(bytes)});
  }
  const directories = [];
  async function readDirectories(directory) {
    await canonicalPath(directory); directories.push(directory);
    for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
      if (entry.isDirectory()) await readDirectories(`${directory}/${entry.name}`);
      else await canonicalPath(`${directory}/${entry.name}`);
    }
  }
  for (const directory of project.directories) {
    await readDirectories(directory);
    for (const file of await inventory(directory)) actual.set(file.path,file);
  }
  if (canonicalSha256(sorted([...actual.values()])) !== canonicalSha256(sorted([...declared.values()]))) fail('Project inventory changed');
  const state = await readObject(project.state_path);
  if(project.profile!=='po-1.1.3') {
    if(!allowLegacy||![1,2].includes(state.schema_version)||Object.hasOwn(state,'lifecycle')||state.schema_version!==project.schema_version||state.project_id!==project.project_id)fail('Legacy state requires explicit migration; existing lifecycle cannot be reset');
    return {project_id:project.project_id,profile:project.profile,schema_version:state.schema_version,revision:state.revision,lifecycle:null,files:sorted([...actual.values()]),directories:[...new Set(directories)].sort(),bindings:project.bindings??null};
  }
  validateSnapshot(state);
  if (state.project_id !== project.project_id || state.schema_version !== project.schema_version || project.profile !== 'po-1.1.3') fail('Project profile mismatch');
  const bindings = project.bindings;
  let packet = null, result = null;
  const historical = state.migration_record?.authorization_inherited === false && state.active_packet?.lifecycle < state.lifecycle;
  if (state.active_packet !== null) {
    if (!bindings?.packet_path || !declared.has(bindings.packet_path)) fail('Required packet binding missing');
    packet = await readObject(bindings.packet_path);
    if (historical) {
      const expected = {...packetIdentity({...packet,lifecycle:state.active_packet.lifecycle}),content_sha256:resultDigest(packet)};
      if (canonicalSha256(expected) !== canonicalSha256(state.active_packet) || resultDigest(packet) !== state.migration_record.packet_sha256) fail('Historical packet identity differs');
    } else {
      if (state.active_packet.lifecycle === state.lifecycle) validateExecution(packet,state);
      if (canonicalSha256(packetIdentity(packet)) !== canonicalSha256(state.active_packet)) fail('Packet identity differs');
    }
  }
  if (state.result_sha256 !== null) {
    if (!packet || !bindings?.result_path || !declared.has(bindings.result_path)) fail('Required result binding missing');
    result = await readObject(bindings.result_path);
    validateResult(result,packet);
    if (resultDigest(result) !== state.result_sha256) fail('Result identity differs');
  }
  if (state.review_record && packet && result && !Object.hasOwn(state.review_record,'inherited_requirement')) validateReview(state.review_record,packet,result);
  const historicalEvidence=[];
  if (state.migration_record) {
    for (const [digestKey,pathKey] of [['source_sha256','historical_source_path'],['result_sha256','result_path'],['review_sha256','historical_review_path']]) {
      if (state.migration_record[digestKey] === null) continue;
      const bound = bindings?.[pathKey];
      if (!bound || !declared.has(bound)) fail('Historical migration evidence missing or changed');
      const evidence=await readObject(bound);
      if(resultDigest(evidence)!==state.migration_record[digestKey])fail('Historical migration evidence missing or changed');
      historicalEvidence.push(evidence);
    }
  }
  await validateProjectReferences(project,[packet,result,state.review_record,state.revision_reviews,state.migration_record,...historicalEvidence]);
  return {project_id:project.project_id,profile:project.profile,schema_version:state.schema_version,revision:state.revision,lifecycle:state.lifecycle,files:sorted([...actual.values()]),directories:[...new Set(directories)].sort(),bindings:bindings ?? null};
}

export async function validateProjectReferences(project,values) {
  const declared=new Map(project.files.map(f=>[f.path,f])),bindings=project.bindings;
  // Every evidence-bearing contract field has an explicit binding. Human prose
  // remains prose; a binding records the file that substantiates that exact text.
  const references = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key,item] of Object.entries(value)) {
      if (['ref','evidence','evidence_ref'].includes(key) && typeof item === 'string' && item.length) references.add(item);
      else if (typeof item === 'object') collect(item);
    }
  }
  values.forEach(collect);
  for (const ref of references) {
    const matches = bindings?.evidence.filter(e => e.ref === ref) ?? [];
    if (matches.length !== 1) fail('Required evidence binding missing or ambiguous');
    const e = matches[0];
    if (!declared.has(e.path) || !inside(e.root_path,e.path)) fail('Evidence is not inventoried');
    if (e.resolution === 'relative') {
      if (path.isAbsolute(ref)) fail('Relative evidence has an absolute reference');
      const resolved = path.resolve(e.root_path,ref).replaceAll('\\','/');
      if (resolved !== e.path) fail('Evidence relative resolution changed');
    }
    if (e.resolution === 'absolute' && await canonicalPath(ref) !== e.path) fail('Absolute evidence resolution changed');
  }
}

export async function createSnapshot({store,plan,transactionId,installation = null,afterCopy = async () => {}}) {
  validateOperationPlan(plan);
  const root = await store.guard(plan.snapshot.path);
  if (await exists(root)) fail('Snapshot target already exists');
  const before = await Promise.all(plan.projects.map(p=>readProject(p,{allowLegacy:plan.operation==='migrate'})));
  await store.mkdir(root);
  const copies = [];
  for (let i=0;i<plan.projects.length;i++) {
    const project = plan.projects[i];
    const roots = [project.root_path,...(project.bindings?.reference_roots ?? [])];
    for (let r=0;r<roots.length;r++) await store.mkdir(`${root}/projects/${i}/roots/${r}`);
    const destination = original => {
      const r = roots.findIndex(p => inside(p,original));
      if (r < 0) fail('Snapshot path outside recorded roots');
      return `${root}/projects/${i}/roots/${r}${original.slice(roots[r].length)}`;
    };
    for (const directory of before[i].directories) await store.mkdir(destination(directory));
    for (const file of before[i].files) {
      const dest = destination(file.path);
      await store.mkdir(path.dirname(dest));
      const copy = await store.copyNew(file.path,dest);
      if (copy.sha256 !== file.sha256 || copy.bytes !== file.bytes) fail('Source changed while copying');
      copies.push({...copy,original_path:file.path});
    }
  }
  await afterCopy({root,copies});
  const after = await Promise.all(plan.projects.map(p=>readProject(p,{allowLegacy:plan.operation==='migrate'})));
  if (canonicalSha256(before) !== canonicalSha256(after)) fail('Project changed during snapshot');
  for (const copy of copies) {
    const bytes = await fs.readFile(await store.guard(copy.path));
    if (bytes.length !== copy.bytes || hash(bytes) !== copy.sha256) fail('Snapshot readback differs');
  }
  const manifest = {snapshot_version:1,transaction_id:transactionId,created_at:new Date().toISOString(),plan_sha256:canonicalSha256(plan),software_only:plan.software_only,installation_prestate:installation,projects:before,copies};
  await store.writeJson(`${root}/snapshot.json`,manifest);
  await store.writeNew(`${root}/snapshot.sha256`,canonicalSha256(manifest));
  if (canonicalSha256(await store.readJson(`${root}/snapshot.json`)) !== canonicalSha256(manifest)) fail('Snapshot manifest readback differs');
  const manifestBytes = await fs.readFile(`${root}/snapshot.json`);
  return {path:`${root}/snapshot.json`,bytes:manifestBytes.length,sha256:hash(manifestBytes),manifest};
}
