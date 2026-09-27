import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(process.execPath, ['--test', 'tests/integration-regression.test.mjs', 'tests/routing-eval.test.mjs', 'tests/model-capability-registry.test.mjs', 'tests/failure-attribution.test.mjs', 'tests/resource-policy.test.mjs', 'tests/adaptive-router.test.mjs', 'tests/workshop.test.mjs', 'tests/orchestrator.test.mjs', 'tests/hardening.test.mjs', 'tests/package.test.mjs', 'tests/review-regressions.test.mjs', 'tests/migration.test.mjs', 'tests/v1.1.2-regressions.test.mjs', 'tests/v1.1.3-regressions.test.mjs', 'tests/distribution-contracts.test.mjs', 'tests/distribution-source.test.mjs', 'tests/distribution-archive.test.mjs', 'tests/distribution-store.test.mjs', 'tests/distribution-install.test.mjs', 'tests/distribution-recovery.test.mjs', 'tests/distribution-migration.test.mjs', 'tests/distribution-rollback.test.mjs', 'tests/distribution-cli.test.mjs', 'tests/distribution-package.test.mjs', 'tests/distribution-workflows.test.mjs'], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
