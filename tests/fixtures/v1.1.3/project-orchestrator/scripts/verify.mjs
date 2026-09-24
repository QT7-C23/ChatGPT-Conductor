import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(process.execPath, ['--test', 'tests/orchestrator.test.mjs', 'tests/hardening.test.mjs', 'tests/package.test.mjs', 'tests/review-regressions.test.mjs', 'tests/migration.test.mjs', 'tests/v1.1.2-regressions.test.mjs', 'tests/v1.1.3-regressions.test.mjs'], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
