import * as fs from 'node:fs/promises';
import { canonicalSha256 } from './contracts.mjs';
import { canonicalPath, exists, hash, inside, inventory } from './store.mjs';

export async function directoryList(root) {
  const found=[];
  async function walk(dir){await canonicalPath(dir);found.push(dir);for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=`${dir}/${e.name}`;await canonicalPath(p);if(e.isDirectory())await walk(p);}}
  await walk(root);return found.sort();
}
export function directoryDigest(root,files,directories) {
  return canonicalSha256({files:files.filter(f=>inside(root,f.path)).map(f=>({...f,path:f.path.slice(root.length+1)})).sort((a,b)=>a.path.localeCompare(b.path)),directories:directories.filter(d=>inside(root,d)).map(d=>d===root?'':d.slice(root.length+1)).sort()});
}
// Directory fingerprints bind every file and directory, including empty ones.
export async function resourceHash(file) {
  file=await canonicalPath(file);
  if (!(await exists(file))) return null;
  const stat=await fs.lstat(file);
  if (stat.isFile()) return hash(await fs.readFile(file));
  return directoryDigest(file,await inventory(file),await directoryList(file));
}
