import https from 'node:https';
import { spawn } from 'node:child_process';
import { realpath, lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { DistributionError } from './contracts.mjs';

export const LIMITS = Object.freeze({ manifest: 2*1024*1024, changelog: 1024*1024, zip: 100*1024*1024, uncompressed: 500*1024*1024, file: 50*1024*1024, entries: 10000, redirects: 5, requestMs: 120000 });
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const fail = (code, message) => new DistributionError(code, message);
export function validateTransportUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) throw fail('SOURCE_HOST', 'Unapproved source URL');
  return url;
}
// request is a trusted host port; production always uses HTTPS with normal certificate validation.
export function createTransport({ request = https.request } = {}) {
  return async function transport(value, { limit, headers = {} }) {
    let url = validateTransportUrl(value);
    let currentHeaders = { 'user-agent': 'ChatGPT-Conductor', ...headers };
    for (const key of Object.keys(currentHeaders)) if (key.toLowerCase() === 'cookie' || key.toLowerCase() === 'cookie2') delete currentHeaders[key];
    const deadline = Date.now() + LIMITS.requestMs;
    for (let redirects = 0; ; redirects++) {
      const result = await new Promise((resolve, reject) => {
        const req = request(url, { headers: currentHeaders }, response => {
          const status = response.statusCode;
          if ([301,302,303,307,308].includes(status)) {
            response.destroy(); resolve({ location: response.headers.location }); return;
          }
          if (status !== 200) {
            response.destroy();
            const error = fail('SOURCE_UNAVAILABLE', `GitHub request unavailable (${status})`);
            error.retryAfter = response.headers['retry-after'] ?? response.headers['x-ratelimit-reset'] ?? null;
            reject(error); return;
          }
          const declared = Number(response.headers['content-length']);
          if (declared > limit) { response.destroy(); reject(fail('SOURCE_LIMIT', 'Asset exceeds size limit')); return; }
          const chunks = []; let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > limit) { response.destroy(); reject(fail('SOURCE_LIMIT', 'Asset exceeds size limit')); }
            else chunks.push(chunk);
          });
          response.on('end', () => resolve({ body: Buffer.concat(chunks) }));
          response.on('error', () => reject(fail('SOURCE_UNAVAILABLE', 'GitHub response interrupted')));
        });
        const timer = setTimeout(() => req.destroy(), Math.max(1, deadline-Date.now()));
        req.once('close', () => clearTimeout(timer));
        req.on('error', () => reject(fail('SOURCE_UNAVAILABLE', 'GitHub connection unavailable')));
        req.end();
      });
      if (result.body) return result.body;
      if (!result.location || redirects >= LIMITS.redirects) throw fail('SOURCE_REDIRECT', 'Invalid or excessive redirects');
      const next = validateTransportUrl(new URL(result.location, url).href);
      if (next.origin !== url.origin) currentHeaders = { 'user-agent': 'ChatGPT-Conductor', accept: currentHeaders.accept ?? 'application/octet-stream' };
      url = next;
    }
  };
}
export async function resolveGh({ searchPath = process.env.PATH ?? '', cwd = process.cwd() } = {}) {
  const caller = await realpath(cwd);
  for (const directory of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    try {
      const base = await realpath(directory);
      if (base.toLowerCase() === caller.toLowerCase()) continue;
      const candidate = path.join(base, process.platform === 'win32' ? 'gh.exe' : 'gh');
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch { /* Try the next absolute host PATH entry, never caller cwd. */ }
  }
  throw fail('AUTHENTICATION_FAILED', 'Trusted GitHub CLI unavailable');
}
export async function runGh(args, { executable, prefixArgs = [] } = {}) {
  // Explicit executable is a trusted internal test/host port, never CLI input.
  executable ??= await resolveGh();
  if (!path.isAbsolute(executable)) throw fail('AUTHENTICATION_FAILED', 'Absolute GitHub CLI required');
  executable = await realpath(executable);
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (['GH_HOST', 'GH_REPO'].includes(key.toUpperCase())) delete env[key];
    env.GH_HOST = 'github.com';
    const child = spawn(executable, [...prefixArgs, ...args], { cwd:path.dirname(executable), env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let bytes = 0; const chunks = []; let failed = false;
    const block = () => { failed = true; child.kill(); reject(fail('AUTHENTICATION_FAILED', 'GitHub release authentication failed or unavailable')); };
    const timer = setTimeout(block, LIMITS.requestMs);
    child.on('error', block);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > LIMITS.manifest) block();
      else if (stream === child.stdout) chunks.push(chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) { block(); return; }
      try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!result || typeof result !== 'object') throw Error(); resolve(result); }
      catch { block(); }
    });
  });
}
export async function authenticateWithGh({ tag, file }, processOptions = {}) {
  const args = file ? ['release','verify-asset',tag,file] : ['release','verify',tag];
  return runGh([...args, '--repo', 'github.com/QT7-C23/ChatGPT-Conductor', '--format', 'json'], processOptions);
}
