import yauzl from 'yauzl';
import path from 'node:path';
import { lstat, realpath, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DistributionError } from './contracts.mjs';
import { requireAuthenticatedBundle, LIMITS } from './source.mjs';
const fail = message => { throw new DistributionError('UNSAFE_ARCHIVE', message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function components(value) {
  if (typeof value !== 'string' || value.includes('\\') || /[\x00-\x1f\x7f:<>"|?*]/.test(value)) fail('Unsafe archive path');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) fail('Unsafe archive component');
  return parts;
}
export async function assertSafeDirectory(directory) {
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('Unsafe staging ancestor');
  }
  return realpath(absolute);
}
export async function extractVerifiedPayload(value, { stagingParent, name }) {
  requireAuthenticatedBundle(value, { payload: true });
  if (components(name).length !== 1) fail('Staging name must be a single component');
  const parent = await assertSafeDirectory(stagingParent);
  const manifest = value.manifest;
  components(manifest.payload.archive_root);
  const expected = new Map(); const directories = new Set([manifest.payload.archive_root]);
  let declared = 0; const spelling = new Map();
  for (const file of manifest.payload.files) {
    components(file.path); declared += file.bytes;
    if (file.bytes > LIMITS.file || declared > LIMITS.uncompressed) fail('Manifest extraction quota exceeded');
    const full = `${manifest.payload.archive_root}/${file.path}`;
    const segments = full.split('/');
    for (let count = 1; count <= segments.length; count++) {
      const prefix = segments.slice(0, count).join('/'); const key = prefix.toLowerCase();
      if (spelling.has(key) && spelling.get(key) !== prefix) fail('Case-colliding path components');
      spelling.set(key, prefix);
    }
    expected.set(full, file);
    const pieces = full.split('/');
    for (let i = 1; i < pieces.length; i++) directories.add(pieces.slice(0,i).join('/'));
  }
  for (const file of expected.keys()) if (directories.has(file)) fail('File parent conflict');
  const input = await open(value.payloadPath, 'r');
  let bytes;
  try {
    const info = await input.stat();
    if (!info.isFile() || info.size !== manifest.payload.bytes || info.size > LIMITS.zip) fail('Payload size mismatch');
    bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) { const read = await input.read(bytes, offset, bytes.length-offset, offset); if (!read.bytesRead) fail('Payload truncated'); offset += read.bytesRead; }
    if (hash(bytes) !== manifest.payload.sha256) fail('Payload digest mismatch');
  } finally { await input.close(); }
  // Parse and validate all metadata before creating any output.
  const zip = await new Promise((resolve,reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error,result) => error ? reject(error) : resolve(result)));
  const entries = []; const seen = new Set(); let total = 0;
  try {
    await new Promise((resolve,reject) => {
      zip.once('error', reject); zip.once('end', resolve);
      zip.on('entry', entry => {
        try {
          if (entries.length >= LIMITS.entries) fail('Archive entry quota exceeded');
          const directory = entry.fileName.endsWith('/');
          const full = directory ? entry.fileName.slice(0,-1) : entry.fileName;
          components(full);
          const key = full.toLowerCase();
          if (seen.has(key)) fail('Duplicate or case-colliding entry'); seen.add(key);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const type = mode & 0xf000;
          if ((type && type !== (directory ? 0x4000 : 0x8000)) || (entry.externalFileAttributes & 0x400) || entry.extraFields.some(f => [0x000d,0x756e].includes(f.id)) || (entry.generalPurposeBitFlag & 1)) fail('Unsupported archive entry type');
          if (Boolean(entry.externalFileAttributes & 0x10) && !directory) fail('Conflicting directory attributes');
          if (directory ? !directories.has(full) || entry.uncompressedSize !== 0 : !expected.has(full)) fail('Unexpected archive entry');
          if (!directory && entry.uncompressedSize !== expected.get(full).bytes) fail('Entry size mismatch');
          total += entry.uncompressedSize;
          if (entry.uncompressedSize > LIMITS.file || total > LIMITS.uncompressed) fail('Archive extraction quota exceeded');
          entries.push({ entry, full, directory }); zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
    for (const file of expected.keys()) if (!seen.has(file.toLowerCase())) fail('Missing archive file');
    const root = path.join(parent, name);
    await mkdir(root, { mode: 0o700 }); // Existing roots are never reused or removed.
    for (const { entry, full, directory } of entries) {
      const destination = path.join(root, ...full.split('/'));
      const parentPath = directory ? destination : path.dirname(destination);
      await mkdir(parentPath, { recursive: true, mode: 0o700 });
      await assertSafeDirectory(parentPath);
      if (directory) continue;
      const output = await open(destination, 'wx', 0o600);
      try {
        const stream = await new Promise((resolve,reject) => zip.openReadStream(entry, (error,result) => error ? reject(error) : resolve(result)));
        const digest = createHash('sha256'); let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > expected.get(full).bytes || size > LIMITS.file) { stream.destroy(); fail('Inflated entry exceeds quota'); }
          digest.update(chunk); await output.writeFile(chunk);
        }
        if (size !== expected.get(full).bytes || digest.digest('hex') !== expected.get(full).sha256) fail('Extracted file digest mismatch');
      } finally { await output.close(); }
    }
    return Object.freeze({ root, archiveRoot: path.join(root, manifest.payload.archive_root), descriptor: value.descriptor, files: manifest.payload.files });
  } finally { zip.close(); }
}
