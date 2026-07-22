'use strict';

const assert = require('node:assert/strict');
const { planPrE2E } = require('./plan-pr-e2e.cjs');

const manifest = {
  version: 1,
  triageOwner: 'kornma123',
  trackingIssue: 23,
  coreSpecs: ['e2e/critical/auth.spec.ts'],
  guardedRoots: ['前端代码/src/', '后端代码/server/src/'],
  ignored: ['**/*.test.ts', '**/*.test.tsx'],
  domains: [
    {
      id: 'auth',
      tier: 'critical',
      owner: 'security',
      sources: ['前端代码/src/pages/auth/**', '后端代码/server/src/routes/auth.ts'],
      specs: ['e2e/critical/auth.spec.ts'],
    },
    {
      id: 'legacy-bom',
      tier: 'legacy',
      owner: 'bom',
      sources: ['前端代码/src/pages/bom/**'],
      specs: ['e2e/bom.spec.ts'],
    },
  ],
};

assert.deepEqual(
  planPrE2E(manifest, ['前端代码/src/pages/auth/Login.tsx']).specs,
  ['e2e/critical/auth.spec.ts'],
);
assert.throws(
  () => planPrE2E(manifest, ['前端代码/src/pages/new-feature/Page.tsx']),
  /E2E_IMPACT_UNMAPPED/,
);
assert.throws(
  () => planPrE2E(manifest, ['前端代码/src/pages/bom/BOM.tsx']),
  /E2E_IMPACT_LEGACY/,
);
assert.deepEqual(
  planPrE2E(manifest, ['前端代码/src/pages/auth/Login.test.tsx']).specs,
  [],
);
assert.deepEqual(
  planPrE2E(manifest, ['scripts/e2e/plan-pr-e2e.cjs']).specs,
  ['e2e/critical/auth.spec.ts'],
);

process.stdout.write('plan-pr-e2e selftest: PASS\n');
