'use strict';

const assert = require('node:assert/strict');
const {
  findScopeViolations,
  isRelevantPrompt,
  isSafeBeforeStartShell,
  matchesAny,
  parseGitHubArtifactUrl,
  parseFlags,
  parseOwnerBlock,
  parsePrdRef,
  requiresContractPrompt,
  shouldBlockStop,
  toPosix,
} = require('./claude-task.cjs');

assert.deepEqual(parseFlags(['--issue=12', '--owned=src/**', '--owned=test/**', '--dry-run']), {
  owned: ['src/**', 'test/**'],
  excluded: [],
  dryRun: true,
  issue: '12',
});

assert.equal(toPosix('.\\前端代码\\src\\App.tsx'), '前端代码/src/App.tsx');
assert.equal(matchesAny('前端代码/src/App.tsx', ['前端代码/src/**']), true);
assert.equal(matchesAny('后端代码/server/src/app.ts', ['前端代码/**']), false);
assert.equal(matchesAny('docs/a.md', ['docs/*.md']), true);
assert.equal(matchesAny('docs/nested/a.md', ['docs/*.md']), false);
assert.equal(matchesAny('src/a.ts', ['src/**/*.ts']), true);
assert.equal(matchesAny('src/nested/a.ts', ['src/**/*.ts']), true);

const ownerBody = `
<!-- coreone-owner:start -->
- **current owner**: Claude Code (Fable 5)
- **stage / model / surface**: implementation / Fable 5 / local
<!-- coreone-owner:end -->`;
assert.equal(parseOwnerBlock(ownerBody), 'Claude Code (Fable 5)');
assert.equal(parseOwnerBlock('no block'), null);

assert.deepEqual(parsePrdRef('docs/prd/PRD-12.md@abcdef123456'), {
  file: 'docs/prd/PRD-12.md',
  ref: 'abcdef123456',
});
assert.equal(parsePrdRef('../secret.md@abcdef1'), null);
assert.equal(parsePrdRef('docs/prd/PRD-12.md'), null);

assert.deepEqual(
  parseGitHubArtifactUrl('https://github.com/acme/coreone/issues/12#issuecomment-345'),
  {
    owner: 'acme',
    repo: 'coreone',
    kind: 'issue',
    number: 12,
    commentId: 345,
    commentType: 'issue',
    url: 'https://github.com/acme/coreone/issues/12#issuecomment-345',
  },
);
assert.equal(parseGitHubArtifactUrl('https://example.com/acme/coreone/issues/12'), null);

const scope = { owned: ['docs/**'], excluded: ['docs/private/**'] };
assert.deepEqual(findScopeViolations(['docs/a.md'], scope), []);
assert.deepEqual(findScopeViolations(['docs/private/a.md', 'src/a.ts'], scope), [
  'docs/private/a.md',
  'src/a.ts',
]);

assert.equal(isSafeBeforeStartShell('git status --short'), true);
assert.equal(isSafeBeforeStartShell('gh issue view 12 --json body'), true);
assert.equal(isSafeBeforeStartShell('git status; Set-Content hacked.txt x'), false);
assert.equal(isSafeBeforeStartShell('node scripts/claude-task.cjs start --issue=12'), true);
assert.equal(isSafeBeforeStartShell('node scripts/claude-task.cjs disarm --reason=user-cancelled'), true);
assert.equal(shouldBlockStop({ stop_hook_active: false }), true);
assert.equal(shouldBlockStop({ stop_hook_active: true }), false);

assert.equal(isRelevantPrompt('按这个 PRD 继续实现 #12'), true);
assert.equal(isRelevantPrompt('帮我翻译一句话'), false);
assert.equal(requiresContractPrompt('PRD 是什么？'), false);
assert.equal(requiresContractPrompt('按这个 PRD 继续实现 #12'), true);
assert.equal(requiresContractPrompt('实现 #12'), true);
assert.equal(requiresContractPrompt('修复一个错字'), false);

console.log('claude-task selftest: PASS');
