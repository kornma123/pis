'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  beginIssueCreationLedger,
  assertClaudeImplementationOwnership,
  assertSafeGhCommand,
  assertSafeGitCommand,
  assertSafeNodeCommand,
  classifyIssueDeliveryContract,
  collectHandoffFields,
  findScopeViolations,
  handoffFieldErrors,
  isHarnessMemoryPath,
  isRelevantPrompt,
  isPmApprovedStatus,
  isSafeBeforeStartShell,
  issueFormField,
  matchesAny,
  parseGitHubArtifactUrl,
  parseFlags,
  parseIssueCreationApprovalMarker,
  parseIssueRatingMarker,
  parseOwnerBlock,
  parsePmApprovalMarker,
  parsePrdRef,
  parseRequirementAcceptanceMap,
  resolveIssueCreationManifestPath,
  shouldBlockStop,
  shellTokens,
  toPosix,
  validateIssueCreationManifest,
  validateIssueImplementationLabels,
} = require('./claude-task.cjs');
const {
  collectFields,
  parseReflectionContract,
  stripIgnoredMarkdown,
  validatePrBody,
} = require('./issue-handoff/check-pr-body.cjs');

const repositoryRoot = path.resolve(__dirname, '..');

assert.deepEqual(parseFlags(['--issue=12', '--owned=src/**', '--owned=test/**', '--dry-run']), {
  owned: ['src/**', 'test/**'],
  excluded: [],
  dryRun: true,
  issue: '12',
});

function issueLabels(...names) {
  return names.map((name) => ({ name }));
}

for (const [name, labels, pattern] of [
  ['missing both axes', issueLabels('question'), /优先级.*上线影响/],
  ['duplicate priority', issueLabels('P1', 'P2', '非阻断上线'), /优先级标签.*恰好一个/],
  ['duplicate release impact', issueLabels('P1', '阻断上线', '非阻断上线'), /上线影响标签.*恰好一个/],
  ['P0 cannot be nonblocking', issueLabels('P0', '非阻断上线'), /P0.*非阻断上线/],
  ['P3 cannot block release', issueLabels('P3', '阻断上线'), /P3.*阻断上线/],
]) {
  const result = validateIssueImplementationLabels(labels);
  assert.equal(result.ok, false, `${name}: expected invalid implementation labels`);
  assert.match(result.errors.join('\n'), pattern, name);
}
for (const [name, labels, expected] of [
  ['P0 blocking', issueLabels('P0', '阻断上线'), ['P0', '阻断上线']],
  ['P1 blocking', issueLabels('P1', '阻断上线'), ['P1', '阻断上线']],
  ['P1 nonblocking', issueLabels('P1', '非阻断上线'), ['P1', '非阻断上线']],
  ['P2 blocking', issueLabels('P2', '阻断上线'), ['P2', '阻断上线']],
  ['P2 nonblocking', issueLabels('P2', '非阻断上线'), ['P2', '非阻断上线']],
  ['P3 nonblocking', issueLabels('P3', '非阻断上线'), ['P3', '非阻断上线']],
]) {
  const result = validateIssueImplementationLabels(labels);
  assert.equal(result.ok, true, `${name}: ${result.errors.join('; ')}`);
  assert.deepEqual([result.priority, result.releaseImpact], expected, name);
}

for (const file of [
  'docs/COREONE-质量Loop总览-2026-07-12.md',
  'docs/COREONE-质量Loop契约-2026-07-12.md',
  'docs/COREONE-PRD质量Loop-2026-07-12.md',
  'docs/COREONE-前端Mockup质量Loop-2026-07-12.md',
  'docs/COREONE-写码质量Loop-2026-07-12.md',
  'docs/COREONE-真跑验收质量Loop-2026-07-12.md',
  'docs/COREONE-报告结论质量Loop-2026-07-12.md',
]) {
  assert.match(
    fs.readFileSync(path.join(repositoryRoot, file), 'utf8'),
    /已于 2026-07-29 经 PM 定稿/,
    `${file} must reflect the PM-finalized v1.0 family`,
  );
}
const operatingContractText = fs.readFileSync(
  path.join(repositoryRoot, 'docs/agent-operating-contract.md'),
  'utf8',
);
assert.match(
  operatingContractText,
  /前端实现 owner = Claude Code CLI\/K3；Codex 负责 fixed-SHA 复核/,
);
assert.match(
  operatingContractText,
  /后端实现 owner = Codex；Claude Code CLI\/K3 负责 fixed-SHA 独立复核/,
);
assert.match(
  operatingContractText,
  /Issue 正式评级与标签写入 \/ 回读 owner = Codex/,
);
const issueLoopText = fs.readFileSync(
  path.join(repositoryRoot, 'docs/github-issue-pr-management-loop.md'),
  'utf8',
);
const issueRatingText = fs.readFileSync(
  path.join(repositoryRoot, 'docs/prd/COREONE-Issue分级与上线阻断标签规则.md'),
  'utf8',
);
assert.match(issueRatingText, /issue-rating-contract-id: coreone-issue-rating\/v1/);
assert.match(issueRatingText, /question-only/);
assert.match(issueRatingText, /P0 \+ 非阻断上线/);
assert.match(issueRatingText, /P3 \+ 阻断上线/);
assert.match(issueRatingText, /Codex.*正式双轴评级/s);
assert.match(issueRatingText, /\[ISSUE-RATING\] owner=Codex/);
assert.match(
  issueLoopText,
  /issue-rating-source: docs\/prd\/COREONE-Issue分级与上线阻断标签规则\.md/,
);
assert.doesNotMatch(
  issueLoopText,
  /P0 \+ 非阻断上线|P3 \+ 阻断上线/,
  'Issue management loop must point to, not duplicate, the rating contract',
);
assert.match(issueLoopText, /release disposition/);
assert.match(issueLoopText, /当前工作目录所对应的 Claude project/);
assert.match(issueLoopText, /canonical bytes/);
assert.match(issueLoopText, /标题单行/);
assert.match(issueLoopText, /acceptance.*ownership exception/);
assert.match(issueLoopText, /actor、attempt 时间窗、精确 title\/body/);
assert.match(issueLoopText, /execution lock.*offline governance 开始/s);
assert.match(
  issueLoopText,
  /node scripts\/claude-task\.cjs github-write -- <原 git\/gh 命令>/,
);
const qualityLoopContractText = fs.readFileSync(
  path.join(repositoryRoot, 'docs/COREONE-质量Loop契约-2026-07-12.md'),
  'utf8',
);
const releaseDispositionNorm = /唯一判定式是/g;
assert.equal(
  [issueRatingText, issueLoopText, qualityLoopContractText]
    .reduce((count, text) => count + [...text.matchAll(releaseDispositionNorm)].length, 0),
  1,
  'release-disposition predicate must exist only in the unique Issue rating authority',
);
assert.match(
  issueRatingText,
  /当前支持的真实产品路径上可合理到达且违反当前 AC \/ 明示 threat contract[\s\S]*才阻断当前发布/,
);
for (const [file, text] of [
  ['docs/COREONE-质量Loop契约-2026-07-12.md', qualityLoopContractText],
  ['docs/github-issue-pr-management-loop.md', issueLoopText],
]) {
  assert.doesNotMatch(
    text,
    /人工改库、移除 trigger|极低频怪异输入|才阻断当前发布/,
    `${file} must link to, not duplicate, the release-disposition predicate`,
  );
}

const activeClaudeRoutes = new Map([
  [
    '.claude/commands/coreone-deliver-prd.md',
    fs.readFileSync(
      path.join(repositoryRoot, '.claude/commands/coreone-deliver-prd.md'),
      'utf8',
    ),
  ],
  [
    '.claude/skills/coreone/SKILL.md',
    fs.readFileSync(path.join(repositoryRoot, '.claude/skills/coreone/SKILL.md'), 'utf8'),
  ],
  [
    'docs/Claude-Code-PRD-GitHub协作范式.md',
    fs.readFileSync(
      path.join(repositoryRoot, 'docs/Claude-Code-PRD-GitHub协作范式.md'),
      'utf8',
    ),
  ],
]);
for (const [file, text] of activeClaudeRoutes) {
  assert.match(text, /agent-operating-contract\.md.*§4|共用契约 §4/s, `${file}: routing source`);
  assert.match(text, /前端.*Claude Code.*Codex.*复核/s, `${file}: frontend route`);
  assert.match(text, /后端.*Codex.*Claude Code.*复核/s, `${file}: backend route`);
  assert.match(
    text,
    /线下.*(?:fixed[- ]SHA|固定 SHA)|(?:fixed[- ]SHA|固定 SHA).*线下/s,
    `${file}: offline review route`,
  );
  assert.doesNotMatch(
    text,
    /独立 reviewer 在目标 PR 留普通评论|reviewer 留可追踪评论|reviewer 在对应 PR 留下可追踪评论/,
    `${file}: retired GitHub review route`,
  );
}
assert.match(activeClaudeRoutes.get('.claude/commands/coreone-deliver-prd.md'), /Codex 正式评级/);
assert.match(activeClaudeRoutes.get('.claude/skills/coreone/SKILL.md'), /\[ISSUE-RATING\]/);

assert.equal(toPosix('.\\前端代码\\src\\App.tsx'), '前端代码/src/App.tsx');
assert.equal(matchesAny('前端代码/src/App.tsx', ['前端代码/src/**']), true);
assert.equal(matchesAny('后端代码/server/src/app.ts', ['前端代码/**']), false);
assert.equal(matchesAny('docs/a.md', ['docs/*.md']), true);
assert.equal(matchesAny('docs/nested/a.md', ['docs/*.md']), false);
assert.equal(matchesAny('src/a.ts', ['src/**/*.ts']), true);
assert.equal(matchesAny('src/nested/a.ts', ['src/**/*.ts']), true);
assert.doesNotThrow(() =>
  assertClaudeImplementationOwnership('implementation', ['前端代码/**']),
);
assert.doesNotThrow(() =>
  assertClaudeImplementationOwnership('acceptance', ['前端代码/e2e/**']),
);
for (const [name, owned] of [
  ['backend', ['后端代码/**']],
  ['mixed', ['前端代码/**', '后端代码/**']],
  ['broad', ['**']],
  ['unclassified governance', ['scripts/**']],
]) {
  assert.throws(
    () => assertClaudeImplementationOwnership('implementation', owned),
    /Claude Code.*实现|ownership exception|所有权例外/,
    name,
  );
}
assert.doesNotThrow(() =>
  assertClaudeImplementationOwnership('implementation', ['后端代码/**'], {
    verified: true,
    issue: 81,
  }),
);
assert.throws(
  () => assertClaudeImplementationOwnership('acceptance', ['后端代码/**']),
  /Claude Code.*实现|ownership exception|所有权例外/,
  'acceptance cannot be used as a writable backend ownership bypass',
);
for (const [name, owned] of [
  ['mixed', ['前端代码/e2e/**', '后端代码/server/src/**']],
  ['broad', ['**']],
]) {
  assert.throws(
    () => assertClaudeImplementationOwnership('acceptance', owned),
    /Claude Code.*实现|ownership exception|所有权例外/,
    `acceptance ${name} scope requires the same ownership exception`,
  );
}

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
const canonicalRatingMarker =
  '[ISSUE-RATING] owner=Codex previous=P1/阻断上线 ' +
  'current=P2/非阻断上线 reason=固定 SHA 复核证明当前上线影响已经改变';
assert.equal(parseIssueRatingMarker(canonicalRatingMarker).currentPriority, 'P2');
for (const hiddenRatingMarker of [
  `<!--\n${canonicalRatingMarker}\n-->`,
  `\`\`\`text\n${canonicalRatingMarker}\n\`\`\``,
]) {
  assert.throws(
    () => parseIssueRatingMarker(hiddenRatingMarker),
    /评级证据评论/,
    'hidden rating marker must not be accepted as visible audit evidence',
  );
}

const issueManifest = validateIssueCreationManifest(JSON.stringify({
  version: 1,
  issues: [{
    title: '需求讨论：新增可审计的出库异常提示',
    body: '### 问题\\n\\n当前异常提示缺少可定位证据。\\n\\n### 下一步\\n\\n等待 Codex 去重、范围与 AC 复核后评级。',
  }],
}));
assert.equal(issueManifest.issues.length, 1);
assert.deepEqual(
  parseIssueCreationApprovalMarker(
    '[PM-ISSUE-CREATION] decision=approved ' +
    `manifest-sha256=${issueManifest.sha256} count=1`,
  ),
  { sha256: issueManifest.sha256, count: 1 },
);
assert.throws(() => validateIssueCreationManifest(JSON.stringify({ version: 1, issues: [] })));
assert.throws(() => validateIssueCreationManifest(JSON.stringify({
  version: 1,
  issues: [{ title: 'x', body: 'too short' }],
})));
for (const [label, candidate] of [
  ['title type coercion', {
    title: 123456789012,
    body: '### 问题\n\n当前异常提示缺少可定位证据。\n\n### 下一步\n\n等待复核。',
  }],
  ['title trim', {
    title: ' 需求讨论：禁止授权后静默改标题',
    body: '### 问题\n\n当前异常提示缺少可定位证据。\n\n### 下一步\n\n等待复核。',
  }],
  ['title embedded LF', {
    title: '需求讨论：禁止标题\n换行被 GitHub 规范化',
    body: '### 问题\n\n当前异常提示缺少可定位证据。\n\n### 下一步\n\n等待复核。',
  }],
  ['title embedded CR', {
    title: '需求讨论：禁止标题\r回车被 GitHub 规范化',
    body: '### 问题\n\n当前异常提示缺少可定位证据。\n\n### 下一步\n\n等待复核。',
  }],
  ['body CRLF normalization', {
    title: '需求讨论：禁止授权后静默改正文',
    body: '### 问题\r\n\r\n当前异常提示缺少可定位证据。\r\n\r\n### 下一步\r\n\r\n等待复核。',
  }],
  ['body trim', {
    title: '需求讨论：禁止授权后静默裁剪正文',
    body: '### 问题\n\n当前异常提示缺少可定位证据。\n\n### 下一步\n\n等待复核。\n',
  }],
]) {
  assert.throws(
    () => validateIssueCreationManifest(JSON.stringify({
      version: 1,
      issues: [candidate],
    })),
    /字符串|canonical bytes/,
    label,
  );
}

const issueLedgerSandbox = fs.mkdtempSync(
  path.join(os.tmpdir(), 'coreone-issue-ledger-reservation-'),
);
try {
  const initLedgerRepo = spawnSync(
    'git',
    ['init', '--initial-branch=issue-ledger-test'],
    { cwd: issueLedgerSandbox, encoding: 'utf8' },
  );
  assert.equal(initLedgerRepo.status, 0, initLedgerRepo.stderr);
  const reservation = beginIssueCreationLedger(
    issueLedgerSandbox,
    issueManifest.sha256,
    'https://github.com/acme/coreone/issues/1#issuecomment-2',
  );
  assert.equal(
    reservation.ledger.consumed[issueManifest.sha256].status,
    'in-progress',
  );
  reservation.release();
  assert.throws(
    () => beginIssueCreationLedger(
      issueLedgerSandbox,
      issueManifest.sha256,
      'https://github.com/acme/coreone/issues/1#issuecomment-2',
    ),
    /仍由活动进程/,
    'an in-progress manifest cannot be taken over while its reserving process is alive',
  );

  const concurrentSha = 'a'.repeat(64);
  const concurrentOutcomes = path.join(issueLedgerSandbox, 'concurrent-outcomes.jsonl');
  const workerPath = path.join(issueLedgerSandbox, 'reservation-worker.cjs');
  const launcherPath = path.join(issueLedgerSandbox, 'reservation-launcher.cjs');
  fs.writeFileSync(workerPath, `'use strict';
const fs = require('node:fs');
const { beginIssueCreationLedger } = require(${JSON.stringify(path.join(__dirname, 'claude-task.cjs'))});
const [root, sha, outcomes] = process.argv.slice(2);
try {
  const reservation = beginIssueCreationLedger(root, sha, 'https://github.com/acme/coreone/issues/1#issuecomment-2');
  fs.appendFileSync(outcomes, JSON.stringify({ status: 'reserved', pid: process.pid }) + '\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  reservation.release();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
} catch (error) {
  fs.appendFileSync(outcomes, JSON.stringify({ status: 'rejected', message: error.message }) + '\\n');
  process.exitCode = 1;
}
`, 'utf8');
  fs.writeFileSync(launcherPath, `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [worker, root, sha, outcomes, resultPath] = process.argv.slice(2);
const run = () => new Promise((resolve) => {
  const child = spawn(process.execPath, [worker, root, sha, outcomes], { stdio: 'ignore' });
  child.on('close', (code) => resolve(code));
});
Promise.all([run(), run()]).then((codes) => {
  fs.writeFileSync(resultPath, JSON.stringify(codes));
});
`, 'utf8');
  const concurrentResultPath = path.join(issueLedgerSandbox, 'concurrent-result.json');
  const concurrentRun = spawnSync(
    process.execPath,
    [
      launcherPath,
      workerPath,
      issueLedgerSandbox,
      concurrentSha,
      concurrentOutcomes,
      concurrentResultPath,
    ],
    { cwd: issueLedgerSandbox, encoding: 'utf8', timeout: 10_000 },
  );
  assert.equal(concurrentRun.status, 0, concurrentRun.stderr);
  const concurrentCodes = JSON.parse(
    fs.readFileSync(concurrentResultPath, 'utf8'),
  ).sort();
  assert.deepEqual(concurrentCodes, [0, 1]);
  const outcomes = fs.readFileSync(concurrentOutcomes, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(outcomes.filter((item) => item.status === 'reserved').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
  assert.match(
    outcomes.find((item) => item.status === 'rejected').message,
    /仍由活动进程|已消费/,
  );
} finally {
  fs.rmSync(issueLedgerSandbox, { recursive: true, force: true });
}

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
function reflectionHandoff(leastConfidence, biggestMissing) {
  return `${completeHandoff}
least-confidence: ${leastConfidence}
biggest-missing: ${biggestMissing}`;
}

function reflectionPrBody(leastConfidence, biggestMissing) {
  return `
## Issue / 会话交接
- **Issue**: Refs #81
- **当前 owner / 模型**: Codex
- **交接状态**: 待复核
- **下一 owner / 触发条件**: non-author reviewer 在 fixed SHA 可用后复核
- **未完成 follow-up**: #81

## 任务身份
- **task id**: GOV-004-reflection-regression
- **owner / author**: Codex
- **reviewer**: non-author reviewer
- **base SHA**: 874631d
- **worktree**: isolated-worktree

## 变更摘要
- **当前状态 → 目标状态**: 弱回答可绕过 → 弱回答 fail-closed

## 文件所有权
- **owned files**: scripts/claude-task.cjs
- **excluded files**: .github/workflows/**
- **ABC / 共享事实链影响**: 不涉及业务事实

## 验证
- BDD / 验收：双入口对抗语料等价
- 测试与真数据 / golden 证据：Node22 selftest
- agent preflight / drift check：PASS
- \`git diff --check\`：PASS

## 迁移、回滚与边界
- **迁移方式**: 无迁移
- **回滚方式**: revert commit
- **未覆盖边界**: 不修改 workflow

## 反盲区自检
- **我现在最没把握的是什么？ / Least confidence**: ${leastConfidence}
- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: ${biggestMissing}
`;
}

function wrapListFence(body, opener = '- ```md', indentation = '  ') {
  return `${opener}
${body.split('\n').map((line) => `${indentation}${line}`).join('\n')}
${indentation}\`\`\``;
}

function wrapTopLevelFence(body) {
  return `\`\`\`md
${body}
\`\`\``;
}

function wrapBlockquoteFence(body) {
  return `> \`\`\`md
${body.split('\n').map((line) => `> ${line}`).join('\n')}
> \`\`\``;
}

function wrapBlockquoteListFence(body) {
  return `> - \`\`\`md
${body.split('\n').map((line) => `>   ${line}`).join('\n')}
>   \`\`\``;
}

function wrapRawHtmlBlock(tag, body) {
  return `<${tag}>
${compactMarkdown(body)}
</${tag}>`;
}

function wrapMultilineRawHtmlBlock(tag, body) {
  return `<${tag}
 data-mode="hidden">
${compactMarkdown(body)}
</${tag}>`;
}

function wrapDelimitedRawHtmlBlock(opening, closing, body) {
  return `${opening}
${body}
${closing}`;
}

function prependWithoutBlank(prefix, body) {
  return `${prefix}
${body.trimStart()}`;
}

function compactMarkdown(body) {
  return body.trim().replace(/\n[ \t]*\n/gu, '\n');
}

function wrapBlockquoteType6(body) {
  return `> <table>
${compactMarkdown(body).split('\n').map((line) => `> ${line}`).join('\n')}`;
}

function wrapListType6(body) {
  return `- <table>
${compactMarkdown(body).split('\n').map((line) => `  ${line}`).join('\n')}`;
}

function wrapBlockquoteListType6(body) {
  return `> - <table>
${compactMarkdown(body).split('\n').map((line) => `>   ${line}`).join('\n')}`;
}

function wrapVisibleList(body) {
  return `- authored contract
${body.trim().split('\n').map((line) => `  ${line}`).join('\n')}`;
}

function wrapBlockquote(body) {
  return body.trim().split('\n').map((line) => `> ${line}`).join('\n');
}

function wrapNestedList(body) {
  return `- outer
  - authored contract
${body.trim().split('\n').map((line) => `    ${line}`).join('\n')}`;
}

function wrapTable(body) {
  return body.trim().split('\n').map((line) => `| ${line || ' '} |`).join('\n');
}

function convertLineEndings(body, endings) {
  const lines = body.split('\n');
  return lines.map((line, index) =>
    index === lines.length - 1 ? line : `${line}${endings[index % endings.length]}`).join('');
}

function replaceMarkdownSyntaxSeparator(body, replacement) {
  return body
    .replace(/^## /gm, `##${replacement}`)
    .replace(/^- /gm, `-${replacement}`);
}

const reflectionRegressionFailures = [];
const strongLeastConfidence =
  'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes';
const strongBiggestMissing =
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability';

function checkVisibilitySemantics(name, wrap, expectedOk) {
  const handoffOk = handoffFieldErrors(
    wrap(reflectionHandoff(strongLeastConfidence, strongBiggestMissing)),
  ).length === 0;
  const prResult = validatePrBody(
    wrap(reflectionPrBody(strongLeastConfidence, strongBiggestMissing)),
  );
  if (handoffOk !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: Issue handoff expected ok=${expectedOk}, actual=${handoffOk}`,
    );
  }
  if (prResult.ok !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: PR validator expected ok=${expectedOk}, actual=${prResult.ok} (${prResult.errors.join('; ')})`,
    );
  }
  if (handoffOk !== prResult.ok) {
    reflectionRegressionFailures.push(`${name}: validators disagree`);
  }
}

for (const [name, wrap] of [
  ['top-level fenced contract is hidden', wrapTopLevelFence],
  ['list fenced contract is hidden', wrapListFence],
  ['ordered-list fenced contract is hidden', (body) => wrapListFence(body, '1. ```md', '   ')],
  ['nested-list fenced contract is hidden', (body) => wrapListFence(body, '- - ```md', '    ')],
  ['blockquote fenced contract is hidden', wrapBlockquoteFence],
  ['proper blockquote-list fenced contract is hidden', wrapBlockquoteListFence],
  ['raw pre contract is hidden', (body) => wrapRawHtmlBlock('pre', body)],
  ['raw code contract is hidden', (body) => wrapRawHtmlBlock('code', body)],
  ['raw div contract is hidden', (body) => wrapRawHtmlBlock('div', body)],
  ['multiline pre opener contract is hidden', (body) => wrapMultilineRawHtmlBlock('pre', body)],
  ['multiline script opener contract is hidden', (body) => wrapMultilineRawHtmlBlock('script', body)],
  ['multiline style opener contract is hidden', (body) => wrapMultilineRawHtmlBlock('style', body)],
  ['multiline textarea opener contract is hidden', (body) => wrapMultilineRawHtmlBlock('textarea', body)],
  [
    'raw HTML comment contract is hidden',
    (body) => wrapDelimitedRawHtmlBlock('<!--', '-->', body),
  ],
  [
    'processing instruction contract is hidden',
    (body) => wrapDelimitedRawHtmlBlock('<?hidden', '?>', body),
  ],
  [
    'declaration contract is hidden',
    (body) => wrapDelimitedRawHtmlBlock('<!DOCTYPE hidden', '>', body),
  ],
  [
    'CDATA contract is hidden',
    (body) => wrapDelimitedRawHtmlBlock('<![CDATA[', ']]>', body),
  ],
  ['unclosed pre contract is hidden to EOF', (body) => `<pre\n data-mode="hidden"\n${body}`],
  ['raw xmp container is hidden', (body) => wrapRawHtmlBlock('xmp', body)],
  [
    'multiline raw div opener contract is hidden',
    (body) => wrapMultilineRawHtmlBlock('DiV', body),
  ],
  [
    'unclosed raw xmp block hides to EOF',
    (body) => `<XmP data-mode="hidden">\n${compactMarkdown(body)}`,
  ],
  [
    'nested raw HTML containers are hidden',
    (body) => `<DiV data-mode="hidden">
<code>
${compactMarkdown(body)}
</code>
</DiV>`,
  ],
  ['blockquote Type6 contract is hidden', wrapBlockquoteType6],
  ['list Type6 contract is hidden', wrapListType6],
  ['proper blockquote-list Type6 contract is hidden', wrapBlockquoteListType6],
  [
    'Setext equals leaf permits a following Type7 block',
    (body) => prependWithoutBlank('Leaf heading\n===\n<custom-element>', body),
  ],
  [
    'Setext dash leaf permits a following Type7 block',
    (body) => prependWithoutBlank('Leaf heading\n---\n<custom-element>', body),
  ],
  [
    'link-reference leaf permits a following Type7 block',
    (body) => prependWithoutBlank('[leaf]: /url\n<custom-element>', body),
  ],
  [
    'link-reference leaf with a title permits a following Type7 block',
    (body) => prependWithoutBlank(
      '[leaf]: &lt;https://example.invalid&gt; "title"\n<custom-element>',
      body,
    ),
  ],
  [
    'multiline link-reference title permits a following Type7 block',
    (body) => prependWithoutBlank(
      '[leaf]: /url\n  "title"\n<custom-element>',
      body,
    ),
  ],
  [
    'multiline link-reference destination and title permit a following Type7 block',
    (body) => prependWithoutBlank(
      '[leaf]:\n  /url\n  "title"\n<custom-element>',
      body,
    ),
  ],
  [
    'ordered-list fence retains content at the real marker width',
    (body) => `100. \`\`\`md
${body.trim().split('\n').map((line) => `     ${line}`).join('\n')}`,
  ],
  [
    'self-closing pre hides content until a blank line',
    (body) => `<pre/>
${body.trimStart()}`,
  ],
]) {
  checkVisibilitySemantics(name, wrap, false);
}
for (const [name, wrap, expectedOk] of [
  ['visible list contract is authored content', wrapVisibleList, true],
  ['visible blockquote contract is quoted content', wrapBlockquote, false],
  ['visible nested-list contract is outside canonical shape', wrapNestedList, false],
  ['table-cell contract is outside canonical shape', wrapTable, false],
  [
    'blockquote fence ends when its container exits',
    (body) => prependWithoutBlank('> ```md', body),
    true,
  ],
  [
    'blockquote product HTML ends when its container exits',
    (body) => prependWithoutBlank('> <div>', body),
    true,
  ],
  [
    'list fence ends when its container exits',
    (body) => prependWithoutBlank('- ```md', body),
    true,
  ],
  [
    'list product HTML ends when its container exits',
    (body) => prependWithoutBlank('- <div>', body),
    true,
  ],
  [
    'nested blockquote-list fence ends when its container exits',
    (body) => prependWithoutBlank('> - ```md', body),
    true,
  ],
  [
    'backtick info containing a backtick is not a fence',
    (body) => prependWithoutBlank('```foo`bar', body),
    true,
  ],
  [
    'Type6 opening tag rejects a non-tag slash suffix',
    (body) => prependWithoutBlank('<div/not-a-tag', body),
    true,
  ],
  [
    'Type6 closing tag rejects a non-tag slash suffix',
    (body) => prependWithoutBlank('</table/not-a-tag', body),
    true,
  ],
  [
    'paragraph hanging indent remains paragraph content',
    (body) => prependWithoutBlank(
      'paragraph text\n    hanging continuation\n<custom-element>',
      body,
    ),
    true,
  ],
  [
    'ordered-list fence exits below the real marker width',
    (body) => `100. \`\`\`md
${body.trim().split('\n').map((line) => `  ${line}`).join('\n')}`,
    true,
  ],
  [
    'self-closing pre ends at a blank line',
    (body) => `<pre/>
hidden-before-blank

${body.trimStart()}`,
    true,
  ],
  [
    'invalid link-reference syntax remains paragraph content',
    (body) => prependWithoutBlank(
      '[leaf]: /url "title" trailing\n<custom-element>',
      body,
    ),
    true,
  ],
]) {
  checkVisibilitySemantics(name, wrap, expectedOk);
}
checkVisibilitySemantics(
  'tilde fence info may contain a backtick',
  (body) => prependWithoutBlank('~~~foo`bar', body),
  false,
);

for (const [name, input, visible, hidden] of [
  [
    'CommonMark type 6 ends at a blank line',
    '<table>\nhidden-type-6\n\nvisible-after-type-6',
    ['visible-after-type-6'],
    ['hidden-type-6'],
  ],
  [
    'CommonMark type 7 ends at a blank line',
    '<custom-element data-mode="hidden">\nhidden-type-7\n\nvisible-after-type-7',
    ['visible-after-type-7'],
    ['hidden-type-7'],
  ],
  [
    'CommonMark type 7 does not interrupt a paragraph',
    'paragraph text\n<custom-element>\nvisible-paragraph-continuation',
    ['paragraph text', 'custom-element', 'visible-paragraph-continuation'],
    [],
  ],
  [
    'encoded div remains visible inline text across blank lines',
    '&lt;DiV data-mode="hidden"&gt;\nhidden-div-before\n\nhidden-div-after\n&lt;/dIv&gt;\nvisible-after-div',
    ['hidden-div-before', 'hidden-div-after', 'visible-after-div'],
    [],
  ],
]) {
  const output = stripIgnoredMarkdown(input);
  for (const value of visible) {
    if (!output.includes(value)) reflectionRegressionFailures.push(`${name}: ${value} was hidden`);
  }
  for (const value of hidden) {
    if (output.includes(value)) reflectionRegressionFailures.push(`${name}: ${value} remained visible`);
  }
}

const prStrongLeastConfidenceLine =
  `- **我现在最没把握的是什么？ / Least confidence**: ${strongLeastConfidence}`;
const handoffStrongLeastConfidenceLine = `least-confidence: ${strongLeastConfidence}`;
const prStrongBiggestMissingLine =
  `- **关于当前局面，我可能遗漏的最大问题是什么？ / Biggest missing**: ${strongBiggestMissing}`;
const handoffStrongBiggestMissingLine = `biggest-missing: ${strongBiggestMissing}`;
for (const [name, handoffField, prField, destination] of [
  [
    'multiline link-reference label hides least-confidence',
    handoffStrongLeastConfidenceLine,
    prStrongLeastConfidenceLine,
    '/least',
  ],
  [
    'multiline link-reference label hides biggest-missing',
    handoffStrongBiggestMissingLine,
    prStrongBiggestMissingLine,
    '/biggest',
  ],
]) {
  const wrapHandoff = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
    .replace(handoffField, `
[
${handoffField}
]: ${destination}`);
  const wrapPr = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(prField, `
[
${prField}
]: ${destination}`);
  const handoffOk = handoffFieldErrors(wrapHandoff).length === 0;
  const prOk = validatePrBody(wrapPr).ok;
  if (handoffOk || prOk || handoffOk !== prOk) {
    reflectionRegressionFailures.push(
      `${name}: hidden field accepted (handoff=${handoffOk}, pr=${prOk})`,
    );
  }
}
{
  const deepHandoffLabel = reflectionHandoff(
    strongLeastConfidence,
    strongBiggestMissing,
  ).replace(
    `trigger: API fix merged
${handoffStrongLeastConfidenceLine}
${handoffStrongBiggestMissingLine}`,
    `
[
extra-label-line
${handoffStrongLeastConfidenceLine}
${handoffStrongBiggestMissingLine}
trigger: API fix merged
]: /hidden-reflection`,
  );
  const deepPrLabel = reflectionPrBody(
    strongLeastConfidence,
    strongBiggestMissing,
  ).replace(
    `${prStrongLeastConfidenceLine}
${prStrongBiggestMissingLine}`,
    `[
extra-label-line
${prStrongLeastConfidenceLine}
${prStrongBiggestMissingLine}
- **padding-field**: absorbs-terminator
]: /hidden-reflection`,
  );
  const handoffOk = handoffFieldErrors(deepHandoffLabel).length === 0;
  const prOk = validatePrBody(deepPrLabel).ok;
  if (handoffOk || !prOk) {
    reflectionRegressionFailures.push(
      `deep multiline label block semantics diverged (handoff=${handoffOk}, pr=${prOk})`,
    );
  }
}
for (const marker of ['-', '1.']) {
  for (const indentation of [1, 2, 3, 4]) {
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${marker}\t\`\`\`md
${' '.repeat(indentation)}${handoffStrongLeastConfidenceLine}
    \`\`\``,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${marker}\t\`\`\`md
${' '.repeat(indentation)}${prStrongLeastConfidenceLine}
    \`\`\``,
      );
    const handoffOk = handoffFieldErrors(handoffBody).length === 0;
    const prOk = validatePrBody(prBody).ok;
    // The plain field opens a root paragraph, so the surviving four-space
    // closing-looking line is content. In PR form, 1–2-space field markers
    // put that orphan fence inside the reflection item's content column; three
    // spaces exits beyond it, while four spaces keeps the field hidden.
    const expectedHandoffOk = false;
    const expectedPrOk = indentation === 3;
    if (handoffOk !== expectedHandoffOk || prOk !== expectedPrOk) {
      reflectionRegressionFailures.push(
        `${marker} tab-list fence ${indentation}-space indent mismatch ` +
        `(expected-handoff=${expectedHandoffOk}, handoff=${handoffOk}, ` +
        `expected-pr=${expectedPrOk}, pr=${prOk})`,
      );
    }
  }
}
for (const [name, opener] of [
  ['blockquote tab-list fence', '> -\t```md'],
  ['nested tab-list fence', '- -\t```md'],
  ['blockquote nested tab-list fence', '> - -\t```md'],
]) {
  for (const indentation of [1, 2, 3, 4]) {
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${opener}
${' '.repeat(indentation)}${handoffStrongLeastConfidenceLine}
    \`\`\``,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${opener}
${' '.repeat(indentation)}${prStrongLeastConfidenceLine}
    \`\`\``,
      );
    const handoffOk = handoffFieldErrors(handoffBody).length === 0;
    const prOk = validatePrBody(prBody).ok;
    // Container exit leaves a root hanging indent in plain handoff format. In
    // PR form the orphan fence remains in a 1–2-space reflection item's
    // content column, exits a three-space item, and hides a four-space field.
    const expectedHandoffOk = false;
    const expectedPrOk = indentation === 3;
    if (handoffOk !== expectedHandoffOk || prOk !== expectedPrOk) {
      reflectionRegressionFailures.push(
        `${name} ${indentation}-space indent mismatch ` +
        `(expected-handoff=${expectedHandoffOk}, handoff=${handoffOk}, ` +
        `expected-pr=${expectedPrOk}, pr=${prOk})`,
      );
    }
  }
}
for (const [name, transform] of [
  [
    'ordered tab-list fence closes before visible contract',
    (body) => `1.\t\`\`\`md
 hidden code
    \`\`\`
${body}`,
  ],
  [
    'list padding beyond four columns does not open a fence',
    (body) => `-     \`\`\`md
${body}`,
  ],
]) {
  checkVisibilitySemantics(name, transform, true);
}
for (const [name, handoffPrefix, prPrefix] of [
  [
    'multiline link-reference cannot interrupt paragraph',
    'paragraph continuation\n[',
    'paragraph continuation\n[',
  ],
  [
    'multiline link-reference ends at blockquote container exit',
    '> [',
    '> [',
  ],
]) {
  const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
    .replace(
      handoffStrongLeastConfidenceLine,
      `${handoffPrefix}
${handoffStrongLeastConfidenceLine}
]: /least`,
    );
  const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(
      prStrongLeastConfidenceLine,
      `${prPrefix}
${prStrongLeastConfidenceLine}
]: /least`,
    );
  const handoffOk = handoffFieldErrors(handoffBody).length === 0;
  const prOk = validatePrBody(prBody).ok;
  if (handoffOk || prOk || handoffOk !== prOk) {
    reflectionRegressionFailures.push(
      `${name}: visible multiline-link tail was ignored ` +
      `(handoff=${handoffOk}, pr=${prOk})`,
    );
  }
}
const lazyContinuationPayloads = [
  ['plain text', 'lazy continuation'],
  ['raw Tab', 'lazy\tcontinuation'],
  ['named Tab entity', 'lazy&Tab;continuation'],
  ['numeric Tab entity', 'lazy&#9;continuation'],
  ['nested named Tab entity', 'lazy&amp;Tab;continuation'],
  ['nested numeric Tab entity', 'lazy&amp;#9;continuation'],
  ['ordered start zero period', '0. x=42'],
  ['ordered start two period', '2. x=42'],
  ['ordered start two parenthesis', '2) x=42'],
  ['empty unordered marker', '-'],
  ['empty ordered one marker', '1.'],
  ['empty ordered two marker', '2.'],
];
const lazyContinuationLineEndings = [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['lone CR', '\r'],
];
const ambiguousUnknownContinuationPayloads = [
  ['URL scheme', 'https://example.test/proof'],
  ['encoded-colon URL', 'https&colon;//example.test/proof'],
  ['nested encoded-colon URL', 'https&amp;colon;//example.test/proof'],
  ['mailto address', 'mailto:security@example.test'],
  ['Windows path', 'C:\\proof\\artifact.txt'],
  ['equation', 'x=42'],
];
const unknownBoundaryMimicPayloads = [
  ['space-before-delimiter equation', 'x = 42', '  x = 42'],
  ['space-padded equation', 'x= 42', '  x= 42'],
  ['Tab-padded equation', 'x=\t42', '  x=\t42'],
  ['entity-delimited equation', 'x&#61; 42', '  x&#61; 42'],
  ['nested-entity-delimited equation', 'x&amp;#61; 42', '  x&amp;#61; 42'],
  ['spaced URL scheme', 'https: //example.test/proof', '  https: //example.test/proof'],
  ['spaced mailto scheme', 'mailto: security@example.test', '  mailto: security@example.test'],
  ['unpadded custom namespace', 'custom-note:value', '  custom-note:value'],
  ['empty custom namespace value', 'custom-note: ', '  custom-note: '],
];
const hangingContinuationPayloads = [
  ['four-space hanging indent', '    lazy&amp;#9;continuation'],
  ['raw-Tab hanging indent', '\tlazy&amp;#9;continuation'],
];
const rootFenceLikeHangingContinuationPayloads = [
  ['four-space backtick fence-shaped continuation', '    ```md'],
  ['raw-Tab backtick fence-shaped continuation', '\t```md'],
  ['four-space tilde fence-shaped continuation', '    ~~~md'],
  ['raw-Tab tilde fence-shaped continuation', '\t~~~md'],
];
const prFenceLikeHangingContinuationPayloads = [
  ['backtick fence-shaped list continuation', '    ```md', '      ```md'],
  ['tilde fence-shaped list continuation', '    ~~~md', '      ~~~md'],
];
const emptyKeyContinuationPayloads = [
  ['ASCII colon', ': arbitrary continuation'],
  ['fullwidth colon', '： arbitrary continuation'],
  ['named colon entity', '&colon; arbitrary continuation'],
  ['nested numeric colon entity', '&amp;#58; arbitrary continuation'],
  ['empty HTML key', '<b></b>: arbitrary continuation'],
];
const issueMarkdownBlockBoundaries = [
  ['ATX heading', '## Supplemental: evidence'],
  ['blockquote', '> supplemental: evidence'],
  ['unordered list item', '- supplemental: evidence'],
  ['ordered list item', '1. supplemental: evidence'],
];
const prMarkdownBlockBoundary = '- **Supplemental**: evidence';
const prPeerBlockBoundaries = [
  ['empty peer block', '-'],
  ['empty ordered peer block', '2.'],
  ['non-one ordered peer block', '2. x=42'],
  ['equation peer block', '- **x**= 42'],
  ['URL peer block', '- **https**: //example.test/proof'],
  ['unpadded custom peer block', '- **custom-note**:value'],
  ['empty custom peer block', '- **custom-note**: '],
  ['empty-key peer block', '- **:** arbitrary continuation'],
];
for (const [endingName, lineEnding] of lazyContinuationLineEndings) {
  for (const [payloadName, payload] of lazyContinuationPayloads) {
    const direct = parseReflectionContract(
      `${strongLeastConfidence}${lineEnding}${payload}`,
    );
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${payload}`,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${prStrongLeastConfidenceLine}${lineEnding}  ${payload}`,
      );
    const handoffOk = handoffFieldErrors(handoffBody).length === 0;
    const prOk = validatePrBody(prBody).ok;
    if (direct.ok || handoffOk || prOk || handoffOk !== prOk) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName}: lazy continuation bypassed validation ` +
        `(direct=${direct.ok}, handoff=${handoffOk}, pr=${prOk})`,
      );
    }
  }
}
for (const [endingName, lineEnding] of lazyContinuationLineEndings) {
  for (const [payloadName, payload] of ambiguousUnknownContinuationPayloads) {
    const direct = parseReflectionContract(
      `${strongLeastConfidence}${lineEnding}${payload}`,
    );
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${payload}`,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${prStrongLeastConfidenceLine}${lineEnding}  ${payload}`,
      );
    const handoffOk = handoffFieldErrors(handoffBody).length === 0;
    const prOk = validatePrBody(prBody).ok;
    if (direct.ok || handoffOk || prOk || handoffOk !== prOk) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName}: ambiguous unknown wire bypassed validation ` +
        `(direct=${direct.ok}, handoff=${handoffOk}, pr=${prOk})`,
      );
    }
  }
  for (const [payloadName, handoffPayload, prPayload] of unknownBoundaryMimicPayloads) {
    const direct = parseReflectionContract(
      `${strongLeastConfidence}${lineEnding}${handoffPayload}`,
    );
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${handoffPayload}`,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${prStrongLeastConfidenceLine}${lineEnding}${prPayload}`,
      );
    const handoffFields = collectHandoffFields(handoffBody);
    const handoffErrors = handoffFieldErrors(handoffBody);
    const handoffRaw = handoffFields.rawValues.get('least-confidence');
    const prResult = validatePrBody(prBody);
    if (
      direct.ok ||
      parseReflectionContract(handoffRaw || '').ok ||
      !handoffErrors.includes('least-confidence') ||
      prResult.ok
    ) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName}: non-custom field-shaped continuation truncated raw ` +
        `(direct=${direct.ok}, raw=${JSON.stringify(handoffRaw)}, ` +
        `handoff-errors=${handoffErrors.join('|')}, pr=${prResult.ok})`,
      );
    }
  }
  for (const [payloadName, payload] of hangingContinuationPayloads) {
    const direct = parseReflectionContract(
      `${strongLeastConfidence}${lineEnding}${payload}`,
    );
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${payload}`,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${prStrongLeastConfidenceLine}${lineEnding}${payload}`,
      );
    const handoffOk = handoffFieldErrors(handoffBody).length === 0;
    const prOk = validatePrBody(prBody).ok;
    if (direct.ok || handoffOk || prOk || handoffOk !== prOk) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName}: hanging continuation escaped the open paragraph ` +
        `(direct=${direct.ok}, handoff=${handoffOk}, pr=${prOk})`,
      );
    }
  }
  for (const [payloadName, handoffPayload] of rootFenceLikeHangingContinuationPayloads) {
    const direct = parseReflectionContract(
      `${strongLeastConfidence}${lineEnding}${handoffPayload}`,
    );
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${handoffPayload}`,
      );
    const handoffFields = collectHandoffFields(handoffBody);
    const handoffErrors = handoffFieldErrors(handoffBody);
    const handoffRaw = handoffFields.rawValues.get('least-confidence');
    if (
      direct.ok ||
      parseReflectionContract(handoffRaw || '').ok ||
      !handoffErrors.includes('least-confidence')
    ) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName}: surviving fence-shaped indent escaped raw ` +
        `(direct=${direct.ok}, raw=${JSON.stringify(handoffRaw)}, ` +
        `handoff-errors=${handoffErrors.join('|')})`,
      );
    }
  }
  for (
    const [payloadName, directPayload, prPayload]
    of prFenceLikeHangingContinuationPayloads
  ) {
    const direct = parseReflectionContract(
      `${strongLeastConfidence}${lineEnding}${directPayload}`,
    );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${prStrongLeastConfidenceLine}${lineEnding}${prPayload}`,
      );
    const prResult = validatePrBody(prBody);
    if (direct.ok || prResult.ok) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName}: list-content indent escaped PR reflection ` +
        `(direct=${direct.ok}, pr=${prResult.ok})`,
      );
    }
  }
  for (const [payloadName, payload] of emptyKeyContinuationPayloads) {
    const direct = parseReflectionContract(
      `${strongLeastConfidence}${lineEnding}${payload}`,
    );
    const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${payload}`,
      );
    const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${prStrongLeastConfidenceLine}${lineEnding}  ${payload}`,
      );
    const handoffFields = collectHandoffFields(handoffBody);
    const prFields = collectFields(stripIgnoredMarkdown(prBody));
    const handoffRaw = handoffFields.rawValues.get('least-confidence');
    const prLeastConfidenceKey = [...prFields.rawValues.keys()].find((key) =>
      key.includes('least confidence'));
    const prRaw = prFields.rawValues.get(prLeastConfidenceKey);
    const handoffErrors = handoffFieldErrors(handoffBody);
    const prResult = validatePrBody(prBody);
    if (
      direct.reason !== 'control-character' ||
      parseReflectionContract(handoffRaw || '').reason !== 'control-character' ||
      !handoffErrors.includes('least-confidence') ||
      parseReflectionContract(prRaw || '').reason !== 'control-character' ||
      prResult.ok
    ) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName}: empty-key continuation truncated reflection raw ` +
        `(direct=${direct.reason}, handoff-raw=${JSON.stringify(handoffRaw)}, ` +
        `handoff-errors=${handoffErrors.join('|')}, pr-raw=${JSON.stringify(prRaw)}, ` +
        `pr=${prResult.ok})`,
      );
    }
  }
  for (const [blockName, handoffBlock] of issueMarkdownBlockBoundaries) {
    const direct = parseReflectionContract(
      `${strongLeastConfidence}${lineEnding}${handoffBlock}`,
    );
    const handoffAfter = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${handoffBlock}`,
      );
    const handoffBefore = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(
        handoffStrongLeastConfidenceLine,
        `${handoffBlock}${lineEnding}${handoffStrongLeastConfidenceLine}`,
      );
    const afterErrors = handoffFieldErrors(handoffAfter);
    const beforeErrors = handoffFieldErrors(handoffBefore);
    if (direct.ok || afterErrors.length !== 0 || beforeErrors.length !== 0) {
      reflectionRegressionFailures.push(
        `${endingName}/${blockName}: Issue block boundary depends on field order ` +
        `(direct=${direct.ok}, after=${afterErrors.join('|')}, ` +
        `before=${beforeErrors.join('|')})`,
      );
    }
  }
  const directPrBlock = parseReflectionContract(
    `${strongLeastConfidence}${lineEnding}${prMarkdownBlockBoundary}`,
  );
  const prAfter = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(
      prStrongLeastConfidenceLine,
      `${prStrongLeastConfidenceLine}${lineEnding}${prMarkdownBlockBoundary}`,
    );
  const prBefore = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(
      prStrongLeastConfidenceLine,
      `${prMarkdownBlockBoundary}${lineEnding}${prStrongLeastConfidenceLine}`,
    );
  const prAfterResult = validatePrBody(prAfter);
  const prBeforeResult = validatePrBody(prBefore);
  if (directPrBlock.ok || !prAfterResult.ok || !prBeforeResult.ok) {
    reflectionRegressionFailures.push(
      `${endingName}: independent PR block boundary depends on field order ` +
      `(direct=${directPrBlock.ok}, after=${prAfterResult.ok}, ` +
      `before=${prBeforeResult.ok})`,
    );
  }
  for (const [blockName, peerBlock] of prPeerBlockBoundaries) {
    const peerAfter = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${prStrongLeastConfidenceLine}${lineEnding}${peerBlock}`,
      );
    const peerBefore = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace(
        prStrongLeastConfidenceLine,
        `${peerBlock}${lineEnding}${prStrongLeastConfidenceLine}`,
      );
    const peerAfterResult = validatePrBody(peerAfter);
    const peerBeforeResult = validatePrBody(peerBefore);
    if (!peerAfterResult.ok || !peerBeforeResult.ok) {
      reflectionRegressionFailures.push(
        `${endingName}/${blockName}: real peer block depends on reflection order ` +
        `(after=${peerAfterResult.ok}, before=${peerBeforeResult.ok})`,
      );
    }
  }
}
for (const [name, handoffUnknownField, prUnknownField] of [
  ['colon unknown boundary', 'custom-note: value', '- **custom-note**: value'],
  ['equals unknown boundary', 'custom_note= value', '- **custom_note**= value'],
  ['raw-Tab padded unknown boundary', 'custom-tab:\tvalue', '- **custom-tab**:\tvalue'],
  ['internal underscore custom boundary', 'custom-leas_t: value', '- **custom-leas_t**: value'],
]) {
  const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
    .replace(
      handoffStrongLeastConfidenceLine,
      `${handoffStrongLeastConfidenceLine}\n${handoffUnknownField}`,
    );
  const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(
      prStrongLeastConfidenceLine,
      `${prStrongLeastConfidenceLine}\n${prUnknownField}`,
    );
  const handoffFields = collectHandoffFields(handoffBody);
  const prFields = collectFields(stripIgnoredMarkdown(prBody));
  const directHandoffOk = parseReflectionContract(
    handoffFields.rawValues.get('least-confidence'),
  ).ok;
  const prLeastConfidenceKey = [...prFields.rawValues.keys()].find((key) =>
    key.includes('least confidence'));
  const directPrOk = parseReflectionContract(
    prFields.rawValues.get(prLeastConfidenceKey),
  ).ok;
  const handoffOk = handoffFieldErrors(handoffBody).length === 0;
  const prOk = validatePrBody(prBody).ok;
  if (!directHandoffOk || !directPrOk || !handoffOk || !prOk) {
    reflectionRegressionFailures.push(
      `${name}: legitimate unknown boundary lost parity ` +
      `(direct-handoff=${directHandoffOk}, direct-pr=${directPrOk}, ` +
      `handoff=${handoffOk}, pr=${prOk})`,
    );
  }
}
const rawLazyHandoffFields = collectHandoffFields(
  reflectionHandoff(strongLeastConfidence, strongBiggestMissing).replace(
    handoffStrongLeastConfidenceLine,
    `${handoffStrongLeastConfidenceLine}\nlazy&amp;Tab;continuation`,
  ),
);
assert.equal(
  rawLazyHandoffFields.rawValues.get('least-confidence'),
  `${strongLeastConfidence}\nlazy&amp;Tab;continuation`,
  'Issue collector must preserve the complete raw multiline reflection without predecoding',
);
for (const [name, wrap] of [
  ['list-fence hidden strong value', wrapListFence],
  ['raw-pre hidden strong value', (body) => wrapRawHtmlBlock('pre', body)],
  ['raw-code hidden strong value', (body) => wrapRawHtmlBlock('code', body)],
  ['raw-div hidden strong value', (body) => wrapRawHtmlBlock('div', body)],
]) {
  const handoffBody = reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
    .replace(
      handoffStrongLeastConfidenceLine,
      `${wrap(handoffStrongLeastConfidenceLine)}
least-confidence: 暂无问题`,
    );
  const prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
    .replace(
      prStrongLeastConfidenceLine,
      `${wrap(prStrongLeastConfidenceLine)}
- **我现在最没把握的是什么？ / Least confidence**: 暂无问题`,
    );
  const handoffOk = handoffFieldErrors(handoffBody).length === 0;
  const prOk = validatePrBody(prBody).ok;
  if (handoffOk || prOk || handoffOk !== prOk) {
    reflectionRegressionFailures.push(
      `${name}: hidden strong value masked visible weak value (handoff=${handoffOk}, pr=${prOk})`,
    );
  }
}

const adversarialReflectionCorpus = [
  ['unresolved nested NoBreak entity', '&amp;NoBreak;', false],
  ['unresolved nested InvisibleTimes entity', '&amp;InvisibleTimes;', false],
  ['bold-wrapped TODO', '**TODO** later fill this', false],
  ['inline-code-wrapped TODO', '`TODO` later fill this', false],
  ['encoded HTML-wrapped TODO', '&lt;strong&gt;TODO&lt;/strong&gt; later fill this', false],
  ['default-ignorable TODO', 'T\uFE0FO\u034FD\uFE0FO later fill this', false],
  ['fullwidth NFKC TODO', 'ＴＯＤＯ later fill this', false],
  ['pure punctuation', '?', false],
  ['generic risk word', '风险', false],
  ['prefixed TODO', '风险：TODO later fill this', false],
  ['empty no-finding clauses', '未发现；已检查；未检查', false],
  ['action-only no-finding scopes', '未发现；已检查验证；未检查审查', false],
  ['alternate action-only no-finding scopes', '没有发现；已经核对过覆盖；仍未验证检查', false],
  ['bare 没发现问题 synonym', '没发现问题', false],
  ['bare 暂无问题 synonym', '暂无问题', false],
  ['bare 未见问题 synonym', '未见问题', false],
  ['bare 一切正常 synonym', '一切正常', false],
  ['bare English no-finding synonym', 'No issues found', false],
  ['bare 无问题 synonym', '无问题', false],
  ['bare 无明显问题 synonym', '无明显问题', false],
  ['temporal 目前未发现问题 synonym', '目前未发现问题', false],
  ['temporal 暂时没发现问题 synonym', '暂时没发现问题', false],
  ['bare No findings synonym', 'No findings', false],
  ['bare Nothing to report synonym', 'Nothing to report', false],
  ['bare All clear synonym', 'All clear', false],
  ['bare LGTM synonym', 'LGTM', false],
  ['temporal observation no-finding synonym', '暂未观察到异常', false],
  ['English risk no-finding synonym', 'No risk identified', false],
  ['generic modifiers plus action-only scopes', '未发现；已检查所有验证；未检查相关审查', false],
  ['generic Chinese inspection nouns', '未发现；已检查所有排查；未检查相关扫描', false],
  [
    'generic English inspection nouns',
    'No issues found; checked all inspections; not checked related scans',
    false,
  ],
  ['bare object without risk state', '生产参数', false],
  ['English bare object without risk state', 'production settings', false],
  ['bare English risk noun', 'risk', false],
  ['bare English issue noun', 'issue', false],
  ['Chinese action-only uncertainty', '未完成检查', false],
  ['English action-only uncertainty', 'Review may be incomplete', false],
  ['English negative error detection', 'No error detected', false],
  ['English negative failure detection', 'No failure detected', false],
  ['Chinese generic work completion', '未完成工作', false],
  ['English generic object failure', 'something may fail', false],
  ['Chinese generic pronoun failure', '它可能失败', false],
  ['Chinese plural demonstrative uncertainty', '这些尚未确认', false],
  ['English singular demonstrative failure', 'that could fail', false],
  ['English plural demonstrative failure', 'these may fail', false],
  ['Chinese leading connector failure', '然后可能失败', false],
  ['Chinese contrast connector problem', '不过可能有问题', false],
  ['Chinese negative detection', '没检测到错误', false],
  ['Chinese negative discovery of anomaly', '未检出异常', false],
  ['Chinese negative discovery of problem', '未查出问题', false],
  ['English nothing-failed form', 'nothing failed', false],
  ['English existential generic risk', 'there may be a risk', false],
  ['generic Chinese thing', '东西可能失败', false],
  ['generic Chinese system', '系统可能失败', false],
  ['generic Chinese service', '服务可能失败', false],
  ['generic Chinese problem event', '问题可能发生', false],
  ['generic Chinese state', '可能不行', false],
  ['generic Chinese place', '某个地方可能出错', false],
  ['generic English stuff', 'stuff may fail', false],
  ['generic English system', 'system may fail', false],
  ['generic English service', 'service may fail', false],
  ['generic English things event', 'things could break', false],
  ['generic English bad event', 'something bad may happen', false],
  ['generic English unknowns', 'unknown unknowns', false],
  ['encoded generic Chinese thing', '东&#35199;可能失败', false],
  ['default-ignorable generic Chinese system', '系\u200D统可能失败', false],
  ['fullwidth generic English system', 'ｓｙｓｔｅｍ may fail', false],
  ['encoded generic English service', 'serv&#105;ce may fail', false],
  ['nested zero-width generic service', 'serv&amp;ZeroWidthSpace;ice may fail', false],
  ['encoded code generic system', '&lt;code&gt;system&lt;/code&gt; may fail', false],
  ['function-word generic English system', 'this system may still fail', false],
  ['function-word generic Chinese thing', '这些东西也许会失败', false],
  ['stacked English function words', 'some service can maybe fail', false],
  ['stacked English category words', 'the generic backend and frontend may break', false],
  ['stacked Chinese function words', '相关系统依然还是可能失败', false],
  ['stacked Chinese modal words', '某种情况大概会出错', false],
  ['encoded stacked English generic', 'syst&#101;m can possibly fail', false],
  ['NFKC stacked English generic', 'ｓｅｒｖｉｃｅ would likely break', false],
  ['two-character Chinese object without qualifier', '缓存可能失败', false],
  ['single lowercase English content token', 'timeout may fail', false],
  ['sentence capitalization is not a proper anchor', 'Timeout may fail', false],
  ['combined Chinese category nouns', '系统服务可能失败', false],
  ['combined English category nouns', 'system service may fail', false],
  [
    'connected action-only no-finding scopes',
    '未发现；已检查验证和复核；未检查审计和扫描',
    false,
  ],
  ['legacy short concrete test risk', '测试覆盖不足', false],
  ['legacy short concrete external-call risk', '外部调用未查', false],
  ['legacy concrete rate-limit measurement risk', '生产限速参数需实测', false],
  ['legacy concrete timeout quantification risk', '生产超时行为待量化', false],
  ['legacy English concrete measurement risk', 'production timeout needs measurement', false],
  ['legacy concrete certificate review risk', '证书轮换窗口需复核', false],
  ['legacy English concrete failure risk', 'payment webhook may fail', false],
  ['legacy Chinese demonstrative with concrete object', '这些支付回调可能失败', false],
  ['legacy English demonstrative with concrete object', 'these payment webhooks may fail', false],
  ['legacy concrete Chinese callback risk', '支付回调可能失败', false],
  ['legacy concrete PostgreSQL timeout risk', 'PostgreSQL 15 lock timeout is unmeasured', false],
  ['legacy concrete checkout retry risk', 'checkout webhook retry policy is unverified', false],
  ['legacy concrete certificate rotation risk', '证书轮换窗口需复核', false],
  ['legacy encoded concrete Chinese callback', '支付回&#35843;可能失败', false],
  ['legacy NFKC concrete PostgreSQL timeout', 'ＰｏｓｔｇｒｅＳＱＬ １５ lock timeout is unmeasured', false],
  ['legacy encoded concrete checkout retry', 'checkout web&#104;ook retry policy is unverified', false],
  ['legacy inline-code proper anchor', '`nginx` is unverified', false],
  ['legacy encoded code proper anchor', '&lt;code&gt;nginx&lt;/code&gt; is unverified', false],
  ['legacy short quoted Chinese proper anchor', '「微信」可能失败', false],
  ['legacy two concrete English anchors', 'payment service retry may fail', false],
  ['legacy concrete English API wording', 'warehouse API timeout is unmeasured', false],
  ['legacy concrete Chinese service wording', '订单服务重试可能失败', false],
  ['legacy explicit proper-name anchor', '`Redis` may fail', false],
  ['legacy qualified Chinese content fragment', '缓存键可能失败', false],
  ['legacy two English content anchors', 'cache eviction may fail', false],
  ['legacy substantive bounded no-finding', '未发现；已检查固定对象和测试，未检查生产参数', false],
  ['legacy generic modifiers with concrete objects', '未发现；已检查所有目标代码；未检查相关生产参数', false],
  [
    'English bounded no-finding',
    'No issues found; checked target code and tests; not checked production settings',
    false,
  ],
  [
    'temporal Chinese bounded no-finding',
    '目前未发现问题；已检查目标代码；未检查生产参数',
    false,
  ],
  [
    'English findings bounded synonym',
    'No findings; checked target code; not checked production settings',
    false,
  ],
  [
    'LGTM bounded synonym',
    'LGTM; checked target code; not checked production settings',
    false,
  ],
  [
    'HTML-like product scopes',
    '未发现；已检查&lt;code-v2&gt;与R&amp;D，未检查&lt;span-v3&gt;',
    false,
  ],
  [
    'concrete objects survive action normalization',
    '未发现；已排查支付回调重试，未扫描仓库外 webhook 配置',
    false,
  ],
];
for (const [name, value, expectedOk] of adversarialReflectionCorpus) {
  const handoffErrors = handoffFieldErrors(reflectionHandoff(
    value,
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  ));
  const handoffOk = !handoffErrors.includes('least-confidence');
  const prResult = validatePrBody(reflectionPrBody(
    value,
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  ));
  if (handoffOk !== expectedOk) {
    reflectionRegressionFailures.push(`${name}: Issue handoff expected ok=${expectedOk}, actual=${handoffOk}`);
  }
  if (prResult.ok !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: PR validator expected ok=${expectedOk}, actual=${prResult.ok} (${prResult.errors.join('; ')})`,
    );
  }
  if (handoffOk !== prResult.ok) {
    reflectionRegressionFailures.push(`${name}: validators disagree`);
  }
}

const typedRisk =
  'risk-v1; anchor=id:Redis; uncertainty=unverified:production failure mode';
const typedNoFinding =
  'no-finding-v1; checked=path:scripts/issue-handoff/check-pr-body.cjs; unchecked=ref:Issue #81';
const rawWirePrefix = 'risk-v1; anchor=id:auth; uncertainty=unknown:';
function encodedContractAtRawBytes(byteLength) {
  const remaining = byteLength - Buffer.byteLength(rawWirePrefix, 'utf8');
  assert.ok(remaining >= 0, 'raw wire boundary must fit the typed prefix');
  const entity = '&#120;';
  return (
    rawWirePrefix +
    entity.repeat(Math.floor(remaining / Buffer.byteLength(entity, 'utf8'))) +
    'x'.repeat(remaining % Buffer.byteLength(entity, 'utf8'))
  );
}
const encodedRawWire6KiB = `${rawWirePrefix}${'&#120;'.repeat(1_000)}`;
const encodedRawWire4096 = encodedContractAtRawBytes(4_096);
const encodedRawWire4097 = encodedContractAtRawBytes(4_097);
assert.equal(Buffer.byteLength(encodedRawWire6KiB, 'utf8'), 6_045);
assert.equal(Buffer.byteLength(encodedRawWire4096, 'utf8'), 4_096);
assert.equal(Buffer.byteLength(encodedRawWire4097, 'utf8'), 4_097);
assert.equal(parseReflectionContract(encodedRawWire6KiB).reason, 'contract-too-long');
assert.equal(parseReflectionContract(encodedRawWire4096).ok, true);
assert.equal(parseReflectionContract(encodedRawWire4097).reason, 'contract-too-long');
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;#120;',
  ).ok,
  true,
);
assert.equal(
  parseReflectionContract(
    'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;bogus;',
  ).reason,
  'unresolved-entity',
);
const naSeparatorCores = [
  ...['n', 'N'].flatMap((letter) =>
    ['', '-', '_', '+', '.', '/'].map((separator) => `${letter}${separator}${letter === 'N' ? 'A' : 'a'}`),
  ),
  'ｎ－ａ',
  ...[45, 95, 43, 46, 47].flatMap((codePoint) => [
    `n&#${codePoint};a`,
    `n&amp;#${codePoint};a`,
    `n&amp;amp;#${codePoint};a`,
  ]),
];
const placeholderComparisonSuffixes = ['', '.', '。', '…', '/_+-', '。/_+-', '   '];
function encodeAmpersands(value, depth) {
  let encoded = value;
  for (let pass = 0; pass < depth; pass += 1) encoded = encoded.replaceAll('&', '&amp;');
  return encoded;
}
const generatedPlaceholderContracts = [];
for (const core of naSeparatorCores) {
  for (const suffix of placeholderComparisonSuffixes) {
    generatedPlaceholderContracts.push(
      [
        `N/A separator risk ${JSON.stringify(core + suffix)}`,
        `risk-v1; anchor=id:auth; uncertainty=unknown:${core}${suffix}`,
        false,
      ],
      [
        `N/A separator no-finding ${JSON.stringify(core + suffix)}`,
        `no-finding-v1; checked=name:${core}${suffix}; unchecked=name:库存同步`,
        false,
      ],
    );
  }
}
for (const core of [
  'unknown&amp;',
  'unknown&amp;amp;',
  'unknown&amp;#38;',
  'unknown&amp;amp',
  'unknown&amp;am',
  'ｕｎｋｎｏｗｎ＆',
  'ｕｎｋｎｏｗｎ＆ａｍｐ',
  encodeAmpersands('unknown&', 8),
]) {
  for (const suffix of placeholderComparisonSuffixes) {
    generatedPlaceholderContracts.push([
      `amp-tail risk ${JSON.stringify(core + suffix)}`,
      `risk-v1; anchor=id:auth; uncertainty=unknown:${core}${suffix}`,
      false,
    ]);
  }
}
for (const suffix of placeholderComparisonSuffixes) {
  generatedPlaceholderContracts.push([
    `amp-tail no-finding ${JSON.stringify(suffix)}`,
    `no-finding-v1; checked=name:everything&amp;${suffix}; unchecked=name:nothing&amp;${suffix}`,
    false,
  ]);
}
const supportedEntityOracle = [
  'amp',
  'apos',
  'colon',
  'emsp',
  'ensp',
  'gt',
  'invisibletimes',
  'lt',
  'nbsp',
  'newline',
  'nobreak',
  'quot',
  'tab',
  'thinsp',
  'zerowidthspace',
  'zwj',
  'zwnj',
];
const incompleteEntityBoundaryOracle = ["'", '·', '中', 'λ', '＇'];
const incompleteEntityAmpEncoders = [
  ['literal', (prefix) => `&${prefix}`],
  ['numeric', (prefix) => `&#38;${prefix}`],
  ['named', (prefix) => `&amp;${prefix}`],
  ['nested', (prefix) => `&amp;amp;${prefix}`],
  ['NFKC', (prefix) => `＆${prefix}`],
];
const generatedEntityBoundaryContracts = [];
for (const entityName of supportedEntityOracle) {
  for (let length = 2; length <= entityName.length; length += 1) {
    const prefix = entityName.slice(0, length);
    for (const boundary of incompleteEntityBoundaryOracle) {
      for (const [encoding, encode] of incompleteEntityAmpEncoders) {
        generatedEntityBoundaryContracts.push([
          `incomplete ${entityName}/${prefix}/${encoding}/${JSON.stringify(boundary)}`,
          `risk-v1; anchor=name:Scope${encode(prefix)}${boundary}Risk; ` +
            'uncertainty=unknown:real risk',
          false,
        ]);
      }
    }
  }
}
const postNfkcUnknownEntityContracts = [
  ['final lowercase unknown entity', 'risk-v1; uncertainty=unknown:real risk; anchor=name:scope&amp;bogus;', false],
  ['final uppercase unknown entity', 'risk-v1; uncertainty=unknown:real risk; anchor=name:scope&amp;Bogus;', false],
  ['non-final lowercase unknown entity', 'risk-v1; anchor=name:scope&amp;bogus;; uncertainty=unknown:real risk', false],
  ['non-final uppercase unknown entity', 'risk-v1; anchor=name:scope&amp;Bogus;; uncertainty=unknown:real risk', false],
  ['no-finding final unknown entity', 'no-finding-v1; checked=name:库存同步; unchecked=name:scope&amp;Bogus;', false],
  ['no-finding non-final unknown entity', 'no-finding-v1; checked=name:scope&amp;bogus;; unchecked=name:库存同步', false],
  ['post-NFKC fullwidth ampersand', 'risk-v1; anchor=name:scope＆bogus;; uncertainty=unknown:real risk', false],
  ['post-NFKC Greek question mark', 'risk-v1; anchor=name:scope＆bogus\u037E; uncertainty=unknown:real risk', false],
  ['post-NFKC presentation semicolon', 'risk-v1; anchor=name:scope＆bogus\uFE14; uncertainty=unknown:real risk', false],
  ['post-NFKC small semicolon', 'risk-v1; anchor=name:scope＆bogus\uFE54; uncertainty=unknown:real risk', false],
  ['post-NFKC fullwidth semicolon', 'risk-v1; anchor=name:scope＆bogus\uFF1B; uncertainty=unknown:real risk', false],
  ['post-NFKC numeric ampersand', 'risk-v1; anchor=name:scope&#65286;bogus;; uncertainty=unknown:real risk', false],
  ['post-NFKC nested numeric ampersand', 'risk-v1; anchor=name:scope&amp;#65286;bogus;; uncertainty=unknown:real risk', false],
  [
    'post-NFKC numeric ampersand and semicolon',
    'risk-v1; anchor=name:scope&#65286;bogus&#65307;; uncertainty=unknown:real risk',
    false,
  ],
];
const ampersandProductOracle = [
  ['lowercase encoded product', 'rock&amp;roll', 'rock&roll'],
  ['mixed-case encoded product', 'Rock&amp;Roll', 'Rock&Roll'],
  ['bare initials', 'A&B', 'A&B'],
  ['encoded research name', 'R&amp;D+', 'R&D+'],
  ['spaced department name', 'Sales &amp; Marketing', 'Sales & Marketing'],
];
const delimiterDisambiguationValidContracts = [
  [
    'single grammar delimiter after lowercase bare ampersand token',
    'risk-v1; anchor=name:scope&amp;bogus; uncertainty=unknown:scope detail',
    true,
  ],
  [
    'single grammar delimiter after uppercase bare ampersand token',
    'risk-v1; anchor=name:scope&amp;Bogus; uncertainty=unknown:scope detail',
    true,
  ],
  [
    'single grammar delimiter in no-finding contract',
    'no-finding-v1; checked=name:scope&amp;bogus; unchecked=name:库存同步',
    true,
  ],
];
const structuralTabValidContracts = [
  [
    'raw tabs at segment boundaries',
    'risk-v1;\tanchor=id:auth;\tuncertainty=unknown:scope detail',
    true,
  ],
  [
    'raw tabs around keys equals and values',
    'risk-v1\t;\tanchor\t=\tid:auth\t;\tuncertainty\t=\tunknown:scope detail\t',
    true,
  ],
  [
    'raw tabs with reordered risk fields',
    'risk-v1 ;\tuncertainty\t=\tunknown:scope detail\t;\tanchor\t=\tid:auth',
    true,
  ],
  [
    'raw tabs in no-finding grammar padding',
    'no-finding-v1\t;\tchecked\t=\tname:支付回调\t;\tunchecked\t=\tpath:/api/auth\t',
    true,
  ],
];
const structuralTabInvalidContracts = [
  ['raw tab inside id anchor', 'risk-v1; anchor=id:au\tth; uncertainty=unknown:scope detail', false],
  ['raw tab inside uncertainty kind', 'risk-v1; anchor=id:auth; uncertainty=unk\tnown:scope detail', false],
  ['raw tab inside uncertainty detail', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope\tdetail', false],
  [
    'raw tab inside no-finding anchor',
    'no-finding-v1; checked=name:支付\t回调; unchecked=path:/api/auth',
    false,
  ],
  ['named entity tab as segment padding', 'risk-v1;&Tab;anchor=id:auth; uncertainty=unknown:scope detail', false],
  ['numeric entity tab as value padding', 'risk-v1; anchor=&#9;id:auth; uncertainty=unknown:scope detail', false],
  ['hex entity tab as segment padding', 'risk-v1;&#x9;anchor=id:auth; uncertainty=unknown:scope detail', false],
  [
    'nested entity tab around equals',
    'risk-v1; anchor&amp;Tab;=id:auth; uncertainty=unknown:scope detail',
    false,
  ],
  [
    'nested numeric entity tab as segment padding',
    'no-finding-v1;&amp;#9;checked=name:支付回调; unchecked=path:/api/auth',
    false,
  ],
  [
    'nested hex entity tab as segment padding',
    'no-finding-v1;&amp;#x9;checked=name:支付回调; unchecked=path:/api/auth',
    false,
  ],
  ['named entity tab', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope&Tab;detail', false],
  ['numeric entity tab', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope&#9;detail', false],
  ['nested named entity tab', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope&amp;Tab;detail', false],
  ['nested numeric entity tab', 'risk-v1; anchor=id:auth; uncertainty=unknown:scope&amp;#9;detail', false],
  [
    'deeply nested named entity tab',
    'no-finding-v1; checked=name:支付回调; unchecked=name:库存&amp;amp;Tab;同步',
    false,
  ],
];
for (const [name, value] of structuralTabInvalidContracts) {
  assert.equal(
    parseReflectionContract(value).reason,
    'control-character',
    `${name} must fail at the Tab provenance/position boundary`,
  );
}
const ampersandOrderContracts = ampersandProductOracle.flatMap(([name, wireValue]) => [
  [
    `${name}: risk anchor before uncertainty`,
    `risk-v1; anchor=name:${wireValue}; uncertainty=unknown:scope detail`,
    true,
  ],
  [
    `${name}: risk uncertainty before anchor`,
    `risk-v1; uncertainty=unknown:scope detail; anchor=name:${wireValue}`,
    true,
  ],
  [
    `${name}: no-finding checked before unchecked`,
    `no-finding-v1; checked=name:${wireValue}; unchecked=name:库存同步`,
    true,
  ],
  [
    `${name}: no-finding unchecked before checked`,
    `no-finding-v1; unchecked=name:库存同步; checked=name:${wireValue}`,
    true,
  ],
]);
assert.equal(
  parseReflectionContract(
    `risk-v1; anchor=id:auth; uncertainty=unknown:${encodeAmpersands('unknown&', 9)}`,
  ).reason,
  'unresolved-entity',
);
for (const [name, value, expectedOk] of [
  ['typed risk grammar', typedRisk, true],
  ['typed no-finding grammar', typedNoFinding, true],
  ['typed name short CJK product', 'risk-v1; anchor=name:微信; uncertainty=unverified:生产回调行为', true],
  ['typed name Redis', 'risk-v1; anchor=name:Redis; uncertainty=unverified:failover behavior', true],
  ['typed name Claude', 'risk-v1; anchor=name:Claude; uncertainty=unverified:model fallback', true],
  ['typed NFKC name Redis', 'risk-v1; anchor=name:Ｒｅｄｉｓ; uncertainty=unverified:failover behavior', true],
  ['typed numeric-entity name', 'risk-v1; anchor=name:微&#20449;; uncertainty=unverified:生产回调行为', true],
  [
    'typed NFKC mode and keys',
    'ｒｉｓｋ－ｖ１； ａｎｃｈｏｒ＝ｉｄ：ａｕｔｈ； ｕｎｃｅｒｔａｉｎｔｙ＝ｕｎｖｅｒｉｆｉｅｄ：token expiry',
    true,
  ],
  ['typed id auth', 'risk-v1; anchor=id:auth; uncertainty=unverified:token expiry behavior', true],
  ['typed path API', 'risk-v1; anchor=path:/api/auth; uncertainty=unverified:error handling', true],
  ['typed repository-relative path', 'risk-v1; anchor=path:scripts/claude-task.cjs; uncertainty=unverified:error handling', true],
  ['typed dotfile path', 'risk-v1; anchor=path:.gitignore; uncertainty=unverified:ignore coverage', true],
  ['typed root README path', 'risk-v1; anchor=path:README; uncertainty=unverified:documentation coverage', true],
  ['typed ref without space', 'risk-v1; anchor=ref:Issue#81; uncertainty=unverified:review coverage', true],
  ['typed ref with one space', 'risk-v1; anchor=ref:Issue #81; uncertainty=unverified:review coverage', true],
  ['typed fixed SHA ref', 'risk-v1; anchor=ref:2a3b50dd; uncertainty=unverified:review coverage', true],
  ['typed reordered fields', 'risk-v1; uncertainty=unverified:review coverage; anchor=ref:PR#82', true],
  ['typed distinct no-finding anchors', 'no-finding-v1; checked=name:支付回调; unchecked=path:/api/auth', true],
  ['typed concrete terminal punctuation', 'risk-v1; anchor=id:auth; uncertainty=unknown:生产调用方清单。', true],
  ['typed concrete no-finding punctuation', 'no-finding-v1; checked=name:支付回调。; unchecked=name:库存同步。', true],
  [
    'typed 400-digit tracked ref',
    `risk-v1; anchor=ref:Issue#${'9'.repeat(400)}; uncertainty=unverified:review coverage`,
    true,
  ],
  [
    'typed adjacent unsafe-integer refs stay distinct',
    'no-finding-v1; checked=ref:Issue#9007199254740992; unchecked=ref:Issue#9007199254740993',
    true,
  ],
  ['typed nested entity parity', 'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;#120;', true],
  ['typed raw wire 4096-byte boundary', encodedRawWire4096, true],
  [
    'typed uncertainty readable boundary',
    `risk-v1; anchor=id:auth; uncertainty=unknown:${'x'.repeat(2_040)}`,
    true,
  ],
  ['typed risk duplicate anchor', 'risk-v1; anchor=id:Redis; anchor=id:OAuth; uncertainty=risk:failover', false],
  ['typed risk unknown key', 'risk-v1; anchor=id:Redis; uncertainty=risk:failover; extra=id:OAuth', false],
  ['typed risk unknown anchor type', 'risk-v1; anchor=system:Redis; uncertainty=risk:failover', false],
  ['typed malformed ref', 'risk-v1; anchor=ref:Redis; uncertainty=risk:failover', false],
  ['typed malformed path', 'risk-v1; anchor=path:auth; uncertainty=risk:failover', false],
  ['typed arbitrary absolute POSIX path', 'risk-v1; anchor=path:/etc/passwd; uncertainty=risk:exposure', false],
  ['typed user-home absolute path', 'risk-v1; anchor=path:/Users/max/repo; uncertainty=risk:exposure', false],
  ['typed Windows drive path', 'risk-v1; anchor=path:C:\\repo\\file.cjs; uncertainty=risk:exposure', false],
  ['typed parent traversal', 'risk-v1; anchor=path:../scripts/a.cjs; uncertainty=risk:exposure', false],
  ['typed malformed id', 'risk-v1; anchor=id:two words; uncertainty=risk:failure', false],
  ['typed one-grapheme name', 'risk-v1; anchor=name:x; uncertainty=risk:failure', false],
  ['typed quantifier name', 'risk-v1; anchor=name:everything; uncertainty=risk:failure', false],
  ['typed punctuated quantifier name', 'risk-v1; anchor=name:everything...; uncertainty=risk:failure', false],
  ['typed uncertainty without a closed kind', 'risk-v1; anchor=id:Redis; uncertainty=verified', false],
  ['typed uncertainty unknown kind with detail', 'risk-v1; anchor=id:Redis; uncertainty=verified:passed', false],
  ['typed uncertainty empty Chinese claim', 'risk-v1; anchor=name:系统; uncertainty=无', false],
  ['typed uncertainty unknown Chinese claim', 'risk-v1; anchor=name:系统; uncertainty=不知道', false],
  ['typed uncertainty punctuated placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无。', false],
  ['typed uncertainty mixed terminal punctuation', 'risk-v1; anchor=id:auth; uncertainty=unknown:无。 ！？…', false],
  ['typed uncertainty lowercase unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown.', false],
  ['typed uncertainty uppercase unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:UNKNOWN...', false],
  ['typed uncertainty NFKC unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:ｕｎｋｎｏｗｎ', false],
  ['typed uncertainty numeric-entity unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unkn&#111;wn!', false],
  ['typed uncertainty nested-entity unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unkn&amp;#111;wn!', false],
  ['typed uncertainty traditional Chinese placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:無。', false],
  ['typed uncertainty underscore-padded placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无_', false],
  ['typed uncertainty hyphen-padded placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无-', false],
  ['typed uncertainty plus-padded placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无+', false],
  ['typed uncertainty slash-padded placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown/', false],
  ['typed uncertainty hyphen-padded unknown placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown-', false],
  ['typed uncertainty underscore-padded n/a', 'risk-v1; anchor=id:auth; uncertainty=unknown:n/a_', false],
  ['typed C++ detail stays substantive', 'risk-v1; anchor=id:auth; uncertainty=unknown:C++', true],
  ['typed snake_case detail stays substantive', 'risk-v1; anchor=id:auth; uncertainty=unknown:snake_case', true],
  ['typed encoded R&D+ stays substantive', 'risk-v1; anchor=name:R&amp;D+; uncertainty=unknown:R&amp;D+', true],
  ['typed encoded A&B stays substantive', 'risk-v1; anchor=name:A&amp;B; uncertainty=unknown:A&amp;B', true],
  ['typed encoded HTML comment detail', 'risk-v1; anchor=id:Redis; uncertainty=unknown:&lt;!--xx--&gt;', false],
  ['typed Markdown link detail', 'risk-v1; anchor=id:Redis; uncertainty=unknown:[](xx)', false],
  ['typed underscore-wrapped detail', 'risk-v1; anchor=id:Redis; uncertainty=unknown:__xx__', false],
  ['typed encoded hidden HTML detail', 'risk-v1; anchor=id:Redis; uncertainty=unknown:&lt;span hidden&gt;xx&lt;/span&gt;', false],
  ['typed unresolved entity', 'risk-v1; anchor=id:Red&amp;bogus;is; uncertainty=risk:failure', false],
  ['typed default-ignorable confusion', 'risk-v1; anchor=id:Re\u200Ddis; uncertainty=risk:failure', false],
  ['typed control character', 'risk-v1; anchor=id:Redis; uncertainty=risk:may\u0000 fail', false],
  ['typed semicolon injection', 'risk-v1; anchor=id:Redis; uncertainty=risk:failover; checked=id:auth', false],
  ['typed encoded semicolon injection', 'risk-v1; anchor=id:Redis; uncertainty=risk:fail&#59; extra=id:auth', false],
  ['typed mixed-mode keys', 'risk-v1; checked=id:auth; unchecked=id:timeout', false],
  ['typed duplicate checked key', 'no-finding-v1; checked=id:auth; checked=id:cache; unchecked=id:timeout', false],
  ['typed invalid checked anchor', 'no-finding-v1; checked=path:auth; unchecked=id:timeout', false],
  ['typed invalid unchecked anchor', 'no-finding-v1; checked=id:auth; unchecked=ref:Redis', false],
  ['typed identical no-finding boundaries', 'no-finding-v1; checked=id:auth; unchecked=id:auth', false],
  ['typed case-equivalent ref boundaries', 'no-finding-v1; checked=ref:PR#82; unchecked=ref:pr #82', false],
  ['typed cross-type identical boundaries', 'no-finding-v1; checked=id:auth; unchecked=name:auth', false],
  ['typed repeated-space equivalent boundaries', 'no-finding-v1; checked=name:Auth Service; unchecked=name:auth  service', false],
  ['typed fixed-SHA cross-type boundaries', 'no-finding-v1; checked=ref:2a3b50dd; unchecked=name:2A3B50DD', false],
  ['typed encoded hidden anchor markup', 'no-finding-v1; checked=name:&lt;span hidden&gt;auth&lt;/span&gt;; unchecked=id:cache', false],
  ['typed underscore-wrapped id', 'no-finding-v1; checked=id:__auth__; unchecked=id:cache', false],
  ['typed no-finding placeholder names', 'no-finding-v1; checked=name:everything; unchecked=name:nothing', false],
  ['typed no-finding punctuated placeholder names', 'no-finding-v1; checked=name:everything.; unchecked=name:nothing.', false],
  ['typed no-finding mixed terminal punctuation', 'no-finding-v1; checked=name:everything. ，。; unchecked=name:nothing, ...', false],
  ['typed no-finding padded placeholders', 'no-finding-v1; checked=name:everything_; unchecked=name:nothing+', false],
  ['typed no-finding repository paths stay substantive', 'no-finding-v1; checked=path:scripts/foo-bar.cjs; unchecked=path:docs/bar_baz.md', true],
  ['typed non-ASCII id confusable', 'no-finding-v1; checked=id:ΡR82; unchecked=id:auth', false],
  ['typed leading-zero ref', 'risk-v1; anchor=ref:Issue#081; uncertainty=unverified:review coverage', false],
  ['typed unresolved nested entity parity', 'risk-v1; anchor=id:auth; uncertainty=unknown:&amp;bogus;', false],
  ['typed raw wire 6045 encoded bytes', encodedRawWire6KiB, false],
  ['typed raw wire 4097-byte boundary', encodedRawWire4097, false],
  ['typed no-finding unknown key', 'no-finding-v1; checked=id:auth; unchecked=id:timeout; uncertainty=none', false],
  [
    'typed uncertainty above readable boundary',
    `risk-v1; anchor=id:auth; uncertainty=unknown:${'x'.repeat(2_041)}`,
    false,
  ],
  [
    'typed anchor above readable boundary',
    `risk-v1; anchor=id:${`a${'x'.repeat(512)}`}; uncertainty=unknown:scope`,
    false,
  ],
  [
    'typed oversized whole contract',
    `risk-v1${' '.repeat(4_097)}; anchor=id:auth; uncertainty=unknown:scope`,
    false,
  ],
  ['typed unknown version', 'risk-v2; anchor=id:Redis; uncertainty=risk:failover', false],
  ['legacy specific free-form', 'Redis may fail', false],
  ['legacy vague free-form', '可能存在某种隐患', false],
  [
    'legacy bounded no-finding free-form',
    '未发现问题；已检查范围：主要流程；未检查范围：次要流程',
    false,
  ],
  ...generatedEntityBoundaryContracts,
  ...postNfkcUnknownEntityContracts,
  ...ampersandOrderContracts,
  ...delimiterDisambiguationValidContracts,
  ...structuralTabValidContracts,
  ...structuralTabInvalidContracts,
  ...generatedPlaceholderContracts,
]) {
  const direct = parseReflectionContract(value);
  if (direct.ok !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: direct parser expected ok=${expectedOk}, actual=${direct.ok} (${direct.reason || 'ok'})`,
    );
  }
  for (const field of ['least-confidence', 'biggest-missing']) {
    const leastConfidence = field === 'least-confidence' ? value : typedRisk;
    const biggestMissing = field === 'biggest-missing' ? value : typedRisk;
    const handoffOk = handoffFieldErrors(
      reflectionHandoff(leastConfidence, biggestMissing),
    ).length === 0;
    const prResult = validatePrBody(
      reflectionPrBody(leastConfidence, biggestMissing),
    );
    if (handoffOk !== expectedOk) {
      reflectionRegressionFailures.push(
        `${name} in ${field}: Issue handoff expected ok=${expectedOk}, actual=${handoffOk}`,
      );
    }
    if (prResult.ok !== expectedOk) {
      reflectionRegressionFailures.push(
        `${name} in ${field}: PR validator expected ok=${expectedOk}, actual=${prResult.ok} ` +
        `(${prResult.errors.join('; ')})`,
      );
    }
    if (handoffOk !== prResult.ok) {
      reflectionRegressionFailures.push(`${name} in ${field}: validators disagree`);
    }
  }
}

const malformedPrError = '字段键无法安全解析；请使用可见的标准字段名与分隔符。';
for (const entity of ['copy', 'bogus']) {
  const maliciousHandoff =
    `least-confid&amp;${entity};ence: TODO later fill this`;
  const maliciousHandoffWithoutDelimiter =
    `least-confidence&amp;${entity}; TODO later fill this`;
  const maliciousPr =
    `- **我现在最没把握的是什么？ / Least confid&amp;${entity};ence**: TODO later fill this`;
  const maliciousPrWithoutDelimiter =
    `- **我现在最没把握的是什么？ / Least confidence**&amp;${entity}; TODO later fill this`;
  for (const [order, handoffBody, prBody] of [
    [
      'canonical first',
      `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
${maliciousHandoff}`,
      reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
        .replace(prStrongLeastConfidenceLine, `${prStrongLeastConfidenceLine}\n${maliciousPr}`),
    ],
    [
      'malformed first',
      `${completeHandoff}
${maliciousHandoff}
${handoffStrongLeastConfidenceLine}
biggest-missing: ${strongBiggestMissing}`,
      reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
        .replace(prStrongLeastConfidenceLine, `${maliciousPr}\n${prStrongLeastConfidenceLine}`),
    ],
    [
      'no delimiter',
      `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
${maliciousHandoffWithoutDelimiter}`,
      reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
        .replace(
          prStrongLeastConfidenceLine,
          `${prStrongLeastConfidenceLine}\n${maliciousPrWithoutDelimiter}`,
        ),
    ],
  ]) {
    const handoffErrors = handoffFieldErrors(handoffBody);
    const prResult = validatePrBody(prBody);
    if (handoffErrors.length !== 1 || handoffErrors[0] !== 'field-key') {
      reflectionRegressionFailures.push(
        `unknown ${entity} ${order}: expected exact handoff field-key, got ${handoffErrors.join(',')}`,
      );
    }
    if (prResult.ok || !prResult.errors.includes(malformedPrError)) {
      reflectionRegressionFailures.push(
        `unknown ${entity} ${order}: expected exact PR malformed error, got ${prResult.errors.join('; ')}`,
      );
    }
  }
  const handoffReplacementErrors = handoffFieldErrors(
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace(handoffStrongLeastConfidenceLine, maliciousHandoff),
  );
  if (
    handoffReplacementErrors.length !== 2 ||
    handoffReplacementErrors[0] !== 'field-key' ||
    handoffReplacementErrors[1] !== 'least-confidence'
  ) {
    reflectionRegressionFailures.push(
      `unknown ${entity} required replacement: expected field-key,least-confidence; got ${handoffReplacementErrors.join(',')}`,
    );
  }
}

for (const [name, body] of [
  [
    'canonical strong field before encoded weak duplicate',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confid&amp;#101;nce: TODO later fill this`,
  ],
  [
    'encoded weak field before canonical strong duplicate',
    `${completeHandoff}
least-confid&amp;#101;nce: TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'default-ignorable weak field before canonical strong duplicate',
    `${completeHandoff}
least-confid\uFE0Fence: TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'unresolved named weak field after canonical strong duplicate',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confid&amp;NoBreak;ence: TODO later fill this`,
  ],
  [
    'unresolved named weak field before canonical strong duplicate',
    `${completeHandoff}
least-confid&amp;NoBreak;ence: TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'nested unresolved named weak field after canonical strong duplicate',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confid&amp;amp;NoBreak;ence: TODO later fill this`,
  ],
  [
    'nested unresolved named weak field before canonical strong duplicate',
    `${completeHandoff}
least-confid&amp;amp;NoBreak;ence: TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'numeric encoded delimiter after canonical strong field',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confidence&amp;#58; TODO later fill this`,
  ],
  [
    'numeric encoded delimiter before canonical strong field',
    `${completeHandoff}
least-confidence&amp;#58; TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
  [
    'named encoded delimiter after canonical strong field',
    `${reflectionHandoff(
      'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )}
least-confidence&amp;colon; TODO later fill this`,
  ],
  [
    'named encoded delimiter before canonical strong field',
    `${completeHandoff}
least-confidence&amp;colon; TODO later fill this
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`,
  ],
]) {
  if (handoffFieldErrors(body).length === 0) {
    reflectionRegressionFailures.push(`${name}: Issue handoff duplicate was accepted`);
  }
}

if (!handoffFieldErrors(completeHandoff.replace('result:', 'res_ult:')).includes('result')) {
  reflectionRegressionFailures.push('internal underscore in res_ult was accepted as result');
}
if (!handoffFieldErrors(`${reflectionHandoff(
  'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
)}
res_ult: unrelated informational field`).includes('biggest-missing')) {
  reflectionRegressionFailures.push(
    'non-custom internal underscore line escaped the active reflection',
  );
}
if (handoffFieldErrors(`${reflectionHandoff(
  'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
)}
custom_res_ult: unrelated informational field`).length !== 0) {
  reflectionRegressionFailures.push('custom namespace with internal underscore collided with result');
}
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff(
    'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  ).replace('least-confidence:', 'ｌｅａｓｔ－ｃｏｎｆｉｄｅｎｃｅ:')),
  [],
  'NFKC-equivalent required handoff key must be recognized',
);
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff(
    'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  ).replace('least-confidence:', 'least-confidence\t:')),
  [],
  'ordinary tab remains allowed inside a handoff field key',
);
const unsafeFieldKeyPrError =
  '字段键包含不可见字符或非标准空白；请只使用普通空格/Tab 与可见字段名。';
for (const [name, handoffKey, prKey] of [
  ['literal NBSP single key', 'least\u00A0confidence', 'Least\u00A0confidence'],
  ['nested named NBSP single key', 'least&amp;nbsp;confidence', 'Least&amp;nbsp;confidence'],
  ['nested numeric NBSP single key', 'least&amp;#160;confidence', 'Least&amp;#160;confidence'],
  ['literal combining grapheme joiner single key', 'lea\u034Fst-confidence', 'Lea\u034Fst confidence'],
  [
    'nested numeric combining grapheme joiner single key',
    'lea&amp;#847;st-confidence',
    'Lea&amp;#847;st confidence',
  ],
  [
    'literal line separator single key',
    'least\u2028-confidence',
    'Least\u2028confidence',
  ],
  [
    'literal paragraph separator single key',
    'least\u2029-confidence',
    'Least\u2029confidence',
  ],
  [
    'numeric line separator entity single key',
    'least&#8232;-confidence',
    'Least&#8232;confidence',
  ],
  [
    'nested numeric paragraph separator entity single key',
    'least&amp;#8233;-confidence',
    'Least&amp;#8233;confidence',
  ],
  ['literal variation selector single key', 'least-confid\uFE0Fence', 'Least confid\uFE0Fence'],
  [
    'nested numeric variation selector single key',
    'least-confid&amp;#65039;ence',
    'Least confid&amp;#65039;ence',
  ],
]) {
  const handoffErrors = handoffFieldErrors(
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing)
      .replace('least-confidence:', `${handoffKey}:`),
  );
  const prResult = validatePrBody(
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing)
      .replace('Least confidence**:', `${prKey}**:`),
  );
  if (
    handoffErrors.length !== 2 ||
    handoffErrors[0] !== 'field-key-invisible' ||
    handoffErrors[1] !== 'least-confidence'
  ) {
    reflectionRegressionFailures.push(
      `${name}: expected exact handoff field-key-invisible,least-confidence; got ${handoffErrors.join(',')}`,
    );
  }
  if (prResult.ok || !prResult.errors.includes(unsafeFieldKeyPrError)) {
    reflectionRegressionFailures.push(
      `${name}: expected exact PR unsafe key error; got ${prResult.errors.join('; ')}`,
    );
  }
}
for (const [name, body] of [
  [
    'unsafe handoff duplicate with canonical key first',
    `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
least-confid\uFE0Fence: TODO later fill this`,
  ],
  [
    'unsafe handoff duplicate with unsafe key first',
    `${completeHandoff}
least-confid\uFE0Fence: TODO later fill this
least-confidence: ${strongLeastConfidence}
biggest-missing: ${strongBiggestMissing}`,
  ],
]) {
  const errors = handoffFieldErrors(body);
  if (errors.length !== 1 || errors[0] !== 'field-key-invisible') {
    reflectionRegressionFailures.push(
      `${name}: expected exact field-key-invisible; got ${errors.join(',')}`,
    );
  }
}
for (const [name, first, second] of [
  [
    'NFKC-equivalent handoff duplicate, canonical first',
    'least-confidence',
    'ｌｅａｓｔ－ｃｏｎｆｉｄｅｎｃｅ',
  ],
  [
    'NFKC-equivalent handoff duplicate, fullwidth first',
    'ｌｅａｓｔ－ｃｏｎｆｉｄｅｎｃｅ',
    'least-confidence',
  ],
]) {
  const body = `${completeHandoff}
${first}: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
${second}: TODO later fill this
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`;
  if (!handoffFieldErrors(body).includes('least-confidence')) {
    reflectionRegressionFailures.push(`${name} was accepted`);
  }
}

for (const [name, handoffBody, prBody] of [
  [
    'lone CR duplicate with strong field first',
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing).replace(
      handoffStrongLeastConfidenceLine,
      `${handoffStrongLeastConfidenceLine}\rleast-confidence: 暂无问题`,
    ),
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing).replace(
      prStrongLeastConfidenceLine,
      `${prStrongLeastConfidenceLine}\r- **我现在最没把握的是什么？ / Least confidence**: 暂无问题`,
    ),
  ],
  [
    'lone CR duplicate with weak field first',
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing).replace(
      handoffStrongLeastConfidenceLine,
      `least-confidence: 暂无问题\r${handoffStrongLeastConfidenceLine}`,
    ),
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing).replace(
      prStrongLeastConfidenceLine,
      `- **我现在最没把握的是什么？ / Least confidence**: 暂无问题\r${prStrongLeastConfidenceLine}`,
    ),
  ],
]) {
  const handoffErrors = handoffFieldErrors(handoffBody);
  const prResult = validatePrBody(prBody);
  if (!handoffErrors.includes('least-confidence')) {
    reflectionRegressionFailures.push(`${name}: handoff duplicate was accepted`);
  }
  if (prResult.ok || !prResult.errors.some((error) => /必填字段重复/.test(error))) {
    reflectionRegressionFailures.push(`${name}: PR duplicate was accepted`);
  }
}

for (const [name, endings] of [
  ['all lone CR', ['\r']],
  ['all CRLF', ['\r\n']],
  ['mixed CRLF LF and CR', ['\r\n', '\n', '\r']],
]) {
  const handoffErrors = handoffFieldErrors(convertLineEndings(
    reflectionHandoff(strongLeastConfidence, strongBiggestMissing),
    endings,
  ));
  const prResult = validatePrBody(convertLineEndings(
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing),
    endings,
  ));
  if (handoffErrors.length !== 0 || !prResult.ok) {
    reflectionRegressionFailures.push(
      `${name}: normalized documents disagreed or failed (handoff=${handoffErrors.join(',')}, pr=${prResult.errors.join('; ')})`,
    );
  }
}

for (const [name, replacement, expectedOk] of [
  ['NBSP Markdown separators', '\u00A0', false],
  ['form-feed Markdown separators', '\f', false],
  ['tab Markdown separators', '\t', true],
]) {
  const result = validatePrBody(replaceMarkdownSyntaxSeparator(
    reflectionPrBody(strongLeastConfidence, strongBiggestMissing),
    replacement,
  ));
  if (result.ok !== expectedOk) {
    reflectionRegressionFailures.push(
      `${name}: PR expected ok=${expectedOk}, actual=${result.ok} (${result.errors.join('; ')})`,
    );
  }
}

for (const [name, handoffKey, prKey] of [
  ['NUL inside field key', 'lea\u0000st-confidence', 'Lea\u0000st confidence'],
  [
    'NUL before encoded delimiter',
    'least-confidence\u0000&amp;#58; TODO later fill this',
    'Least confidence**\u0000&amp;#58; TODO later fill this',
  ],
]) {
  let handoffBody;
  let prBody;
  if (name === 'NUL inside field key') {
    handoffBody = `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
${handoffKey}: TODO later fill this`;
    prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing).replace(
      prStrongLeastConfidenceLine,
      `${prStrongLeastConfidenceLine}
- **我现在最没把握的是什么？ / ${prKey}**: TODO later fill this`,
    );
  } else {
    handoffBody = `${reflectionHandoff(strongLeastConfidence, strongBiggestMissing)}
${handoffKey}`;
    prBody = reflectionPrBody(strongLeastConfidence, strongBiggestMissing).replace(
      prStrongLeastConfidenceLine,
      `${prStrongLeastConfidenceLine}
- **我现在最没把握的是什么？ / ${prKey}`,
    );
  }
  const handoffErrors = handoffFieldErrors(handoffBody);
  const prResult = validatePrBody(prBody);
  if (!handoffErrors.includes('field-key')) {
    reflectionRegressionFailures.push(`${name}: handoff did not fail with field-key`);
  }
  if (!prResult.errors.includes(malformedPrError)) {
    reflectionRegressionFailures.push(`${name}: PR did not fail with exact malformed error`);
  }
}

const longConcreteRisk = `外部调用未查${'；外部调用未查'.repeat(8_192)}`;
const lengthBoundaryStartedAt = Date.now();
const longHandoffErrors = handoffFieldErrors(reflectionHandoff(
  longConcreteRisk,
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
));
const longPrResult = validatePrBody(reflectionPrBody(
  longConcreteRisk,
  'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
));
if (!longHandoffErrors.includes('least-confidence') || longPrResult.ok) {
  reflectionRegressionFailures.push('64KiB reflection boundary was not rejected');
}
if (Date.now() - lengthBoundaryStartedAt > 2_000) {
  reflectionRegressionFailures.push('64KiB reflection boundary exceeded 2s');
}

assert.deepEqual(handoffFieldErrors(completeHandoff), [
  'least-confidence', 'biggest-missing',
]);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`), []);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: none
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`), ['least-confidence']);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: 没有发现
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`), ['least-confidence']);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: 未发现`), ['biggest-missing']);
assert.deepEqual(handoffFieldErrors(`${completeHandoff}
least-confidence: 未发现；已检查固定对象和测试，尚未检查生产环境
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`), ['least-confidence']);
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff('测试覆盖不足', '外部调用未查')),
  ['least-confidence', 'biggest-missing'],
  'legacy free-form risks must be rejected without typed anchors',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}
<!--
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
-->
least-confidence: TODO later fill this
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`),
  ['least-confidence'],
  'HTML-comment fields must not mask a visible placeholder',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}
<!--
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability
-->`),
  ['least-confidence', 'biggest-missing'],
  'HTML-comment-only reflection fields must remain missing',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}
\`\`\`text
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
\`\`\`
least-confidence: TODO later fill this
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`),
  ['least-confidence'],
  'fenced-code fields must not mask a visible placeholder',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}
\`\`\`text
least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability
\`\`\``),
  ['least-confidence', 'biggest-missing'],
  'fenced-code-only reflection fields must remain missing',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}

    least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
least-confidence: TODO later fill this
biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`),
  ['least-confidence'],
  'indented-code fields must not count as visible fields',
);
assert.deepEqual(
  handoffFieldErrors(`${completeHandoff}

    least-confidence: risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes
    biggest-missing: risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability`),
  ['least-confidence', 'biggest-missing'],
  'indented-code-only reflection fields must remain missing',
);
assert.deepEqual(
  handoffFieldErrors(`${reflectionHandoff(
    'risk-v1; anchor=name:transaction isolation; uncertainty=untested:additional runtimes',
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  )}
least-confidence: TODO later fill this`),
  ['least-confidence'],
  'duplicate reflection fields must fail closed even when the first value is strong',
);
for (const placeholder of [
  'TODO later fill this',
  'T&#79;DO later fill this',
  'T\u200BO\u200BD\u200BO later fill this',
  '待填写：稍后补充具体风险与证据',
]) {
  assert.deepEqual(
    handoffFieldErrors(reflectionHandoff(
      placeholder,
      'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
    )),
    ['least-confidence'],
    `explicit placeholder must fail after normalization: ${placeholder}`,
  );
}
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff(
    '未发现；暂无其他问题',
    'risk-v1; anchor=name:upstream schema owner; uncertainty=dependency:contract stability',
  )),
  ['least-confidence'],
  '未发现 must include both checked and unchecked boundaries',
);
assert.deepEqual(
  handoffFieldErrors(reflectionHandoff(
    '未发现；已检查固定对象和测试，尚未检查生产环境',
    '未发现；已核对仓库调用链，未核对仓库外集成',
  )),
  ['least-confidence', 'biggest-missing'],
  'legacy bounded no-finding prose must be rejected',
);
assert.deepEqual(handoffFieldErrors('[HANDOFF] status=blocked'), [
  'result', 'evidence', 'risk', 'next-owner', 'trigger',
  'least-confidence', 'biggest-missing',
]);

assert.equal(isSafeBeforeStartShell('git status --short'), true);
assert.equal(isSafeBeforeStartShell('gh issue view 12 --json body'), true);
assert.equal(isSafeBeforeStartShell(
  'node scripts/claude-task.cjs create-issues --manifest=/tmp/candidates.json --approval=https://github.com/acme/coreone/issues/1#issuecomment-2',
  repositoryRoot,
), true);
assert.equal(isSafeBeforeStartShell('gh issue create --title x --body y'), false);
assert.equal(isSafeBeforeStartShell('git status; Set-Content hacked.txt x'), false);
assert.equal(isSafeBeforeStartShell('git status $(touch hacked.txt)'), false);
assert.equal(isSafeBeforeStartShell('git status `touch hacked.txt`'), false);
assert.equal(isSafeBeforeStartShell('git diff --output=hacked.txt'), false);
assert.equal(isSafeBeforeStartShell('git -c diff.external=evil diff --ext-diff'), false);
const bootstrapWorktree = path.resolve(repositoryRoot, '..', 'claude-bootstrap-worktree');
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add -b claude/fix-bootstrap "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  true,
  'Claude must be able to create the task worktree required before task start',
);
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add --detach "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  false,
);
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add -B claude/fix-bootstrap "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  false,
);
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add -b master "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  false,
);
assert.equal(
  isSafeBeforeStartShell(
    `git worktree add -b claude/fix-bootstrap "${bootstrapWorktree}" HEAD`,
    repositoryRoot,
  ),
  false,
);
assert.equal(isSafeBeforeStartShell('git worktree remove some-worktree', repositoryRoot), false);
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
const gitPushWriteState = { mode: 'governed', branch: 'task' };
assert.doesNotThrow(() =>
  assertSafeGitCommand(shellTokens('git push -u origin task'), gitPushWriteState),
);
assert.equal(gitPushWriteState.githubWrite, true);
assert.throws(() =>
  assertSafeGitCommand(
    shellTokens(`git worktree add -b claude/nested-task "${bootstrapWorktree}" origin/master`),
    { mode: 'governed', branch: 'task' },
  ),
);
assert.doesNotThrow(() => assertSafeGhCommand(shellTokens('gh issue view 12'), { mode: 'governed', issue: 12 }));
const issueCommentWriteState = { mode: 'governed', issue: 12 };
assert.doesNotThrow(() =>
  assertSafeGhCommand(shellTokens('gh issue comment 12 --body ok'), issueCommentWriteState),
);
assert.equal(issueCommentWriteState.githubWrite, true);
const prCreateWriteState = { mode: 'governed', issue: 12, branch: 'claude/frontend-task' };
assert.doesNotThrow(() =>
  assertSafeGhCommand(
    shellTokens('gh pr create --head claude/frontend-task --base master --title x --body y'),
    prCreateWriteState,
  ),
);
assert.equal(prCreateWriteState.githubWrite, true);
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

// guard 豁免 Claude harness 跨会话记忆目录（~/.claude/projects/<slug>/memory/，仓库外）；
// 其他仓库外路径与仓库内路径不在豁免范围（PM 2026-07-21 拍板）。
const harnessProjectsRoot = path.join(os.homedir(), '.claude', 'projects');
assert.equal(
  isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug', 'memory', 'MEMORY.md')),
  true,
);
assert.equal(
  isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug', 'memory', 'topic', 'note.md')),
  true,
);
assert.equal(
  isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug', 'memoryx', 'note.md')),
  false,
);
assert.equal(
  isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug', 'other', 'note.md')),
  false,
);
assert.equal(isHarnessMemoryPath(path.join(harnessProjectsRoot, 'proj-slug')), false);
assert.equal(isHarnessMemoryPath(path.join(repositoryRoot, 'docs', 'memory', 'x.md')), false);
assert.equal(isHarnessMemoryPath(path.join(os.homedir(), 'secret.txt')), false);
assert.equal(isHarnessMemoryPath('/x/.claude/projects/a/memory/b.md', '/x/.claude/projects'), true);
assert.equal(isHarnessMemoryPath('/x/.claude/projects/a/elsewhere/b.md', '/x/.claude/projects'), false);

const manifestProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-manifest-project-'));
const manifestProjectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-manifest-projects-'));
const manifestProjectSlug = path.resolve(manifestProjectRoot).replace(/[^a-zA-Z0-9]/g, '-');
const manifestCurrentMemory = path.join(manifestProjectsRoot, manifestProjectSlug, 'memory');
const manifestOtherMemory = path.join(
  manifestProjectsRoot,
  `${manifestProjectSlug}-other`,
  'memory',
);
const manifestEscapedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-manifest-escaped-'));
try {
  fs.mkdirSync(manifestCurrentMemory, { recursive: true });
  fs.mkdirSync(manifestOtherMemory, { recursive: true });
  const currentManifest = path.join(manifestCurrentMemory, 'candidates.json');
  const otherManifest = path.join(manifestOtherMemory, 'candidates.json');
  const escapedManifest = path.join(manifestEscapedRoot, 'candidates.json');
  fs.writeFileSync(currentManifest, '{"version":1,"issues":[]}\n', 'utf8');
  fs.writeFileSync(otherManifest, '{"version":1,"issues":[]}\n', 'utf8');
  fs.writeFileSync(escapedManifest, '{"version":1,"issues":[]}\n', 'utf8');
  assert.equal(
    resolveIssueCreationManifestPath(
      currentManifest,
      manifestProjectRoot,
      manifestProjectsRoot,
    ),
    fs.realpathSync.native(currentManifest),
  );
  assert.throws(
    () => resolveIssueCreationManifestPath(
      otherManifest,
      manifestProjectRoot,
      manifestProjectsRoot,
    ),
    /当前 Claude project/,
  );
  const escapedLink = path.join(manifestCurrentMemory, 'escaped.json');
  fs.symlinkSync(escapedManifest, escapedLink);
  assert.throws(
    () => resolveIssueCreationManifestPath(
      escapedLink,
      manifestProjectRoot,
      manifestProjectsRoot,
    ),
    /符号链接逃逸|当前 Claude project/,
  );
  const linkedProjectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'coreone-manifest-linked-project-'),
  );
  const linkedProjectSlug = path.resolve(linkedProjectRoot)
    .replace(/[^a-zA-Z0-9]/g, '-');
  const linkedProjectDirectory = path.join(manifestProjectsRoot, linkedProjectSlug);
  fs.mkdirSync(linkedProjectDirectory, { recursive: true });
  fs.symlinkSync(manifestEscapedRoot, path.join(linkedProjectDirectory, 'memory'));
  assert.throws(
    () => resolveIssueCreationManifestPath(
      escapedManifest,
      linkedProjectRoot,
      manifestProjectsRoot,
    ),
    /符号链接逃逸|当前 Claude project/,
    'the current project memory directory itself must not be a symlink escape',
  );
  fs.rmSync(linkedProjectRoot, { recursive: true, force: true });
} finally {
  fs.rmSync(manifestProjectRoot, { recursive: true, force: true });
  fs.rmSync(manifestProjectsRoot, { recursive: true, force: true });
  fs.rmSync(manifestEscapedRoot, { recursive: true, force: true });
}

// guard 子进程端到端：记忆目录路径 exit 0（无需任务合同），其他仓库外路径与未拥有仓内路径 exit 2。
function runGuard(filePath, cwd) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'claude-task.cjs'), 'guard'], {
    input: JSON.stringify({ tool_input: { file_path: filePath }, cwd }),
    encoding: 'utf8',
  });
  return result.status ?? 2;
}
assert.equal(runGuard(path.join(harnessProjectsRoot, 'proj-slug', 'memory', 'note.md'), repositoryRoot), 0);
assert.equal(runGuard(path.join(os.homedir(), 'secret.txt'), repositoryRoot), 2);
assert.equal(runGuard(path.join(repositoryRoot, 'README.md'), repositoryRoot), 2);

// shell-guard 子进程端到端：无 task state 时可以建立合规任务 worktree，危险变体继续拒绝。
function runShellGuard(command, cwd) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'claude-task.cjs'), 'shell-guard'], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
  });
  return result.status ?? 2;
}
assert.equal(
  runShellGuard(
    `git worktree add -b claude/fix-bootstrap "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  0,
);
assert.equal(
  runShellGuard(
    `git worktree add --detach "${bootstrapWorktree}" origin/master`,
    repositoryRoot,
  ),
  2,
);

function runIsolatedSerializedGitHubWrite() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-serialized-writer-'));
  const repo = path.join(sandbox, 'repo');
  const remote = path.join(sandbox, 'origin.git');
  const governanceLog = path.join(sandbox, 'governance.jsonl');
  const taskScript = path.join(__dirname, 'claude-task.cjs');
  const runGit = (args, cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
    return String(result.stdout || '').trim();
  };
  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(governanceLog, '', 'utf8');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf8');
    fs.writeFileSync(
      path.join(repo, 'scripts', 'offline-github-governance.cjs'),
      `const fs=require('node:fs');const p=${JSON.stringify(governanceLog)};` +
      `const wait=(ms)=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);` +
      `fs.appendFileSync(p,JSON.stringify({event:'start',pid:process.pid,at:Date.now()})+'\\n');` +
      `wait(500);` +
      `fs.appendFileSync(p,JSON.stringify({event:'end',pid:process.pid,at:Date.now()})+'\\n');` +
      `console.log('offline GitHub governance: PASS');\n`,
      'utf8',
    );
    runGit(['init', '--initial-branch=writer-test']);
    runGit(['config', 'user.name', 'Serialized Writer Test']);
    runGit(['config', 'user.email', 'writer@example.invalid']);
    runGit(['add', '.']);
    runGit(['commit', '-m', 'test: seed serialized writer fixture']);
    const initRemote = spawnSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    assert.equal(initRemote.status, 0, initRemote.stderr);
    runGit(['remote', 'add', 'origin', remote]);
    const head = runGit(['rev-parse', 'HEAD']);
    const stateDirectory = path.join(repo, '.git', 'coreone');
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(stateDirectory, 'claude-task-state.json'),
      `${JSON.stringify({
        version: 2,
        mode: 'r0',
        reason: 'serialized writer selftest',
        branch: 'writer-test',
        baseSha: head,
        startedHead: head,
        startedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        owned: ['seed.txt', 'scripts/offline-github-governance.cjs'],
        excluded: [],
      }, null, 2)}\n`,
      'utf8',
    );
    const command = 'git push --dry-run origin writer-test';
    const direct = spawnSync(process.execPath, [taskScript, 'shell-guard'], {
      cwd: repo,
      input: JSON.stringify({ tool_input: { command }, cwd: repo }),
      encoding: 'utf8',
    });
    const wrapped = spawnSync(
      process.execPath,
      [
        taskScript,
        'github-write',
        '--',
        'git',
        'push',
        '--dry-run',
        'origin',
        'writer-test',
      ],
      { cwd: repo, encoding: 'utf8' },
    );
    fs.writeFileSync(governanceLog, '', 'utf8');
    const launcherPath = path.join(sandbox, 'serialized-writer-launcher.cjs');
    const concurrentResultPath = path.join(sandbox, 'serialized-writer-results.json');
    fs.writeFileSync(launcherPath, `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [node, taskScript, cwd, resultPath] = process.argv.slice(2);
const args = [
  taskScript,
  'github-write',
  '--',
  'git',
  'push',
  '--dry-run',
  'origin',
  'writer-test',
];
const run = () => new Promise((resolve) => {
  const child = spawn(node, args, { cwd, stdio: 'ignore' });
  child.on('close', (code) => resolve(code));
});
Promise.all([run(), run()]).then((codes) => {
  fs.writeFileSync(resultPath, JSON.stringify(codes));
});
`, 'utf8');
    const concurrent = spawnSync(
      process.execPath,
      [
        launcherPath,
        process.execPath,
        taskScript,
        repo,
        concurrentResultPath,
      ],
      { cwd: repo, encoding: 'utf8', timeout: 15_000 },
    );
    assert.equal(concurrent.status, 0, concurrent.stderr || concurrent.stdout);
    return {
      direct,
      wrapped,
      concurrentCodes: JSON.parse(fs.readFileSync(concurrentResultPath, 'utf8')),
      governanceEvents: fs.readFileSync(governanceLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const serializedGitHubWrite = runIsolatedSerializedGitHubWrite();
assert.equal(serializedGitHubWrite.direct.status, 2);
assert.match(serializedGitHubWrite.direct.stderr, /github-write|完整远端操作|真实命令/);
assert.equal(
  serializedGitHubWrite.wrapped.status,
  0,
  serializedGitHubWrite.wrapped.stderr || serializedGitHubWrite.wrapped.stdout,
);
assert.deepEqual(serializedGitHubWrite.concurrentCodes, [0, 0]);
assert.deepEqual(
  serializedGitHubWrite.governanceEvents.map((event) => event.event),
  ['start', 'end', 'start', 'end'],
  'offline governance and the real remote command must share one execution lock',
);

function runIsolatedAuthorizedIssueCreation(options = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-issue-create-'));
  const repo = path.join(sandbox, 'repo');
  const fakeBin = path.join(sandbox, 'bin');
  const harnessHome = path.join(sandbox, 'home');
  const writeLog = path.join(sandbox, 'writes.json');
  const governanceLog = path.join(sandbox, 'governance.json');
  const simulatedFailureMarker = path.join(sandbox, 'remote-created-before-local-ledger');
  fs.mkdirSync(repo, { recursive: true });
  const projectSlug = fs.realpathSync.native(repo).replace(/[^a-zA-Z0-9]/g, '-');
  const projectMemoryRoot = path.join(
    harnessHome,
    '.claude',
    'projects',
    projectSlug,
  );
  const memoryDirectory = path.join(projectMemoryRoot, 'memory');
  const manifestPath = path.join(memoryDirectory, 'candidates.json');
  const rawManifest = `${JSON.stringify({
    version: 1,
    issues: [
      {
        title: '需求讨论：补齐前端异常提示证据',
        body: '### 问题\n\n当前前端异常提示缺少可定位证据。\n\n### 下一步\n\n等待 Codex 去重、范围与 AC 复核后正式评级。',
      },
      {
        title: '需求讨论：统一前端空状态说明',
        body: '### 问题\n\n当前前端空状态说明存在不一致。\n\n### 下一步\n\n等待 Codex 去重、范围与 AC 复核后正式评级。',
      },
    ],
  }, null, 2)}\n`;
  const manifest = validateIssueCreationManifest(rawManifest);
  const observedAt = new Date().toISOString();
  const approvalBody =
    `[PM-ISSUE-CREATION] decision=approved manifest-sha256=${manifest.sha256} count=2`;

  function runGit(args) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  }

  try {
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(memoryDirectory, { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.writeFileSync(manifestPath, rawManifest, 'utf8');
    fs.writeFileSync(writeLog, '[]\n', 'utf8');
    fs.writeFileSync(governanceLog, '[]\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf8');
    fs.writeFileSync(
      path.join(repo, 'scripts', 'offline-github-governance.cjs'),
      `const fs=require('node:fs');const p=${JSON.stringify(governanceLog)};` +
      `const rows=JSON.parse(fs.readFileSync(p,'utf8'));rows.push(Date.now());` +
      `fs.writeFileSync(p,JSON.stringify(rows));console.log('offline GitHub governance: PASS');\n`,
      'utf8',
    );
    runGit(['init', '--initial-branch=issue-create-test']);
    runGit(['config', 'user.name', 'Issue Create Test']);
    runGit(['config', 'user.email', 'issue-create@example.invalid']);
    runGit(['add', '.']);
    runGit(['commit', '-m', 'test: seed issue creation fixture']);

    const fakeGh = path.join(fakeBin, 'gh');
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(writeLog)};
const failureMarker = ${JSON.stringify(simulatedFailureMarker)};
const failAfterFirstRemoteCreate = ${JSON.stringify(options.failAfterFirstRemoteCreate === true)};
const observedAt = ${JSON.stringify(observedAt)};
const approvalBody = ${JSON.stringify(approvalBody)};
const rows = JSON.parse(fs.readFileSync(logPath, 'utf8'));
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({ nameWithOwner: 'acme/coreone', url: 'https://github.com/acme/coreone' }));
} else if (args[0] === 'api' && args[1] === 'repos/acme/coreone/issues/comments/222') {
  console.log(JSON.stringify({
    issue_url: 'https://api.github.com/repos/acme/coreone/issues/1',
    created_at: observedAt,
    user: { login: 'acme' },
    body: approvalBody,
  }));
} else if (args[0] === 'api' && args[1] === 'user') {
  console.log('acme');
} else if (args[0] === 'issue' && args[1] === 'list') {
  console.log(JSON.stringify(rows.map((item) => ({
    number: item.number,
    state: 'OPEN',
    url: 'https://github.com/acme/coreone/issues/' + item.number,
    title: item.title,
    body: item.body,
    createdAt: item.createdAt,
    author: { login: 'acme' },
  }))));
} else if (args[0] === 'issue' && args[1] === 'create') {
  const titleIndex = args.indexOf('--title');
  const bodyIndex = args.indexOf('--body');
  const number = 101 + rows.length;
  rows.push({
    number,
    at: Date.now(),
    createdAt: new Date().toISOString(),
    title: args[titleIndex + 1],
    body: args[bodyIndex + 1],
  });
  fs.writeFileSync(logPath, JSON.stringify(rows));
  if (failAfterFirstRemoteCreate && !fs.existsSync(failureMarker)) {
    fs.writeFileSync(failureMarker, String(number));
    console.error('simulated transport loss after remote create');
    process.exitCode = 17;
  } else {
    console.log('https://github.com/acme/coreone/issues/' + number);
  }
} else if (args[0] === 'issue' && args[1] === 'view' && args[2] === '1') {
  console.log(JSON.stringify({
    number: 1,
    state: 'OPEN',
    url: 'https://github.com/acme/coreone/issues/1',
    updatedAt: observedAt,
  }));
} else if (args[0] === 'issue' && args[1] === 'view') {
  const found = rows.find((item) => item.number === Number(args[2]));
  if (!found) process.exitCode = 9;
  else console.log(JSON.stringify({
    number: found.number,
    state: 'OPEN',
    url: 'https://github.com/acme/coreone/issues/' + found.number,
    title: found.title,
    body: found.body,
    labels: [],
  }));
} else {
  console.error('unexpected fake gh invocation: ' + args.join(' '));
  process.exitCode = 9;
}
`, { encoding: 'utf8', mode: 0o755 });

    const command = [
      path.join(__dirname, 'claude-task.cjs'),
      'create-issues',
      `--manifest=${manifestPath}`,
      '--approval=https://github.com/acme/coreone/issues/1#issuecomment-222',
    ];
    const env = {
      ...process.env,
      HOME: harnessHome,
      CLAUDE_CONFIG_DIR: path.join(harnessHome, '.claude'),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
    };
    const first = spawnSync(process.execPath, command, { cwd: repo, encoding: 'utf8', env });
    const firstWrites = JSON.parse(fs.readFileSync(writeLog, 'utf8'));
    const second = spawnSync(process.execPath, command, { cwd: repo, encoding: 'utf8', env });
    const secondWrites = JSON.parse(fs.readFileSync(writeLog, 'utf8'));
    const third = options.failAfterFirstRemoteCreate
      ? spawnSync(process.execPath, command, { cwd: repo, encoding: 'utf8', env })
      : null;
    const finalWrites = JSON.parse(fs.readFileSync(writeLog, 'utf8'));
    const governanceRuns = JSON.parse(fs.readFileSync(governanceLog, 'utf8'));
    const ledgerPath = path.join(repo, '.git', 'coreone', 'issue-creation-ledger.json');
    assert.equal(
      fs.existsSync(ledgerPath),
      true,
      `issue creation did not reach ledger initialization: ${first.stderr || first.stdout}`,
    );
    return {
      first,
      second,
      third,
      firstWrites,
      secondWrites,
      finalWrites,
      governanceRuns,
      ledger: JSON.parse(fs.readFileSync(ledgerPath, 'utf8')),
      manifest,
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const authorizedIssueCreation = runIsolatedAuthorizedIssueCreation();
assert.equal(authorizedIssueCreation.first.status, 0, authorizedIssueCreation.first.stderr);
assert.match(authorizedIssueCreation.first.stdout, /2\/2/);
assert.equal(authorizedIssueCreation.firstWrites.length, 2);
assert.equal(authorizedIssueCreation.governanceRuns.length, 2);
assert(
  authorizedIssueCreation.firstWrites[1].at - authorizedIssueCreation.firstWrites[0].at >= 950,
  'adjacent GitHub mutations must be spaced by at least one second (allowing clock granularity)',
);
assert.equal(
  authorizedIssueCreation.ledger.consumed[authorizedIssueCreation.manifest.sha256].status,
  'completed',
);
assert(
  authorizedIssueCreation.ledger.consumed[authorizedIssueCreation.manifest.sha256]
    .issues.every((item) => item.readbackVerified === true),
);
assert.equal(authorizedIssueCreation.second.status, 1);
assert.match(authorizedIssueCreation.second.stderr, /禁止重放/);
assert.equal(authorizedIssueCreation.finalWrites.length, 2);

const recoveredIssueCreation = runIsolatedAuthorizedIssueCreation({
  failAfterFirstRemoteCreate: true,
});
assert.equal(recoveredIssueCreation.first.status, 1);
assert.match(recoveredIssueCreation.first.stderr, /simulated transport loss|串行创建停止/);
assert.equal(recoveredIssueCreation.firstWrites.length, 1);
assert.equal(
  recoveredIssueCreation.second.status,
  0,
  recoveredIssueCreation.second.stderr || recoveredIssueCreation.second.stdout,
);
assert.match(recoveredIssueCreation.second.stdout, /2\/2/);
assert.equal(recoveredIssueCreation.secondWrites.length, 2);
assert.equal(
  recoveredIssueCreation.secondWrites.filter((item) =>
    item.title === recoveredIssueCreation.manifest.issues[0].title).length,
  1,
  'recovery must adopt the exact remote Issue instead of creating a duplicate',
);
assert.equal(
  recoveredIssueCreation.ledger.consumed[recoveredIssueCreation.manifest.sha256].status,
  'completed',
);
assert(
  recoveredIssueCreation.ledger.consumed[recoveredIssueCreation.manifest.sha256]
    .issues.every((item) => item.readbackVerified === true),
);
assert.equal(recoveredIssueCreation.third.status, 1);
assert.match(recoveredIssueCreation.third.stderr, /禁止重放/);
assert.equal(recoveredIssueCreation.finalWrites.length, 2);

function runIsolatedHandoff(leastConfidence, transformBody = (body) => body) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-handoff-lifecycle-'));
  const repo = path.join(sandbox, 'repo');
  const remote = path.join(sandbox, 'origin.git');
  const fakeBin = path.join(sandbox, 'bin');
  const issueBody = `<!-- coreone-owner:start -->
- **current owner**: Test Owner
<!-- coreone-owner:end -->`;
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  const observedAt = new Date().toISOString();
  const handoffBody = transformBody(`[HANDOFF] status=blocked
result: isolated lifecycle proof
evidence: local fake GitHub fixture
risk: release remains blocked
next-owner: reviewer
trigger: fixed SHA available
least-confidence: ${leastConfidence}
biggest-missing: risk-v1; anchor=name:external caller inventory; uncertainty=unknown:inventory completeness`);

  function runGit(args, cwd = repo) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
    return String(result.stdout || '').trim();
  }

  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    runGit(['init', '--bare', remote], sandbox);
    runGit(['init', '--initial-branch=task-reflection-test'], repo);
    runGit(['config', 'user.name', 'Reflection Test'], repo);
    runGit(['config', 'user.email', 'reflection-test@example.invalid'], repo);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf8');
    runGit(['add', 'seed.txt'], repo);
    runGit(['commit', '-m', 'test: seed isolated handoff repo'], repo);
    runGit(['remote', 'add', 'origin', remote], repo);
    runGit(['push', 'origin', 'HEAD:refs/heads/master'], repo);

    const head = runGit(['rev-parse', 'HEAD'], repo);
    const statePath = runGit(
      ['rev-parse', '--path-format=absolute', '--git-path', 'coreone/claude-task-state.json'],
      repo,
    );
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({
      version: 1,
      mode: 'governed',
      issue: 81,
      issueUrl: 'https://github.com/acme/coreone/issues/81',
      issueTitle: 'Reflection regression',
      issueBodyHash: crypto.createHash('sha256').update(issueBody, 'utf8').digest('hex'),
      issuePriority: 'P1',
      issueReleaseImpact: '阻断上线',
      stage: 'implementation',
      owner: 'Test Owner',
      risk: 'R1',
      branch: 'task-reflection-test',
      baseSha: head,
      startedHead: head,
      startedAt,
      verifiedAt: startedAt,
      owned: ['scripts/**'],
      excluded: [],
    }, null, 2)}\n`, 'utf8');

    const fakeGh = path.join(fakeBin, 'gh');
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
const issueBody = ${JSON.stringify(issueBody)};
const observedAt = ${JSON.stringify(observedAt)};
const handoffBody = ${JSON.stringify(handoffBody)};
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({ nameWithOwner: 'acme/coreone', url: 'https://github.com/acme/coreone' }));
} else if (args[0] === 'issue' && args[1] === 'view') {
  console.log(JSON.stringify({
    number: 81,
    state: 'OPEN',
    url: 'https://github.com/acme/coreone/issues/81',
    body: issueBody,
    labels: [{ name: 'P1' }, { name: '阻断上线' }],
    updatedAt: observedAt,
  }));
} else if (args[0] === 'api' && args[1] === 'repos/acme/coreone/issues/comments/123') {
  console.log(JSON.stringify({
    issue_url: 'https://api.github.com/repos/acme/coreone/issues/81',
    created_at: observedAt,
    user: { login: 'test-actor' },
    body: handoffBody,
  }));
} else if (args[0] === 'api' && args[1] === 'user') {
  console.log('test-actor');
} else {
  console.error('unexpected fake gh invocation: ' + args.join(' '));
  process.exitCode = 9;
}
`, { encoding: 'utf8', mode: 0o755 });

    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, 'claude-task.cjs'),
        'handoff',
        '--status=blocked',
        '--evidence=https://github.com/acme/coreone/issues/81#issuecomment-123',
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` },
      },
    );
    return {
      status: result.status,
      stdout: String(result.stdout || ''),
      stderr: String(result.stderr || ''),
      stateExists: fs.existsSync(statePath),
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function runIsolatedRatingRebaseline(options = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-rating-rebaseline-'));
  const repo = path.join(sandbox, 'repo');
  const remote = path.join(sandbox, 'origin.git');
  const fakeBin = path.join(sandbox, 'bin');
  const liveOwner = options.liveOwner || 'Test Owner';
  const stateOwner = options.stateOwner || 'Test Owner';
  const issueBody = `<!-- coreone-owner:start -->
- **current owner**: ${liveOwner}
<!-- coreone-owner:end -->`;
  const startedAt = new Date(Date.now() - 2_000).toISOString();
  const observedAt = new Date().toISOString();
  const livePriority = options.livePriority || 'P2';
  const liveReleaseImpact = options.liveReleaseImpact || '非阻断上线';
  const statePriority = Object.hasOwn(options, 'statePriority') ? options.statePriority : 'P1';
  const stateReleaseImpact = Object.hasOwn(options, 'stateReleaseImpact')
    ? options.stateReleaseImpact
    : '阻断上线';
  const previous = statePriority && stateReleaseImpact
    ? `${statePriority}/${stateReleaseImpact}`
    : 'UNRECORDED/UNRECORDED';
  const ratingBody = options.ratingBody || (
    `[ISSUE-RATING] owner=Codex previous=${previous} ` +
    `current=${livePriority}/${liveReleaseImpact} reason=复核证据改变了当前发布处置`
  );
  const handoffBody = `[HANDOFF] status=blocked
result: isolated rating drift proof
evidence: local fake GitHub fixture
risk: release remains blocked
next-owner: reviewer
trigger: rating baseline restored
least-confidence: risk-v1; anchor=name:rating lifecycle; uncertainty=unverified:rebaseline path
biggest-missing: no-finding-v1; checked=path:scripts/claude-task.cjs; unchecked=ref:Issue#81`;

  function runGit(args, cwd = repo) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.stdout}`);
    return String(result.stdout || '').trim();
  }

  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    runGit(['init', '--bare', remote], sandbox);
    runGit(['init', '--initial-branch=task-rating-test'], repo);
    runGit(['config', 'user.name', 'Rating Test'], repo);
    runGit(['config', 'user.email', 'rating-test@example.invalid'], repo);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n', 'utf8');
    runGit(['add', 'seed.txt'], repo);
    runGit(['commit', '-m', 'test: seed isolated rating repo'], repo);
    runGit(['remote', 'add', 'origin', remote], repo);
    runGit(['push', 'origin', 'HEAD:refs/heads/master'], repo);

    const head = runGit(['rev-parse', 'HEAD'], repo);
    const statePath = runGit(
      ['rev-parse', '--path-format=absolute', '--git-path', 'coreone/claude-task-state.json'],
      repo,
    );
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const state = {
      version: options.stateVersion ?? 2,
      mode: 'governed',
      issue: 81,
      issueUrl: 'https://github.com/acme/coreone/issues/81',
      issueTitle: 'Rating lifecycle regression',
      issueBodyHash: crypto.createHash('sha256')
        .update(options.bodyDrift ? `${issueBody}\nstale` : issueBody, 'utf8')
        .digest('hex'),
      stage: 'implementation',
      owner: stateOwner,
      risk: 'R1',
      branch: options.stateBranch || 'task-rating-test',
      baseSha: options.baseDrift ? '0000000000000000000000000000000000000000' : head,
      startedHead: head,
      startedAt,
      verifiedAt: startedAt,
      owned: ['scripts/**'],
      excluded: [],
    };
    if (statePriority !== undefined) state.issuePriority = statePriority;
    if (stateReleaseImpact !== undefined) state.issueReleaseImpact = stateReleaseImpact;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const fakeGh = path.join(fakeBin, 'gh');
    fs.writeFileSync(fakeGh, `#!/usr/bin/env node
'use strict';
const args = process.argv.slice(2);
const issueBody = ${JSON.stringify(issueBody)};
const observedAt = ${JSON.stringify(observedAt)};
const ratingBody = ${JSON.stringify(ratingBody)};
const handoffBody = ${JSON.stringify(handoffBody)};
const commentIssue = ${JSON.stringify(options.commentIssue || 81)};
const commentActor = ${JSON.stringify(options.commentActor || 'test-actor')};
const currentActor = ${JSON.stringify(options.currentActor || 'test-actor')};
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({ nameWithOwner: 'acme/coreone', url: 'https://github.com/acme/coreone' }));
} else if (args[0] === 'issue' && args[1] === 'view') {
  console.log(JSON.stringify({
    number: Number(args[2]),
    state: 'OPEN',
    url: 'https://github.com/acme/coreone/issues/' + args[2],
    body: issueBody,
    labels: [{ name: ${JSON.stringify(livePriority)} }, { name: ${JSON.stringify(liveReleaseImpact)} }],
    updatedAt: observedAt,
  }));
} else if (args[0] === 'api' && args[1] === 'repos/acme/coreone/issues/comments/456') {
  console.log(JSON.stringify({
    issue_url: 'https://api.github.com/repos/acme/coreone/issues/' + commentIssue,
    created_at: observedAt,
    user: { login: commentActor },
    body: ratingBody,
  }));
} else if (args[0] === 'api' && args[1] === 'repos/acme/coreone/issues/comments/123') {
  console.log(JSON.stringify({
    issue_url: 'https://api.github.com/repos/acme/coreone/issues/81',
    created_at: observedAt,
    user: { login: currentActor },
    body: handoffBody,
  }));
} else if (args[0] === 'api' && args[1] === 'user') {
  console.log(currentActor);
} else {
  console.error('unexpected fake gh invocation: ' + args.join(' '));
  process.exitCode = 9;
}
`, { encoding: 'utf8', mode: 0o755 });

    const commandArgs = options.handoffBefore
      ? [
          path.join(__dirname, 'claude-task.cjs'),
          'handoff',
          '--status=blocked',
          '--evidence=https://github.com/acme/coreone/issues/81#issuecomment-123',
        ]
      : [
          path.join(__dirname, 'claude-task.cjs'),
          'rebaseline-rating',
          `--evidence=https://github.com/acme/coreone/issues/${options.evidenceIssue || 81}#issuecomment-456`,
        ];
    const result = spawnSync(process.execPath, commandArgs, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` },
    });
    const finalResult = options.handoffAfter && result.status === 0
      ? spawnSync(
          process.execPath,
          [
            path.join(__dirname, 'claude-task.cjs'),
            'handoff',
            '--status=blocked',
            '--evidence=https://github.com/acme/coreone/issues/81#issuecomment-123',
          ],
          {
            cwd: repo,
            encoding: 'utf8',
            env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` },
          },
        )
      : result;
    return {
      status: finalResult.status,
      stdout: String(finalResult.stdout || ''),
      stderr: String(finalResult.stderr || ''),
      rebaselineStatus: result.status,
      rebaselineStderr: String(result.stderr || ''),
      stateExists: fs.existsSync(statePath),
      initialStateRaw: `${JSON.stringify(state, null, 2)}\n`,
      stateRaw: fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null,
      state: fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null,
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const blockedBeforeRatingAck = runIsolatedRatingRebaseline({ handoffBefore: true });
assert.equal(blockedBeforeRatingAck.status, 1);
assert.equal(blockedBeforeRatingAck.stateExists, true);
assert.match(blockedBeforeRatingAck.stderr, /rebaseline-rating/);

for (const [name, options, pattern] of [
  ['wrong Issue', { evidenceIssue: 82, commentIssue: 82 }, /活动 Issue/],
  ['wrong actor', { commentActor: 'other-actor' }, /操作者/],
  [
    'non-canonical rating owner',
    {
      ratingBody:
        '[ISSUE-RATING] owner=codex previous=P1/阻断上线 ' +
        'current=P2/非阻断上线 reason=评级 owner 大小写故意不规范',
    },
    /评级证据评论/,
  ],
  [
    'mismatched current marker',
    {
      ratingBody:
        '[ISSUE-RATING] owner=Codex previous=P1/阻断上线 ' +
        'current=P1/非阻断上线 reason=评论与实时标签故意不一致',
    },
    /current=.*实时标签/,
  ],
  [
    'mismatched previous marker',
    {
      ratingBody:
        '[ISSUE-RATING] owner=Codex previous=P2/阻断上线 ' +
        'current=P2/非阻断上线 reason=评论与旧基线故意不一致',
    },
    /previous=.*本地 state/,
  ],
  [
    'HTML-hidden marker',
    { ratingBody: `<!--\n${canonicalRatingMarker}\n-->` },
    /评级证据评论/,
  ],
  [
    'fenced marker',
    { ratingBody: `\`\`\`text\n${canonicalRatingMarker}\n\`\`\`` },
    /评级证据评论/,
  ],
  ['Issue body drift', { bodyDrift: true }, /body 已变化/],
  ['Issue owner drift', { stateOwner: 'Original Owner', liveOwner: 'Changed Owner' }, /owner 已变化/],
  ['branch drift', { stateBranch: 'other-branch' }, /branch 已变化/],
  ['base drift', { baseDrift: true }, /failed|origin\/master|merge-base/],
]) {
  const result = runIsolatedRatingRebaseline(options);
  assert.equal(result.status, 1, `${name}: expected rebaseline failure`);
  assert.equal(result.stateExists, true, `${name}: state must survive failed rebaseline`);
  assert.equal(result.stateRaw, result.initialStateRaw, `${name}: failed rebaseline must preserve state bytes`);
  assert.match(result.stderr, pattern, name);
}

const validRatingRebaseline = runIsolatedRatingRebaseline();
assert.equal(validRatingRebaseline.status, 0, validRatingRebaseline.stderr);
assert.equal(validRatingRebaseline.state.version, 2);
assert.equal(validRatingRebaseline.state.issuePriority, 'P2');
assert.equal(validRatingRebaseline.state.issueReleaseImpact, '非阻断上线');
assert.match(validRatingRebaseline.state.ratingEvidenceUrl, /issuecomment-456/);

const validRatingUpgrade = runIsolatedRatingRebaseline({
  statePriority: 'P2',
  stateReleaseImpact: '非阻断上线',
  livePriority: 'P1',
  liveReleaseImpact: '阻断上线',
});
assert.equal(validRatingUpgrade.status, 0, validRatingUpgrade.stderr);
assert.equal(validRatingUpgrade.state.issuePriority, 'P1');
assert.equal(validRatingUpgrade.state.issueReleaseImpact, '阻断上线');

const validSchemaOnlyRatingMigration = runIsolatedRatingRebaseline({
  stateVersion: 1,
  statePriority: 'P2',
  stateReleaseImpact: '非阻断上线',
  livePriority: 'P2',
  liveReleaseImpact: '非阻断上线',
  ratingBody:
    '[ISSUE-RATING] owner=Codex previous=P2/非阻断上线 ' +
    'current=P2/非阻断上线 reason=旧版任务状态仅升级 schema 并保留既有双轴',
});
assert.equal(validSchemaOnlyRatingMigration.status, 0, validSchemaOnlyRatingMigration.stderr);
assert.equal(validSchemaOnlyRatingMigration.state.version, 2);

const validLegacyRatingMigration = runIsolatedRatingRebaseline({
  stateVersion: 1,
  statePriority: undefined,
  stateReleaseImpact: undefined,
  ratingBody:
    '[ISSUE-RATING] owner=Codex previous=UNRECORDED/UNRECORDED ' +
    'current=P2/非阻断上线 reason=旧版任务状态缺少评级字段需要迁移',
});
assert.equal(validLegacyRatingMigration.status, 0, validLegacyRatingMigration.stderr);
assert.equal(validLegacyRatingMigration.state.version, 2);
assert.equal(validLegacyRatingMigration.state.issuePriority, 'P2');
assert.equal(validLegacyRatingMigration.state.issueReleaseImpact, '非阻断上线');

const validRatingThenHandoff = runIsolatedRatingRebaseline({ handoffAfter: true });
assert.equal(validRatingThenHandoff.rebaselineStatus, 0, validRatingThenHandoff.rebaselineStderr);
assert.equal(validRatingThenHandoff.status, 0, validRatingThenHandoff.stderr);
assert.equal(validRatingThenHandoff.stateExists, false);

const invalidHandoff = runIsolatedHandoff('LGTM');
if (invalidHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `invalid handoff end-to-end expected exit=1, actual=${invalidHandoff.status}`,
  );
}
if (!invalidHandoff.stateExists) {
  reflectionRegressionFailures.push('invalid handoff end-to-end removed the active task state file');
}
if (!/least-confidence/.test(invalidHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `invalid handoff end-to-end did not report least-confidence: ${invalidHandoff.stderr}`,
  );
}
for (const pseudoDeclaration of ['<!z>', '<!doctype html>']) {
  const hiddenLowercaseTypeFourHandoff = runIsolatedHandoff(
    strongLeastConfidence,
    (body) => body.replace(
      /^least-confidence:[^\n]*\nbiggest-missing:[^\n]*$/m,
      `
[
${pseudoDeclaration}
least-confidence: ${strongLeastConfidence}
biggest-missing: ${strongBiggestMissing}
custom-note: terminates-field-continuation
]: /hidden-reflection`,
    ),
  );
  assert.equal(
    hiddenLowercaseTypeFourHandoff.status,
    1,
    `${pseudoDeclaration} hidden handoff must fail`,
  );
  assert.equal(
    hiddenLowercaseTypeFourHandoff.stateExists,
    true,
    `${pseudoDeclaration} hidden handoff must retain task state`,
  );
  assert.match(hiddenLowercaseTypeFourHandoff.stderr, /least-confidence|biggest-missing/);
}
const invalidTypedHandoff = runIsolatedHandoff(
  'no-finding-v1; checked=id:auth; unchecked=name:auth',
);
if (invalidTypedHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `invalid typed handoff expected exit=1, actual=${invalidTypedHandoff.status}`,
  );
}
if (!invalidTypedHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'invalid typed handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(invalidTypedHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `invalid typed handoff did not report least-confidence: ${invalidTypedHandoff.stderr}`,
  );
}
for (const [name, value] of [
  ['oversized raw-wire', encodedRawWire6KiB],
  ['punctuated uncertainty placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无。'],
  ['punctuated no-finding placeholders', 'no-finding-v1; checked=name:everything.; unchecked=name:nothing.'],
  ['unknown uncertainty placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown.'],
  ['terminal-filler uncertainty placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:无_'],
  ['terminal-filler no-finding placeholders', 'no-finding-v1; checked=name:everything_; unchecked=name:nothing+'],
]) {
  const lifecycle = runIsolatedHandoff(value);
  if (lifecycle.status !== 1) {
    reflectionRegressionFailures.push(
      `${name} handoff expected exit=1, actual=${lifecycle.status}`,
    );
  }
  if (!lifecycle.stateExists) {
    reflectionRegressionFailures.push(
      `${name} handoff removed the active task state file`,
    );
  }
  if (!/least-confidence/.test(lifecycle.stderr)) {
    reflectionRegressionFailures.push(
      `${name} handoff did not report least-confidence: ${lifecycle.stderr}`,
    );
  }
}
const newPlaceholderLifecycleFailures = [];
for (const [name, value] of [
  ['N/A separator placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:n-a。/_+-'],
  ['N/A separator no-finding placeholder', 'no-finding-v1; checked=name:n_a; unchecked=name:库存同步'],
  ['amp-tail uncertainty placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown&amp;'],
  ['amp-tail no-finding placeholders', 'no-finding-v1; checked=name:everything&amp;; unchecked=name:nothing&amp;'],
  ['incomplete supported entity placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:unknown&amp;amp'],
  ['NFKC incomplete supported entity placeholder', 'risk-v1; anchor=id:auth; uncertainty=unknown:ｕｎｋｎｏｗｎ＆ａｍｐ'],
]) {
  const lifecycle = runIsolatedHandoff(value);
  if (lifecycle.status !== 1) {
    newPlaceholderLifecycleFailures.push(
      `${name}: expected exit=1, actual=${lifecycle.status}`,
    );
  }
  if (!lifecycle.stateExists) {
    newPlaceholderLifecycleFailures.push(`${name}: active task state was deleted`);
  }
  if (!/least-confidence/.test(lifecycle.stderr)) {
    newPlaceholderLifecycleFailures.push(
      `${name}: missing least-confidence error (${lifecycle.stderr})`,
    );
  }
}
assert.deepEqual(
  newPlaceholderLifecycleFailures,
  [],
  'N/A, amp-tail, and incomplete-entity handoffs must fail before state deletion',
);
for (const [name, value] of [
  [
    'apostrophe incomplete supported entity',
    "risk-v1; anchor=id:auth; uncertainty=unknown:unknown&amp;amp'",
  ],
  [
    'CJK-boundary incomplete supported entity',
    'risk-v1; anchor=id:auth; uncertainty=unknown:unknown&amp;am中',
  ],
  ...postNfkcUnknownEntityContracts.map(([name, value]) => [name, value]),
]) {
  const lifecycle = runIsolatedHandoff(value);
  if (lifecycle.status !== 1) {
    reflectionRegressionFailures.push(
      `${name} lifecycle expected exit=1, actual=${lifecycle.status}`,
    );
  }
  if (!lifecycle.stateExists) {
    reflectionRegressionFailures.push(`${name} lifecycle deleted active task state`);
  }
  if (!/least-confidence/.test(lifecycle.stderr)) {
    reflectionRegressionFailures.push(
      `${name} lifecycle missed least-confidence error: ${lifecycle.stderr}`,
    );
  }
}
for (const [name, value] of [
  ...ampersandOrderContracts,
  ...delimiterDisambiguationValidContracts,
  ...structuralTabValidContracts,
]) {
  const lifecycle = runIsolatedHandoff(value);
  if (lifecycle.status !== 0) {
    reflectionRegressionFailures.push(
      `${name} lifecycle expected exit=0, actual=${lifecycle.status}: ${lifecycle.stderr}`,
    );
  }
  if (lifecycle.stateExists) {
    reflectionRegressionFailures.push(`${name} lifecycle retained active task state`);
  }
}
for (const [name, value] of structuralTabInvalidContracts) {
  const lifecycle = runIsolatedHandoff(value);
  if (lifecycle.status !== 1) {
    reflectionRegressionFailures.push(
      `${name} lifecycle expected exit=1, actual=${lifecycle.status}`,
    );
  }
  if (!lifecycle.stateExists) {
    reflectionRegressionFailures.push(`${name} lifecycle deleted active task state`);
  }
  if (!/least-confidence/.test(lifecycle.stderr)) {
    reflectionRegressionFailures.push(
      `${name} lifecycle missed least-confidence error: ${lifecycle.stderr}`,
    );
  }
}
for (const [endingName, lineEnding] of lazyContinuationLineEndings) {
  for (const [payloadName, payload] of lazyContinuationPayloads) {
    const lifecycle = runIsolatedHandoff(
      strongLeastConfidence,
      (body) => body.replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${payload}`,
      ),
    );
    if (lifecycle.status !== 1) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle expected exit=1, actual=${lifecycle.status}`,
      );
    }
    if (!lifecycle.stateExists) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle deleted active task state`,
      );
    }
    if (!/least-confidence/.test(lifecycle.stderr)) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle missed least-confidence error: ` +
        lifecycle.stderr,
      );
    }
  }
}
for (const [endingName, lineEnding] of lazyContinuationLineEndings) {
  for (const [payloadName, payload] of [
    ...ambiguousUnknownContinuationPayloads,
    ...hangingContinuationPayloads,
  ]) {
    const lifecycle = runIsolatedHandoff(
      strongLeastConfidence,
      (body) => body.replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${payload}`,
      ),
    );
    if (lifecycle.status !== 1) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle expected exit=1, actual=${lifecycle.status}`,
      );
    }
    if (!lifecycle.stateExists) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle deleted active task state`,
      );
    }
    if (!/least-confidence/.test(lifecycle.stderr)) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle missed least-confidence error: ` +
        lifecycle.stderr,
      );
    }
  }
  for (const [payloadName, payload] of [
    ...unknownBoundaryMimicPayloads.map(([name, handoffPayload]) => [name, handoffPayload]),
    ...rootFenceLikeHangingContinuationPayloads,
  ]) {
    const lifecycle = runIsolatedHandoff(
      strongLeastConfidence,
      (body) => body.replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${payload}`,
      ),
    );
    if (lifecycle.status !== 1) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle expected exit=1, actual=${lifecycle.status}`,
      );
    }
    if (!lifecycle.stateExists) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle deleted active task state`,
      );
    }
    if (!/least-confidence/.test(lifecycle.stderr)) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} lifecycle missed least-confidence error: ` +
        lifecycle.stderr,
      );
    }
  }
  for (const [payloadName, payload] of emptyKeyContinuationPayloads) {
    const lifecycle = runIsolatedHandoff(
      strongLeastConfidence,
      (body) => body.replace(
        handoffStrongLeastConfidenceLine,
        `${handoffStrongLeastConfidenceLine}${lineEnding}${payload}`,
      ),
    );
    if (lifecycle.status !== 1) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} empty-key lifecycle expected exit=1, ` +
        `actual=${lifecycle.status}`,
      );
    }
    if (!lifecycle.stateExists) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} empty-key lifecycle deleted active task state`,
      );
    }
    if (!/least-confidence/.test(lifecycle.stderr)) {
      reflectionRegressionFailures.push(
        `${endingName}/${payloadName} empty-key lifecycle missed least-confidence: ` +
        lifecycle.stderr,
      );
    }
  }
  for (const [blockName, block] of issueMarkdownBlockBoundaries) {
    for (const order of ['after', 'before']) {
      const lifecycle = runIsolatedHandoff(
        strongLeastConfidence,
        (body) => body.replace(
          handoffStrongLeastConfidenceLine,
          order === 'after'
            ? `${handoffStrongLeastConfidenceLine}${lineEnding}${block}`
            : `${block}${lineEnding}${handoffStrongLeastConfidenceLine}`,
        ),
      );
      if (lifecycle.status !== 0) {
        reflectionRegressionFailures.push(
          `${endingName}/${blockName}/${order} block lifecycle expected exit=0, ` +
          `actual=${lifecycle.status}: ${lifecycle.stderr}`,
        );
      }
      if (lifecycle.stateExists) {
        reflectionRegressionFailures.push(
          `${endingName}/${blockName}/${order} block lifecycle retained task state`,
        );
      }
    }
  }
}
const observationNoFindingHandoff = runIsolatedHandoff('暂未观察到异常');
if (observationNoFindingHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `observation no-finding handoff expected exit=1, actual=${observationNoFindingHandoff.status}`,
  );
}
if (!observationNoFindingHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'observation no-finding handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(observationNoFindingHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `observation no-finding handoff did not report least-confidence: ${observationNoFindingHandoff.stderr}`,
  );
}
const leafHiddenHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => `Leaf heading
===
<custom-element>
${body}`,
);
if (leafHiddenHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `Setext/Type7 hidden handoff expected exit=1, actual=${leafHiddenHandoff.status}`,
  );
}
if (!leafHiddenHandoff.stateExists) {
  reflectionRegressionFailures.push('Setext/Type7 hidden handoff removed the active task state file');
}
if (!/result|least-confidence/.test(leafHiddenHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `Setext/Type7 hidden handoff did not report hidden fields: ${leafHiddenHandoff.stderr}`,
  );
}
const multilineLinkHiddenHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => `[leaf]: /url
  "title"
<custom-element>
${body}`,
);
if (multilineLinkHiddenHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `multiline-link/Type7 hidden handoff expected exit=1, actual=${multilineLinkHiddenHandoff.status}`,
  );
}
if (!multilineLinkHiddenHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'multiline-link/Type7 hidden handoff removed the active task state file',
  );
}
if (!/result|least-confidence/.test(multilineLinkHiddenHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `multiline-link/Type7 hidden handoff did not report hidden fields: ${multilineLinkHiddenHandoff.stderr}`,
  );
}
for (const [name, labelPrefix] of [
  ['encoded heading marker', '&#35; note'],
  ['encoded list marker', '&#45; note'],
  ['encoded blockquote marker', '&#62; note'],
]) {
  const lifecycle = runIsolatedHandoff(
    strongLeastConfidence,
    (body) => body.replace(
      handoffStrongLeastConfidenceLine,
      `[
${labelPrefix}
${handoffStrongLeastConfidenceLine}
]: /hidden`,
    ),
  );
  if (lifecycle.status !== 1) {
    reflectionRegressionFailures.push(
      `${name} hidden-label lifecycle expected exit=1, actual=${lifecycle.status}`,
    );
  }
  if (!lifecycle.stateExists) {
    reflectionRegressionFailures.push(
      `${name} hidden-label lifecycle removed the active task state file`,
    );
  }
  if (!/least-confidence/.test(lifecycle.stderr)) {
    reflectionRegressionFailures.push(
      `${name} hidden-label lifecycle did not report least-confidence: ${lifecycle.stderr}`,
    );
  }
}
for (const [name, opener] of [
  ['blockquote lazy continuation', '> ['],
  ['list lazy continuation', '- ['],
]) {
  const lifecycle = runIsolatedHandoff(
    strongLeastConfidence,
    (body) => body.replace(
      handoffStrongLeastConfidenceLine,
      `${opener}
${handoffStrongLeastConfidenceLine}
]: /hidden`,
    ),
  );
  if (lifecycle.status !== 1) {
    reflectionRegressionFailures.push(
      `${name} hidden-label lifecycle expected exit=1, actual=${lifecycle.status}`,
    );
  }
  if (!lifecycle.stateExists) {
    reflectionRegressionFailures.push(
      `${name} hidden-label lifecycle removed the active task state file`,
    );
  }
  if (!/least-confidence/.test(lifecycle.stderr)) {
    reflectionRegressionFailures.push(
      `${name} hidden-label lifecycle did not report least-confidence: ${lifecycle.stderr}`,
    );
  }
}
const hangingParagraphHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => `paragraph text
    hanging continuation
<custom-element>
${body}`,
);
if (hangingParagraphHandoff.status !== 0) {
  reflectionRegressionFailures.push(
    `paragraph hanging-indent handoff expected exit=0, actual=${hangingParagraphHandoff.status}: ${hangingParagraphHandoff.stderr}`,
  );
}
if (hangingParagraphHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'paragraph hanging-indent handoff retained the active task state file',
  );
}
const noErrorDetectedHandoff = runIsolatedHandoff('No error detected');
if (noErrorDetectedHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `negative-detection handoff expected exit=1, actual=${noErrorDetectedHandoff.status}`,
  );
}
if (!noErrorDetectedHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'negative-detection handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(noErrorDetectedHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `negative-detection handoff did not report least-confidence: ${noErrorDetectedHandoff.stderr}`,
  );
}
const multilineLabelHiddenHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => body.replace(
    'least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
    `
[
least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment
]: /least`,
  ),
);
if (multilineLabelHiddenHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `multiline-label hidden handoff expected exit=1, actual=${multilineLabelHiddenHandoff.status}`,
  );
}
if (!multilineLabelHiddenHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'multiline-label hidden handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(multilineLabelHiddenHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `multiline-label hidden handoff did not report least-confidence: ${multilineLabelHiddenHandoff.stderr}`,
  );
}
const tabListFenceVisibleHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => body.replace(
    'least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
    `-\t\`\`\`md
 least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment
    \`\`\``,
  ),
);
if (tabListFenceVisibleHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `tab-list hanging-indent handoff expected exit=1, actual=${tabListFenceVisibleHandoff.status}: ` +
    tabListFenceVisibleHandoff.stderr,
  );
}
if (!tabListFenceVisibleHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'tab-list hanging-indent handoff deleted the active task state file',
  );
}
if (!/least-confidence/.test(tabListFenceVisibleHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `tab-list hanging-indent handoff missed least-confidence error: ` +
    tabListFenceVisibleHandoff.stderr,
  );
}
const tabListFenceHiddenHandoff = runIsolatedHandoff(
  'risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
  (body) => body.replace(
    'least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment',
    `-\t\`\`\`md
    least-confidence: risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment
    \`\`\``,
  ),
);
if (tabListFenceHiddenHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `tab-list hidden handoff expected exit=1, actual=${tabListFenceHiddenHandoff.status}`,
  );
}
if (!tabListFenceHiddenHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'tab-list hidden handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(tabListFenceHiddenHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `tab-list hidden handoff did not report least-confidence: ${tabListFenceHiddenHandoff.stderr}`,
  );
}
const genericPronounHandoff = runIsolatedHandoff('它可能失败');
if (genericPronounHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `generic-pronoun handoff expected exit=1, actual=${genericPronounHandoff.status}`,
  );
}
if (!genericPronounHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'generic-pronoun handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(genericPronounHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `generic-pronoun handoff did not report least-confidence: ${genericPronounHandoff.stderr}`,
  );
}
const genericContentHandoff = runIsolatedHandoff('系统可能失败');
if (genericContentHandoff.status !== 1) {
  reflectionRegressionFailures.push(
    `generic-content handoff expected exit=1, actual=${genericContentHandoff.status}`,
  );
}
if (!genericContentHandoff.stateExists) {
  reflectionRegressionFailures.push(
    'generic-content handoff removed the active task state file',
  );
}
if (!/least-confidence/.test(genericContentHandoff.stderr)) {
  reflectionRegressionFailures.push(
    `generic-content handoff did not report least-confidence: ${genericContentHandoff.stderr}`,
  );
}
const validHandoff = runIsolatedHandoff('risk-v1; anchor=name:production timeout behavior; uncertainty=unmeasured:target environment');
if (validHandoff.status !== 0) {
  reflectionRegressionFailures.push(
    `valid handoff end-to-end expected exit=0, actual=${validHandoff.status}: ${validHandoff.stderr}`,
  );
}
if (validHandoff.stateExists) {
  reflectionRegressionFailures.push('valid handoff end-to-end retained the active task state file');
}
if (!/Local task state cleared/.test(validHandoff.stdout)) {
  reflectionRegressionFailures.push(
    `valid handoff end-to-end did not report state cleanup: ${validHandoff.stdout}`,
  );
}

assert.deepEqual(
  reflectionRegressionFailures,
  [],
  'reflection adversarial corpus, duplicate canonicalization, and state preservation must hold',
);

console.log('claude-task selftest: PASS');
