'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assertSafeGhCommand,
  assertSafeGitCommand,
  assertSafeNodeCommand,
  classifyIssueDeliveryContract,
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

const repositoryRoot = path.resolve(__dirname, '..');

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
const nonPrdIssueFormBody = `### 单一分类

明确可实施的工程任务

### 现状证据

2026-07-15 在固定分支复现守卫误判。

### PRD 固定基线

N/A

### RQ → AC 映射

N/A

### 范围

- 修复任务入口守卫。

### 非范围

- 不修改业务代码。

### 验收标准

- 自测覆盖允许与拒绝路径。`;
assert.equal(issueFormField(issueFormBody, 'PRD 固定基线'), 'docs/prd/a.md@abcdef1');
assert.equal(issueFormField(issueFormBody, 'RQ → AC 映射'), 'RQ-01 -> AC-01, AC-02');
assert.deepEqual(
  classifyIssueDeliveryContract(nonPrdIssueFormBody),
  { mode: 'NON_PRD', requirements: [], acceptance: [], mappings: [] },
);
assert.deepEqual(classifyIssueDeliveryContract(issueFormBody), {
  mode: 'PRD',
  prd: { file: 'docs/prd/a.md', ref: 'abcdef1' },
  requirements: ['RQ-01'],
  acceptance: ['AC-01', 'AC-02'],
  mappings: [
    { requirement: 'RQ-01', acceptance: 'AC-01' },
    { requirement: 'RQ-01', acceptance: 'AC-02' },
  ],
});
assert.throws(() =>
  classifyIssueDeliveryContract('### PRD 固定基线\n\nN/A\n\n### RQ → AC 映射\n\nRQ-01 -> AC-01'),
);
assert.throws(() =>
  classifyIssueDeliveryContract('### PRD 固定基线\n\ndocs/prd/a.md@abcdef1\n\n### RQ → AC 映射\n\nN/A'),
);
assert.throws(() =>
  classifyIssueDeliveryContract('### PRD 固定基线\n\nN / A\n\n### RQ → AC 映射\n\nN / A'),
);
assert.throws(() =>
  classifyIssueDeliveryContract('### PRD 固定基线\n\nN/A'),
);
assert.throws(() =>
  classifyIssueDeliveryContract(nonPrdIssueFormBody.replace('明确可实施的工程任务', '父级 tracking（只聚合权威链接，不承接实现）')),
);
for (const field of ['现状证据', '范围', '非范围', '验收标准']) {
  const emptyFieldBody = nonPrdIssueFormBody.replace(
    new RegExp(`(### ${field}\\n\\n)[\\s\\S]*?(?=\\n\\n### |$)`),
    `$1N/A`,
  );
  assert.throws(() => classifyIssueDeliveryContract(emptyFieldBody), `${field} must be substantive`);
}
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
assert.equal(isSafeBeforeStartShell('node scripts/claude-task.cjs start --issue=12', repositoryRoot), true);
assert.equal(isSafeBeforeStartShell('node scripts/claude-task.cjs start-r0 --reason=typo-only --owned=README.md', repositoryRoot), true);
assert.equal(
  isSafeBeforeStartShell(
    `node "${path.resolve(repositoryRoot, '..', 'outside', 'scripts', 'agent-preflight.cjs')}"`,
    repositoryRoot,
  ),
  false,
);
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

assert.doesNotThrow(() =>
  assertSafeNodeCommand(shellTokens('node scripts/claude-task.selftest.cjs'), repositoryRoot),
);
assert.doesNotThrow(() =>
  assertSafeNodeCommand(shellTokens('node --check scripts/claude-task.cjs'), repositoryRoot),
);
assert.doesNotThrow(() =>
  assertSafeNodeCommand(shellTokens('node --test'), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(shellTokens('node -rC:/tmp/evil.cjs scripts/claude-task.cjs'), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(shellTokens('node -pe 1+1'), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(shellTokens('node ../outside/mutate.cjs'), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(shellTokens(`node "${process.execPath}"`), repositoryRoot),
);
assert.throws(() =>
  assertSafeNodeCommand(
    shellTokens(`node --test scripts/claude-task.selftest.cjs -- "${process.execPath}"`),
    repositoryRoot,
  ),
);
assert.throws(() =>
  assertSafeNodeCommand(
    shellTokens('C:/outside/node.exe scripts/claude-task.cjs'),
    repositoryRoot,
  ),
);
assert.doesNotThrow(() =>
  assertSafeNodeCommand(
    shellTokens('node scripts/start-production.mjs'),
    repositoryRoot,
    path.join(repositoryRoot, '后端代码', 'server'),
  ),
);

const expandableNodeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-node-expansion-'));
try {
  for (const directory of ['$ENTRY', '%ENTRY%', '~']) {
    const targetDirectory = path.join(expandableNodeRoot, directory);
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'task.cjs'), 'process.exitCode = 0;\n');
  }
  for (const entry of ['$ENTRY/task.cjs', '%ENTRY%/task.cjs', '~/task.cjs']) {
    assert.throws(
      () => assertSafeNodeCommand(shellTokens(`node ${entry}`), expandableNodeRoot),
      `${entry} must not pass before shell expansion`,
    );
  }
} finally {
  fs.rmSync(expandableNodeRoot, { recursive: true, force: true });
}

const guidePath = ['docs', 'Claude-Code-PRD-GitHub协作范式.md'].join('/');
assert.equal(fs.existsSync(path.join(repositoryRoot, ...guidePath.split('/'))), true);
const retiredGuidePath = ['docs/', 'Fa', 'ble', '5-PRD-GitHub协作范式.md'].join('');
const retiredModelPattern = new RegExp(['Fa', 'ble'].join(''), 'i');
const entryTextByPath = new Map();
for (const relativePath of [
  '.claude/commands/coreone-prd.md',
  '.claude/skills/coreone/SKILL.md',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/ISSUE_TEMPLATE/prd-intake.yml',
  guidePath,
]) {
  const text = fs.readFileSync(path.join(repositoryRoot, ...relativePath.split('/')), 'utf8');
  entryTextByPath.set(relativePath, text);
  assert.equal(text.includes(retiredGuidePath), false, `${relativePath} must not reference the retired guide`);
  assert.equal(retiredModelPattern.test(text), false, `${relativePath} must not pin a retired model name`);
}
assert.equal(entryTextByPath.get('.claude/commands/coreone-prd.md').includes(guidePath), true);
assert.equal(entryTextByPath.get('.github/ISSUE_TEMPLATE/prd-intake.yml').includes(guidePath), true);
assert.equal(
  [...entryTextByPath.get('.github/ISSUE_TEMPLATE/config.yml').matchAll(/^\s+url:\s+(\S+)/gm)]
    .map((match) => decodeURIComponent(new URL(match[1]).pathname))
    .some((pathname) => pathname.endsWith(`/${guidePath}`)),
  true,
  'Issue config must link to the committed guide',
);
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
