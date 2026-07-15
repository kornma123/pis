'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertSafeGhCommand,
  assertSafeGitCommand,
  findScopeViolations,
  handoffFieldErrors,
  isRelevantPrompt,
  isPmApprovedStatus,
  isSafeBeforeStartShell,
  issueFormField,
  matchesAny,
  parseGitHubArtifactUrl,
  parseFlags,
  parseOwnerBlock,
  parsePmApprovalMarker,
  parsePrdRef,
  parseRequirementAcceptanceMap,
  shouldBlockStop,
  shellTokens,
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
- **current owner**: Claude Code
- **stage / model / surface**: implementation / current / local
<!-- coreone-owner:end -->`;
assert.equal(parseOwnerBlock(ownerBody), 'Claude Code');
assert.equal(parseOwnerBlock('no block'), null);

const issueFormBody = `### PRD 固定基线\n\ndocs/prd/a.md@abcdef1\n\n### RQ → AC 映射\n\nRQ-01 -> AC-01, AC-02`;
assert.equal(issueFormField(issueFormBody, 'PRD 固定基线'), 'docs/prd/a.md@abcdef1');
assert.equal(issueFormField(issueFormBody, 'RQ → AC 映射'), 'RQ-01 -> AC-01, AC-02');
assert.deepEqual(parseRequirementAcceptanceMap('RQ-01 -> AC-01, AC-02\nRQ-02 → AC-03'), [
  { requirement: 'RQ-01', acceptance: 'AC-01' },
  { requirement: 'RQ-01', acceptance: 'AC-02' },
  { requirement: 'RQ-02', acceptance: 'AC-03' },
]);
assert.throws(() => parseRequirementAcceptanceMap('RQ-01: N/A'));
assert.equal(isPmApprovedStatus('PM_APPROVED（PM 已定稿）'), true);
assert.equal(isPmApprovedStatus('NOT PM_APPROVED'), false);
assert.equal(isPmApprovedStatus('PM 未通过'), false);
assert.equal(
  parsePmApprovalMarker('[PM-APPROVAL] decision=approved artifact=docs/prd/a.md@abcdef1'),
  'docs/prd/a.md@abcdef1',
);
assert.equal(parsePmApprovalMarker('[PM-APPROVAL] decision=rejected artifact=docs/prd/a.md@abcdef1'), null);
assert.equal(parsePmApprovalMarker('NOT PM_APPROVED'), null);

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

const completeHandoff = `[HANDOFF] status=blocked
result: reproduced failure in staging
evidence: https://github.com/acme/coreone/actions/runs/1
risk: checkout remains unavailable
next-owner: backend-owner
trigger: API fix merged`;
assert.deepEqual(handoffFieldErrors(completeHandoff), []);
assert.deepEqual(handoffFieldErrors('[HANDOFF] status=blocked'), [
  'result', 'evidence', 'risk', 'next-owner', 'trigger',
]);

assert.equal(isSafeBeforeStartShell('git status --short'), true);
assert.equal(isSafeBeforeStartShell('gh issue view 12 --json body'), true);
assert.equal(isSafeBeforeStartShell('git status; Set-Content hacked.txt x'), false);
assert.equal(isSafeBeforeStartShell('git status $(touch hacked.txt)'), false);
assert.equal(isSafeBeforeStartShell('git status `touch hacked.txt`'), false);
assert.equal(isSafeBeforeStartShell('git diff --output=hacked.txt'), false);
assert.equal(isSafeBeforeStartShell('git -c diff.external=evil diff --ext-diff'), false);
assert.equal(isSafeBeforeStartShell('gh api repos/acme/core -XPOST'), false);
assert.equal(isSafeBeforeStartShell('node scripts/claude-task.cjs start --issue=12'), true);
assert.equal(isSafeBeforeStartShell('node scripts/claude-task.cjs start-r0 --reason=typo-only --owned=README.md'), true);
assert.doesNotThrow(() => assertSafeGitCommand(shellTokens('git status --short'), { mode: 'governed' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git.exe reset --hard'), { mode: 'governed' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git -C . reset --hard'), { mode: 'governed' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git rebase --exec evil origin/master'), { mode: 'governed', branch: 'task' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git diff --output=hacked.txt'), { mode: 'governed', branch: 'task' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git push -f origin task'), { mode: 'governed', branch: 'task' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git push origin HEAD:refs/heads/master'), { mode: 'governed', branch: 'task' }));
assert.throws(() => assertSafeGitCommand(shellTokens('git push --all origin'), { mode: 'governed', branch: 'task' }));
assert.doesNotThrow(() => assertSafeGitCommand(shellTokens('git push -u origin task'), { mode: 'governed', branch: 'task' }));
assert.doesNotThrow(() => assertSafeGhCommand(shellTokens('gh issue view 12'), { mode: 'governed', issue: 12 }));
assert.doesNotThrow(() => assertSafeGhCommand(shellTokens('gh issue comment 12 --body ok'), { mode: 'governed', issue: 12 }));
assert.throws(() => assertSafeGhCommand(shellTokens('gh issue close 12'), { mode: 'governed', issue: 12 }));
assert.throws(() => assertSafeGhCommand(shellTokens('gh issue edit 12 --body changed'), { mode: 'governed', issue: 12 }));
assert.throws(() => assertSafeGhCommand(shellTokens('gh issue comment 12 --repo other/repo --body ok'), { mode: 'governed', issue: 12 }));
assert.throws(() => assertSafeGhCommand(shellTokens('gh issue comment 99 --body ok'), { mode: 'governed', issue: 12 }));
assert.equal(shouldBlockStop({ stop_hook_active: false }), true);
assert.equal(shouldBlockStop({ stop_hook_active: true }), false);

const settings = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '.claude', 'settings.json'), 'utf8'),
);
assert.equal(settings.hooks.PreToolUse.some((group) => group.matcher === 'Bash|PowerShell'), true);
assert.equal(settings.hooks.PreToolUse.some((group) => group.matcher === 'mcp__.*'), true);
assert.equal(settings.hooks.PostToolUse.some((group) => group.matcher === 'Bash|PowerShell|mcp__.*'), true);

assert.equal(isRelevantPrompt('按这个 PRD 继续实现 #12'), true);
assert.equal(isRelevantPrompt('帮我翻译一句话'), false);

console.log('claude-task selftest: PASS');
