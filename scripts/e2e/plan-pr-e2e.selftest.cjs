'use strict';

const assert = require('node:assert/strict');
const { planPrE2E, readChangedFiles } = require('./plan-pr-e2e.cjs');

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
    {
      id: 'psi',
      tier: 'critical',
      owner: 'inventory',
      sources: ['前端代码/src/pages/inventory/**'],
      specs: ['e2e/critical/psi-read.spec.ts'],
    },
    {
      id: 'returns',
      tier: 'critical',
      owner: 'inventory',
      sources: [
        '前端代码/src/pages/returns/**',
        '前端代码/src/pages/_laneC/types.ts',
        '前端代码/src/pages/_laneC/components/LaneCCreateModal.tsx',
      ],
      specs: ['e2e/critical/returns.spec.ts'],
    },
    {
      id: 'legacy-lane-c',
      tier: 'legacy',
      owner: 'feature-owner-required',
      sources: [
        '前端代码/src/pages/_laneC/**',
        '前端代码/src/pages/returns/**',
      ],
      specs: [],
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
  planPrE2E(manifest, ['前端代码/src/pages/returns/Returns.tsx']),
  {
    changed: ['前端代码/src/pages/returns/Returns.tsx'],
    domains: ['returns'],
    specs: ['e2e/critical/returns.spec.ts'],
  },
);
assert.deepEqual(
  planPrE2E(manifest, ['前端代码/src/pages/_laneC/components/LaneCCreateModal.tsx']),
  {
    changed: ['前端代码/src/pages/_laneC/components/LaneCCreateModal.tsx'],
    domains: ['returns'],
    specs: ['e2e/critical/returns.spec.ts'],
  },
);
assert.deepEqual(
  planPrE2E(manifest, ['scripts/e2e/plan-pr-e2e.cjs']).specs,
  ['e2e/critical/auth.spec.ts'],
);
assert.deepEqual(
  planPrE2E(manifest, ['前端代码/e2e/critical/fixtures.ts']).specs,
  ['e2e/critical/auth.spec.ts', 'e2e/critical/psi-read.spec.ts', 'e2e/critical/returns.spec.ts'],
);
for (const buildConfig of [
  '前端代码/vite.config.ts',
  '前端代码/vitest.config.ts',
  '前端代码/tsconfig.json',
  '前端代码/tsconfig.app.json',
  '前端代码/index.html',
  '前端代码/tailwind.config.ts',
  '前端代码/postcss.config.js',
]) {
  assert.deepEqual(
    planPrE2E(manifest, [buildConfig]).specs,
    ['e2e/critical/auth.spec.ts'],
  );
}

const gitCalls = [];
assert.deepEqual(
  readChangedFiles('base-sha', 'head-sha', 'C:/repo', (command, args, options) => {
    gitCalls.push({ command, args, options });
    return '前端代码/src/App.tsx\n';
  }),
  ['前端代码/src/App.tsx'],
);
assert.equal(gitCalls[0].command, 'git');
assert.ok(gitCalls[0].args.includes('base-sha...head-sha'));
assert.equal(gitCalls[0].options.cwd, 'C:/repo');

process.stdout.write('plan-pr-e2e selftest: PASS\n');
