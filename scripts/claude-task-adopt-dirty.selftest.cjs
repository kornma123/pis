'use strict';

// 独立自测：`start --adopt-dirty`（Issue #93 治理状态机）。
// - 单元：parseFlags 布尔开关、单一 ownership parser（无字符串前缀误判）、adopted 基线 drift 分类；
// - 真实 claude-task.cjs 生命周期：独立临时 worktree 复现「脏树 + 无 state 死锁」（无 flag），
//   adopt + foreign/excluded 拒绝、start-r0 / handoff 冻结方向、crafted state + 真实 audit hook drift、
//   start-r0 / finish-r0 回归；
// - COREONE_LIVE_SELFTEST=1 时追加真实 start 全生命周期（fetch/GitHub/preflight）。
// 失败路径无需网络/GitHub；平台相关（Windows 无 symlink 特权）场景不在此文件内。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  findDriftViolations,
  findScopeViolations,
  matchesAny,
  parseFlags,
} = require('./claude-task.cjs');

const repositoryRoot = path.resolve(__dirname, '..');

// --- 单元：布尔 flag 解析（单一 parseFlags，不新造解析器） ---
assert.deepEqual(parseFlags(['--issue=12', '--owned=src/**', '--dry-run']), {
  owned: ['src/**'],
  excluded: [],
  dryRun: true,
  adoptDirty: false,
  issue: '12',
});
assert.equal(parseFlags(['--adopt-dirty']).adoptDirty, true);
assert.equal(parseFlags(['--adopt-dirty=true']).adoptDirty, true);
assert.equal(parseFlags(['--adopt-dirty=false']).adoptDirty, false);
assert.throws(() => parseFlags(['--adopt-dirty=maybe']), /只接受 true \/ false/);

// --- 单元：单一 ownership parser；路径不是字符串前缀，别名/规范化由 toPosix + 锚定 glob 统一处理 ---
assert.equal(matchesAny('docs', ['docs/**']), false);
assert.equal(matchesAny('docs2/a.md', ['docs/**']), false);
assert.equal(matchesAny('docs/a.md', ['docs']), false);
assert.equal(matchesAny('docs/a.md', ['docs/**']), true);
assert.equal(matchesAny('.\\docs\\a.md', ['docs/**']), true);
assert.equal(matchesAny('docs/private/a.md', ['docs/**', 'docs/private/**']), true);
assert.deepEqual(
  findScopeViolations(['docs/a.md', 'README.md'], { owned: ['docs/**'], excluded: ['docs/private/**'] }),
  ['README.md'],
);

// --- 单元：adopted 基线——合同前 adopted 路径与合同后新改动都受同一 owned/excluded 约束 ---
const adoptedScope = {
  owned: ['docs/**'],
  excluded: ['docs/private/**'],
  adoptedDirty: ['docs/adopt-owned.md'],
};
assert.deepEqual(findDriftViolations(['docs/adopt-owned.md'], adoptedScope), []);
assert.deepEqual(findDriftViolations(['docs/adopt-owned.md', 'docs/adopt-new.md'], adoptedScope), []);
assert.deepEqual(findDriftViolations(['docs/adopt-owned.md', 'README.md'], adoptedScope), ['README.md']);
assert.deepEqual(findDriftViolations(['docs/private/leak.md'], adoptedScope), ['docs/private/leak.md']);
assert.deepEqual(
  findDriftViolations(['docs/adopt-owned.md', 'docs/private/leak.md'], adoptedScope),
  ['docs/private/leak.md'],
);
assert.deepEqual(
  findDriftViolations(['README.md'], { ...adoptedScope, adoptedDirty: ['README.md'] }),
  ['README.md'],
  'tampered adopted baseline must not bless a foreign path',
);
assert.deepEqual(
  findDriftViolations(['docs/a.md'], { owned: ['docs/**'], excluded: [], adoptedDirty: [] }),
  [],
);
assert.deepEqual(
  findDriftViolations(['README.md'], { owned: ['docs/**'], excluded: [] }),
  ['README.md'],
  'legacy state without adoptedDirty keeps the pre-adoption scope check',
);
assert.deepEqual(
  findDriftViolations(['docs/.git/config'], { owned: ['docs/**'], excluded: [], adoptedDirty: [] }),
  ['docs/.git/config'],
  'drift check must reject Git metadata at any path depth regardless of owned glob',
);

// --- 真实生命周期 helpers（临时 worktree 与真实 CLI/hook 子进程） ---
function adoptSelftestStateFile(root) {
  const gitDir = spawnSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' });
  if (gitDir.status !== 0) throw new Error(`cannot resolve git dir: ${gitDir.stderr}`);
  return path.join(String(gitDir.stdout).trim(), 'coreone', 'claude-task-state.json');
}

function createAdoptSelftestWorktree(baseRef = 'HEAD') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-adopt-selftest-'));
  const branch = `claude-task-adopt-selftest-${process.pid}-${Date.now()}`;
  const result = spawnSync('git', ['worktree', 'add', '-b', branch, directory, baseRef], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`cannot create adopt selftest worktree: ${result.stderr || result.stdout}`);
  }
  return { directory, branch };
}

function removeAdoptSelftestWorktree(entry) {
  if (!entry) return;
  for (const args of [
    ['worktree', 'remove', '--force', entry.directory],
    ['branch', '-D', entry.branch],
  ]) {
    spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  }
  fs.rmSync(entry.directory, { recursive: true, force: true });
}

function runAdoptCli(directory, args) {
  return spawnSync(process.execPath, [path.join(__dirname, 'claude-task.cjs'), ...args], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function runAdoptAudit(directory) {
  return spawnSync(process.execPath, [path.join(__dirname, 'claude-task.cjs'), 'audit'], {
    input: JSON.stringify({ cwd: directory }),
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

function adoptWorktreeStatus(entry) {
  const result = spawnSync('git', ['-C', entry.directory, 'status', '--short'], { encoding: 'utf8' });
  return String(result.stdout || '').trim();
}

// --- 真实生命周期：脏树 + 无 state 死锁复现与 adopt 门（独立临时 worktree，失败路径无网络） ---
// start-r0 会把 origin/master 记为 baseSha，因此生命周期 worktree 优先从 origin/master 建立
// （inspectTaskState 要求 baseSha 是 HEAD 祖先）；origin/master 不可用时回退 HEAD。
const hasOriginMaster = spawnSync('git', ['rev-parse', '--verify', 'origin/master'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).status === 0;
const lifecycleBaseRef = hasOriginMaster ? 'origin/master' : 'HEAD';
const adoptWorktree = createAdoptSelftestWorktree(lifecycleBaseRef);
try {
  const dirtyOwned = 'docs/adopt-selftest-owned.md';
  const dirtyOwnedPath = path.join(adoptWorktree.directory, ...dirtyOwned.split('/'));
  fs.mkdirSync(path.dirname(dirtyOwnedPath), { recursive: true });
  fs.writeFileSync(dirtyOwnedPath, '# pre-contract dirty\n');

  const startArgs = [
    'start',
    '--issue=93',
    '--stage=prd',
    '--owner=Codex',
    '--risk=R0',
    `--owned=${dirtyOwned}`,
  ];

  // 1) 无 flag：脏树 + 无 state 死锁在真实 start 生命周期中 fail-closed。
  const noFlag = runAdoptCli(adoptWorktree.directory, startArgs);
  assert.notEqual(noFlag.status, 0, `no-flag dirty start must fail; stdout=${noFlag.stdout} stderr=${noFlag.stderr}`);
  assert.match(noFlag.stderr, /工作树必须 clean/);
  assert.equal(
    fs.existsSync(adoptSelftestStateFile(adoptWorktree.directory)),
    false,
    'failed start must not leave state',
  );

  // 2) --adopt-dirty + foreign 路径：建立合同前拒绝。
  const foreignPath = path.join(adoptWorktree.directory, 'foreign-drift.txt');
  fs.writeFileSync(foreignPath, '# foreign dirty\n');
  const foreign = runAdoptCli(adoptWorktree.directory, [...startArgs, '--adopt-dirty']);
  assert.notEqual(foreign.status, 0, `foreign adopt must fail; stdout=${foreign.stdout} stderr=${foreign.stderr}`);
  assert.match(foreign.stderr, /--adopt-dirty 拒绝/);
  assert.match(foreign.stderr, /foreign-drift\.txt/);
  fs.rmSync(foreignPath);
  assert.equal(fs.existsSync(adoptSelftestStateFile(adoptWorktree.directory)), false);

  // 3) --adopt-dirty + excluded 路径：同样 fail-closed。
  const excluded = runAdoptCli(adoptWorktree.directory, [
    ...startArgs,
    '--adopt-dirty',
    `--excluded=${dirtyOwned}`,
  ]);
  assert.notEqual(excluded.status, 0, `excluded adopt must fail; stdout=${excluded.stdout} stderr=${excluded.stderr}`);
  assert.match(excluded.stderr, /--adopt-dirty 拒绝/);
  assert.match(excluded.stderr, /adopt-selftest-owned\.md/);
  assert.equal(fs.existsSync(adoptSelftestStateFile(adoptWorktree.directory)), false);

  // 4) 冻结方向：start-r0 不接受 --adopt-dirty。
  const r0Reject = runAdoptCli(adoptWorktree.directory, [
    'start-r0',
    '--reason=selftest rejects adopt-dirty on r0',
    `--owned=${dirtyOwned}`,
    '--adopt-dirty',
  ]);
  assert.notEqual(r0Reject.status, 0, `start-r0 must reject --adopt-dirty; stdout=${r0Reject.stdout} stderr=${r0Reject.stderr}`);
  assert.match(r0Reject.stderr, /start-r0 不支持 --adopt-dirty/);

  // 5) 冻结方向：handoff 不接受 --keep-state。
  const keepState = runAdoptCli(adoptWorktree.directory, ['handoff', '--status=blocked', '--keep-state=true']);
  assert.notEqual(keepState.status, 0, `handoff must reject --keep-state; stdout=${keepState.stdout} stderr=${keepState.stderr}`);
  assert.match(keepState.stderr, /--keep-state/);
  fs.rmSync(dirtyOwnedPath);

  // 6) 真实 audit hook + 完整合法 governed state：adopted 基线区分合同前 dirty 与合同后 drift。
  const head = spawnSync(
    'git',
    ['-C', adoptWorktree.directory, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' },
  ).stdout.trim();
  const craftedState = {
    version: 2,
    mode: 'governed',
    issue: 93,
    issueUrl: 'https://github.com/kornma123/pis/issues/93',
    issueTitle: 'selftest fixture',
    issueBodyHash: 'a'.repeat(64),
    issuePriority: 'P3',
    issueReleaseImpact: '非阻断上线',
    stage: 'prd',
    owner: 'Codex',
    risk: 'R0',
    branch: adoptWorktree.branch,
    baseSha: head,
    startedHead: head,
    startedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    owned: ['docs/**'],
    excluded: ['docs/private/**'],
    adoptedDirty: ['docs/adopt-owned.md', 'docs/golden-registry.md'],
  };
  const statePath = adoptSelftestStateFile(adoptWorktree.directory);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(craftedState, null, 2)}\n`, 'utf8');

  const adoptedFile = path.join(adoptWorktree.directory, 'docs', 'adopt-owned.md');
  fs.writeFileSync(adoptedFile, '# adopted baseline\n');
  const firstAudit = runAdoptAudit(adoptWorktree.directory);
  assert.equal(firstAudit.status, 0, `adopted owned dirty path must stay in scope; ${firstAudit.stderr}`);

  const goldenFile = path.join(adoptWorktree.directory, 'docs', 'golden-registry.md');
  fs.appendFileSync(goldenFile, '\n<!-- adopt selftest touch -->\n');
  const secondAudit = runAdoptAudit(adoptWorktree.directory);
  assert.equal(secondAudit.status, 0, `modified adopted tracked path must stay in scope; ${secondAudit.stderr}`);
  fs.rmSync(goldenFile);
  const thirdAudit = runAdoptAudit(adoptWorktree.directory);
  assert.equal(thirdAudit.status, 0, `deleting an adopted owned path stays in owned scope; ${thirdAudit.stderr}`);
  spawnSync('git', ['-C', adoptWorktree.directory, 'restore', 'docs/golden-registry.md'], { encoding: 'utf8' });

  fs.writeFileSync(path.join(adoptWorktree.directory, 'foreign-drift.txt'), '# foreign drift\n');
  const foreignDrift = runAdoptAudit(adoptWorktree.directory);
  assert.equal(foreignDrift.status, 2, `post-adoption foreign drift must fail; ${foreignDrift.stderr}`);
  assert.match(foreignDrift.stderr, /越界 drift|范围外改动/);
  fs.rmSync(path.join(adoptWorktree.directory, 'foreign-drift.txt'));

  const privateDirectory = path.join(adoptWorktree.directory, 'docs', 'private');
  fs.mkdirSync(privateDirectory, { recursive: true });
  fs.writeFileSync(path.join(privateDirectory, 'leak.md'), '# excluded drift\n');
  const excludedDrift = runAdoptAudit(adoptWorktree.directory);
  assert.equal(excludedDrift.status, 2, `post-adoption excluded drift must fail; ${excludedDrift.stderr}`);
  assert.match(excludedDrift.stderr, /private\/leak\.md/);

  fs.renameSync(adoptedFile, path.join(privateDirectory, 'renamed.md'));
  const renamed = runAdoptAudit(adoptWorktree.directory);
  assert.equal(renamed.status, 2, `adopted rename into excluded must fail; ${renamed.stderr}`);
  assert.match(renamed.stderr, /private\/renamed\.md/);
  fs.rmSync(privateDirectory, { recursive: true, force: true });

  fs.writeFileSync(path.join(adoptWorktree.directory, 'docs', 'adopt-new.md'), '# new owned\n');
  assert.equal(runAdoptAudit(adoptWorktree.directory).status, 0, 'new owned changes remain allowed after adoption');
  fs.rmSync(path.join(adoptWorktree.directory, 'docs', 'adopt-new.md'));

  fs.writeFileSync(path.join(adoptWorktree.directory, 'foreign-drift.txt'), '# untracked foreign\n');
  const untracked = runAdoptAudit(adoptWorktree.directory);
  assert.equal(untracked.status, 2, `untracked foreign drift must fail; ${untracked.stderr}`);
  fs.rmSync(path.join(adoptWorktree.directory, 'foreign-drift.txt'));

  // 7) start-r0 / finish-r0 真实生命周期回归（无网络；baseSha 一致性要求 origin/master）。
  fs.rmSync(statePath);
  if (!hasOriginMaster) {
    process.stdout.write('start-r0 lifecycle: SKIPPED (origin/master unavailable locally)\n');
  } else {
  assert.equal(
    adoptWorktreeStatus(adoptWorktree),
    '',
    `worktree must be clean before start-r0: ${adoptWorktreeStatus(adoptWorktree)}`,
  );
  const r0 = runAdoptCli(adoptWorktree.directory, [
    'start-r0',
    '--reason=selftest regression for r0 lifecycle',
    '--owned=docs/**',
  ]);
  assert.equal(r0.status, 0, r0.stderr);
  fs.writeFileSync(path.join(adoptWorktree.directory, 'docs', 'r0-owned.md'), '# r0\n');
  assert.equal(runAdoptAudit(adoptWorktree.directory).status, 0, 'r0 owned change must pass audit');
  fs.writeFileSync(path.join(adoptWorktree.directory, 'foreign-r0.txt'), '# r0 foreign\n');
  assert.equal(runAdoptAudit(adoptWorktree.directory).status, 2, 'r0 foreign change must fail audit');
  fs.rmSync(path.join(adoptWorktree.directory, 'foreign-r0.txt'));
  const finishR0 = runAdoptCli(adoptWorktree.directory, [
    'finish-r0',
    '--evidence=real r0 lifecycle exercised in selftest worktree',
  ]);
  assert.equal(finishR0.status, 0, finishR0.stderr);
  assert.equal(fs.existsSync(statePath), false, 'finish-r0 must remove state');
  }
} finally {
  removeAdoptSelftestWorktree(adoptWorktree);
}

// 真实 start 全生命周期（含 fetch/GitHub/preflight）：显式 COREONE_LIVE_SELFTEST=1 时启用。
if (process.env.COREONE_LIVE_SELFTEST === '1') {
  const listed = spawnSync(
    'gh',
    ['issue', 'list', '--repo', 'kornma123/pis', '--state', 'open', '--limit', '100', '--json', 'number,body,labels'],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 },
  );
  assert.equal(listed.status, 0, `live issue discovery failed: ${listed.stderr}`);
  const liveIssue = JSON.parse(listed.stdout).find((item) => {
    const block = String(item.body || '').match(
      /<!--\s*coreone-owner:start\s*-->([\s\S]*?)<!--\s*coreone-owner:end\s*-->/i,
    );
    if (!block) return false;
    const owner = block[1].match(/-\s*\*\*current owner\*\*\s*[:：]\s*(.+)/i)?.[1]?.trim();
    const names = new Set((item.labels || []).map((label) => label.name));
    const priority = [...names].find((name) => /^P[0-3]$/.test(name));
    return Boolean(
      owner &&
      !/^(?:unassigned|none)$/i.test(owner) &&
      priority &&
      (names.has('阻断上线') || names.has('非阻断上线')),
    );
  });
  assert.ok(liveIssue, 'no OPEN issue with owner + rating labels available for live start');
  const liveOwner = liveIssue.body.match(
    /<!--\s*coreone-owner:start\s*-->([\s\S]*?)<!--\s*coreone-owner:end\s*-->/i,
  )[1].match(/-\s*\*\*current owner\*\*\s*[:：]\s*(.+)/i)[1].trim();

  const fetched = spawnSync('git', ['fetch', 'origin', '--prune'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(fetched.status, 0, `live fetch failed: ${fetched.stderr}`);
  const liveWorktree = createAdoptSelftestWorktree('origin/master');
  try {
    const liveDirty = 'docs/adopt-live-owned.md';
    fs.mkdirSync(path.dirname(path.join(liveWorktree.directory, ...liveDirty.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(liveWorktree.directory, ...liveDirty.split('/')), '# live dirty\n');
    const liveArgs = [
      'start',
      `--issue=${liveIssue.number}`,
      '--stage=prd',
      `--owner=${liveOwner}`,
      '--risk=R0',
      `--owned=${liveDirty}`,
    ];

    const liveNoFlag = runAdoptCli(liveWorktree.directory, liveArgs);
    assert.notEqual(
      liveNoFlag.status,
      0,
      `live no-flag dirty start must fail; stdout=${liveNoFlag.stdout} stderr=${liveNoFlag.stderr}`,
    );
    assert.match(liveNoFlag.stderr, /工作树必须 clean/);

    const liveAdopt = runAdoptCli(liveWorktree.directory, [...liveArgs, '--adopt-dirty']);
    if (liveAdopt.status === 0) {
      const liveState = JSON.parse(fs.readFileSync(adoptSelftestStateFile(liveWorktree.directory), 'utf8'));
      assert.deepEqual(liveState.adoptedDirty, [liveDirty]);

      fs.writeFileSync(path.join(liveWorktree.directory, 'foreign-live.txt'), '# live foreign\n');
      const liveDrift = runAdoptAudit(liveWorktree.directory);
      assert.equal(liveDrift.status, 2, `live post-adoption drift must fail; ${liveDrift.stderr}`);
      fs.rmSync(path.join(liveWorktree.directory, 'foreign-live.txt'));

      const liveStatePath = adoptSelftestStateFile(liveWorktree.directory);
      fs.rmSync(liveStatePath);
      fs.mkdirSync(liveStatePath);
      const writeFail = runAdoptCli(liveWorktree.directory, [...liveArgs, '--adopt-dirty']);
      assert.notEqual(
        writeFail.status,
        0,
        `adopt start with blocked state path must fail; stdout=${writeFail.stdout} stderr=${writeFail.stderr}`,
      );
      assert.match(writeFail.stderr, /EISDIR|ENOTDIR|物理目录/);
      fs.rmSync(liveStatePath, { recursive: true, force: true });
      const recovered = runAdoptCli(liveWorktree.directory, [...liveArgs, '--adopt-dirty']);
      assert.equal(recovered.status, 0, `recovery adopt start must pass; stdout=${recovered.stdout} stderr=${recovered.stderr}`);
    } else {
      const blocked = `${liveAdopt.stderr}${liveAdopt.stdout}`;
      assert.match(
        blocked,
        /EPERM[\s\S]*symlink|symlink[\s\S]*EPERM/,
        `unexpected live adopt failure: ${blocked}`,
      );
      process.stdout.write(
        `LIVE adopt+all-owned: ENV-BLOCKED at later start stage (${String(blocked).split('\n')[0]})\n`,
      );
    }
  } finally {
    removeAdoptSelftestWorktree(liveWorktree);
  }
}

console.log('claude-task adopt-dirty selftest: PASS');
