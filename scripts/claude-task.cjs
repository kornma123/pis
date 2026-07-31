'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  collectVisibleFields,
  isWeakReflection,
  stripIgnoredMarkdown,
} = require('./issue-handoff/check-pr-body.cjs');

const MODIFY_STAGES = new Set(['prd', 'mockup', 'implementation', 'acceptance']);
const HANDOFF_STATUSES = new Set([
  'in-progress',
  'blocked',
  'ready-for-review',
  'waiting-pm',
  'waiting-acceptance',
  'accepted',
]);
const STATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const LIVE_RECHECK_MS = 10 * 60 * 1000;
const TASK_STATE_CLOCK_SKEW_MS = 120_000;
const TASK_STATE_VERSION = 2;
const GITHUB_WRITE_INTERVAL_MS = 1_000;
const LOCAL_LOCK_STALE_MS = 20 * 60 * 1_000;
const ISSUE_CREATION_MANIFEST_VERSION = 1;
const MAX_ISSUES_PER_CREATION = 5;
const ISSUE_CREATION_RECOVERY_CLOCK_SKEW_MS = 120_000;
const ISSUE_CREATION_RECOVERY_REMOTE_WINDOW_MS = 180_000;
const ISSUE_PRIORITY_LABELS = new Set(['P0', 'P1', 'P2', 'P3']);
const ISSUE_RELEASE_LABELS = new Set(['阻断上线', '非阻断上线']);
const HANDOFF_CONTINUATION_BOUNDARY_KEYS = new Set([
  'result',
  'evidence',
  'risk',
  'next-owner',
  'trigger',
  'least-confidence',
  'biggest-missing',
]);

function validateIssueImplementationLabels(labels) {
  const names = (Array.isArray(labels) ? labels : [])
    .map((label) => typeof label === 'string' ? label : label?.name)
    .filter((name) => typeof name === 'string');
  const priorities = names.filter((name) => ISSUE_PRIORITY_LABELS.has(name));
  const releaseImpacts = names.filter((name) => ISSUE_RELEASE_LABELS.has(name));
  const errors = [];

  if (priorities.length === 0 && releaseImpacts.length === 0) {
    errors.push(
      '缺少 Codex 正式评级：优先级标签须恰好一个 P0/P1/P2/P3，' +
      '上线影响标签须恰好一个 阻断上线/非阻断上线。',
    );
  } else {
    if (priorities.length !== 1) {
      errors.push(`优先级标签必须恰好一个（当前 ${priorities.length} 个）。`);
    }
    if (releaseImpacts.length !== 1) {
      errors.push(`上线影响标签必须恰好一个（当前 ${releaseImpacts.length} 个）。`);
    }
  }

  const priority = priorities.length === 1 ? priorities[0] : null;
  const releaseImpact = releaseImpacts.length === 1 ? releaseImpacts[0] : null;
  if (priority === 'P0' && releaseImpact === '非阻断上线') {
    errors.push('P0 + 非阻断上线 默认非法；请修正评级或在 Issue 留下升降级证据后重评。');
  }
  if (priority === 'P3' && releaseImpact === '阻断上线') {
    errors.push('P3 + 阻断上线 默认非法；请修正评级或在 Issue 留下升降级证据后重评。');
  }

  return {
    ok: errors.length === 0,
    errors,
    priority,
    releaseImpact,
  };
}

function assertIssueImplementationLabels(labels, issueNumber) {
  const result = validateIssueImplementationLabels(labels);
  if (!result.ok) {
    throw new Error(
      `Issue #${issueNumber} 尚未达到实现准入标签合同：${result.errors.join(' ')}` +
      ' question-only 需求讨论票可以暂存，但须经 Codex 去重/事实/范围/AC 复核和正式评级后才能 start。',
    );
  }
  return result;
}

function parseIssueRatingMarker(body) {
  const visibleBody = stripIgnoredMarkdown(String(body || ''));
  const matches = [...visibleBody.matchAll(
    /^\[ISSUE-RATING\]\s+owner=Codex\s+previous=(P[0-3]|UNRECORDED)\/(阻断上线|非阻断上线|UNRECORDED)\s+current=(P[0-3])\/(阻断上线|非阻断上线)\s+reason=(\S.*)\s*$/gm,
  )];
  if (matches.length !== 1) {
    throw new Error(
      '评级证据评论必须且只能包含一条 ' +
      '[ISSUE-RATING] owner=Codex previous=<P?/上线影响|UNRECORDED/UNRECORDED> ' +
      'current=<P?/上线影响> reason=<具体理由>。',
    );
  }
  const [, previousPriority, previousReleaseImpact, currentPriority, currentReleaseImpact, rawReason] =
    matches[0];
  if (
    (previousPriority === 'UNRECORDED') !==
    (previousReleaseImpact === 'UNRECORDED')
  ) {
    throw new Error('评级证据的 previous 必须是完整双轴，或精确写 UNRECORDED/UNRECORDED。');
  }
  if (previousPriority !== 'UNRECORDED') {
    const previous = validateIssueImplementationLabels([
      previousPriority,
      previousReleaseImpact,
    ]);
    if (!previous.ok) {
      throw new Error(`评级证据的 previous 双轴非法：${previous.errors.join(' ')}`);
    }
  }
  const current = validateIssueImplementationLabels([
    currentPriority,
    currentReleaseImpact,
  ]);
  if (!current.ok) {
    throw new Error(`评级证据的 current 双轴非法：${current.errors.join(' ')}`);
  }
  const reason = rawReason.trim();
  if (
    reason.length < 8 ||
    /^(?:todo|tbd|n\/?a|none|无|待补|调整|重评|变化|\.\.\.)$/i.test(reason)
  ) {
    throw new Error('评级证据的 reason 必须说明升降级或旧 state 迁移依据，不能使用占位词。');
  }
  return {
    previousPriority,
    previousReleaseImpact,
    currentPriority,
    currentReleaseImpact,
    reason,
  };
}

function ownershipScopeDigest(owned) {
  return sha256(
    [...new Set((Array.isArray(owned) ? owned : []).map(toPosix))]
      .sort()
      .join('\n'),
  );
}

function inspectClaudeImplementationOwnership(stage, owned) {
  const normalizedStage = String(stage || '').toLowerCase();
  if (!['implementation', 'acceptance'].includes(normalizedStage)) {
    return { requiresException: false, reason: null };
  }
  const patterns = (Array.isArray(owned) ? owned : []).map(toPosix);
  const hasFrontend = patterns.some((pattern) =>
    pattern === '前端代码' || pattern.startsWith('前端代码/'));
  const hasBackend = patterns.some((pattern) =>
    pattern === '后端代码' || pattern.startsWith('后端代码/'));
  const hasBroad = patterns.some((pattern) =>
    !pattern ||
    ['.', '*', '**', '**/*', '*/**'].includes(pattern) ||
    pattern.startsWith('../') ||
    pattern.startsWith('/'));
  if (hasBackend) {
    return {
      requiresException: true,
      reason: hasFrontend ? '前后端混合实现范围' : '后端实现范围',
    };
  }
  if (hasBroad) {
    return { requiresException: true, reason: '全仓或不可判定的宽范围' };
  }
  if (!hasFrontend) {
    return {
      requiresException: true,
      reason: '未包含可判定的前端实现范围',
    };
  }
  return { requiresException: false, reason: null };
}

function assertClaudeImplementationOwnership(stage, owned, exception = null) {
  const inspection = inspectClaudeImplementationOwnership(stage, owned);
  if (!inspection.requiresException) {
    if (exception) {
      throw new Error('前端实现范围不需要所有权例外；请移除 --ownership-exception。');
    }
    return inspection;
  }
  if (exception?.verified === true) return inspection;
  throw new Error(
    `Claude Code 不得直接认领${inspection.reason}；后端实现 owner=Codex。` +
    '无法拆分的在途混合/例外任务必须提供绑定活动 Issue 与 owned scope 的 PM ownership exception。',
  );
}

function parseOwnershipExceptionMarker(body) {
  const visibleBody = stripIgnoredMarkdown(String(body || ''));
  const matches = [...visibleBody.matchAll(
    /^\[PM-OWNERSHIP-EXCEPTION\]\s+decision=approved\s+owner=Claude-Code\s+issue=(\d+)\s+scope-sha256=([0-9a-f]{64})\s+reason=(\S.*)\s*$/gm,
  )];
  if (matches.length !== 1) {
    throw new Error(
      '所有权例外证据必须且只能包含一条可见的 ' +
      '[PM-OWNERSHIP-EXCEPTION] decision=approved owner=Claude-Code ' +
      'issue=<N> scope-sha256=<64hex> reason=<具体理由>。',
    );
  }
  const issue = Number(matches[0][1]);
  const reason = matches[0][3].trim();
  if (reason.length < 8 || /^(?:todo|tbd|none|无|例外|同意)$/i.test(reason)) {
    throw new Error('所有权例外 reason 必须说明为何不能拆分以及 reviewer 安排。');
  }
  return { issue, scopeSha256: matches[0][2], reason };
}

function parseIssueCreationApprovalMarker(body) {
  const visibleBody = stripIgnoredMarkdown(String(body || ''));
  const matches = [...visibleBody.matchAll(
    /^\[PM-ISSUE-CREATION\]\s+decision=approved\s+manifest-sha256=([0-9a-f]{64})\s+count=([1-5])\s*$/gm,
  )];
  if (matches.length !== 1) {
    throw new Error(
      'Issue 创建授权必须且只能包含一条可见的 ' +
      '[PM-ISSUE-CREATION] decision=approved manifest-sha256=<64hex> count=<1..5>。',
    );
  }
  return { sha256: matches[0][1], count: Number(matches[0][2]) };
}

function validateIssueCreationManifest(raw) {
  const source = String(raw || '');
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error('Issue candidate manifest 必须是有效 JSON。');
  }
  if (
    !manifest ||
    Array.isArray(manifest) ||
    manifest.version !== ISSUE_CREATION_MANIFEST_VERSION ||
    !Array.isArray(manifest.issues) ||
    manifest.issues.length < 1 ||
    manifest.issues.length > MAX_ISSUES_PER_CREATION
  ) {
    throw new Error(
      `Issue candidate manifest 必须是 version=${ISSUE_CREATION_MANIFEST_VERSION}，` +
      `并包含 1..${MAX_ISSUES_PER_CREATION} 个 issues。`,
    );
  }
  const seenTitles = new Set();
  const issues = manifest.issues.map((item, index) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') {
      throw new Error(`Issue candidate #${index + 1} 必须是对象。`);
    }
    const keys = Object.keys(item).sort();
    if (keys.join(',') !== 'body,title') {
      throw new Error(`Issue candidate #${index + 1} 只允许 title/body；评级标签由 Codex 后续写入。`);
    }
    if (typeof item.title !== 'string' || typeof item.body !== 'string') {
      throw new Error(`Issue candidate #${index + 1} title/body 必须是字符串。`);
    }
    const title = item.title;
    const body = item.body;
    if (
      title !== title.trim() ||
      body !== body.trim() ||
      title.includes('\0') ||
      title.includes('\n') ||
      title.includes('\r') ||
      body.includes('\0') ||
      body.includes('\r')
    ) {
      throw new Error(
        `Issue candidate #${index + 1} title/body 必须已是最终 canonical bytes：` +
        '标题必须单行，正文只用 LF；禁止首尾空白、CR/CRLF 或 NUL；' +
        '不得在授权后静默 trim/换行规范化。',
      );
    }
    if (Buffer.byteLength(title, 'utf8') < 12 || Buffer.byteLength(title, 'utf8') > 240) {
      throw new Error(`Issue candidate #${index + 1} title 必须为 12..240 UTF-8 bytes。`);
    }
    if (Buffer.byteLength(body, 'utf8') < 40 || Buffer.byteLength(body, 'utf8') > 60_000) {
      throw new Error(`Issue candidate #${index + 1} body 必须为 40..60000 UTF-8 bytes。`);
    }
    if (seenTitles.has(title)) throw new Error(`Issue candidate title 重复：${title}`);
    seenTitles.add(title);
    return { title, body };
  });
  return { version: manifest.version, issues, sha256: sha256(source) };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: options.timeout || 30_000,
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const detail = result.error?.message || stderr || stdout || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return { status: result.status, stdout, stderr, error: result.error };
}

function githubWriteControlDirectory(root) {
  return path.join(physicalGitDirectory(root, { common: true }), 'coreone');
}

function waitMilliseconds(milliseconds) {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function isLocalProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function acquireExclusiveLocalLock(lockFile, label, timeoutMs = 30_000) {
  ensurePrivateDirectory(path.dirname(lockFile));
  const deadline = Date.now() + timeoutMs;
  let descriptor = null;
  while (descriptor === null) {
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new Error(`${label}不可用；停止写入。`);
      }
      let existing = null;
      try {
        existing = loadJsonFile(lockFile);
      } catch (loadError) {
        if (loadError.code === 'COREONE_UNSAFE_PRIVATE_PATH') throw loadError;
        // The lock owner may have created the inode but not finished writing
        // its metadata yet. Treat that short window as live and keep waiting.
      }
      const acquiredAtMs = Number(existing?.acquiredAtMs || 0);
      if (
        acquiredAtMs > 0 &&
        (
          !isLocalProcessAlive(Number(existing?.pid)) ||
          Date.now() - acquiredAtMs >= LOCAL_LOCK_STALE_MS
        )
      ) {
        try {
          fs.unlinkSync(lockFile);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') {
            throw new Error(`${label}陈旧锁无法安全回收；停止写入。`);
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`${label}正在被另一事务占用；停止写入。`);
      }
      waitMilliseconds(50);
    }
  }
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({
      pid: process.pid,
      acquiredAtMs: Date.now(),
      acquiredAt: new Date().toISOString(),
    })}\n`, 'utf8');
  } catch {
    fs.closeSync(descriptor);
    try {
      fs.unlinkSync(lockFile);
    } catch {
      // The original initialization error remains the authoritative failure.
    }
    throw new Error(`${label}无法初始化；停止写入。`);
  }
  const identity = fs.fstatSync(descriptor);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.closeSync(descriptor);
    try {
      const current = fs.statSync(lockFile);
      if (current.dev === identity.dev && current.ino === identity.ino) {
        fs.unlinkSync(lockFile);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

function acquireGitHubWriteSlot(root) {
  const directory = githubWriteControlDirectory(root);
  const lockFile = path.join(directory, 'github-write.lock');
  const statePath = path.join(directory, 'github-write-state.json');
  const release = acquireExclusiveLocalLock(lockFile, 'GitHub writer 串行锁');
  try {
    const previous = loadJsonFile(statePath);
    const lastGrantedAtMs = Number(previous?.lastGrantedAtMs || 0);
    waitMilliseconds(Math.max(0, GITHUB_WRITE_INTERVAL_MS - (Date.now() - lastGrantedAtMs)));
    const grantedAtMs = Date.now();
    writePrivateJson(statePath, {
      lastGrantedAtMs: grantedAtMs,
      lastGrantedAt: new Date(grantedAtMs).toISOString(),
      pid: process.pid,
    });
  } finally {
    release();
  }
}

function runOfflineGithubGovernance(root) {
  return run(
    process.execPath,
    [path.join(root, 'scripts', 'offline-github-governance.cjs')],
    { cwd: root, timeout: 120_000 },
  );
}

function runSerializedRemoteWrite(root, command, args, options = {}) {
  const controlDirectory = githubWriteControlDirectory(root);
  ensurePrivateDirectory(controlDirectory);
  const executionLock = path.join(controlDirectory, 'github-write-execution.lock');
  const release = acquireExclusiveLocalLock(
    executionLock,
    'GitHub writer 执行锁',
  );
  try {
    runOfflineGithubGovernance(root);
    acquireGitHubWriteSlot(root);
    if (typeof options.beforeWrite === 'function') options.beforeWrite();
    return run(command, args, {
      cwd: root,
      timeout: options.timeout || 30_000,
    });
  } finally {
    release();
  }
}

function runGitHubWrite(root, args, options = {}) {
  return runSerializedRemoteWrite(root, 'gh', args, options);
}

function git(args, cwd, options = {}) {
  return run('git', args, { ...options, cwd });
}

function repoRoot(cwd = process.cwd()) {
  return fs.realpathSync.native(
    path.resolve(git(['rev-parse', '--show-toplevel'], cwd).stdout),
  );
}

function physicalGitDirectory(root, options = {}) {
  const args = options.common
    ? ['rev-parse', '--path-format=absolute', '--git-common-dir']
    : ['rev-parse', '--absolute-git-dir'];
  const raw = git(args, root).stdout;
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  const physical = fs.realpathSync.native(absolute);
  const stat = fs.lstatSync(physical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Git metadata 根目录不是可信的物理目录。');
  }
  return physical;
}

function stateFile(root) {
  // Never ask `git rev-parse --git-path` for the final state path: Git follows
  // a malicious terminal symlink before returning it. Anchor the fixed name
  // under the physical per-worktree gitdir instead.
  return path.join(
    physicalGitDirectory(root),
    'coreone',
    'claude-task-state.json',
  );
}

function unsafePrivatePath(message) {
  const error = new Error(message);
  error.code = 'COREONE_UNSAFE_PRIVATE_PATH';
  return error;
}

function privateFileIdentity(file, options = {}) {
  const directory = path.dirname(file);
  let directoryStat;
  try {
    directoryStat = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT' && options.allowMissing) return null;
    throw error;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw unsafePrivatePath(`私有治理目录 ${directory} 必须是物理目录，拒绝 symlink。`);
  }
  if (fs.realpathSync.native(directory) !== path.resolve(directory)) {
    throw unsafePrivatePath(`私有治理目录 ${directory} 发生物理路径逃逸。`);
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT' && options.allowMissing) return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw unsafePrivatePath(
      `私有治理文件 ${file} 必须是 link-count=1 的普通文件；拒绝 symlink/hardlink。`,
    );
  }
  return { dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
}

function ensurePrivateDirectory(directory) {
  const parent = path.dirname(directory);
  const parentPhysical = fs.realpathSync.native(parent);
  const expected = path.join(parentPhysical, path.basename(directory));
  if (path.resolve(directory) !== path.resolve(expected)) {
    throw unsafePrivatePath(`私有治理目录 ${directory} 未锚定在物理 Git metadata 目录。`);
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw unsafePrivatePath(`私有治理目录 ${directory} 必须是物理目录，拒绝 symlink。`);
  }
  if (fs.realpathSync.native(directory) !== path.resolve(directory)) {
    throw unsafePrivatePath(`私有治理目录 ${directory} 发生物理路径逃逸。`);
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Some filesystems cannot narrow mode bits. Directory identity checks above
    // remain the authorization boundary.
  }
  return directory;
}

function readPrivateText(file) {
  const expected = privateFileIdentity(file, { allowMissing: true });
  if (!expected) return null;
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    ) {
      throw unsafePrivatePath(`私有治理文件 ${file} 在读取期间被替换。`);
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw unsafePrivatePath(`私有治理文件 ${file} 是 symlink。`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function loadJsonFile(file) {
  const text = readPrivateText(file);
  return text === null ? null : JSON.parse(text);
}

function taskStateShapeError(state) {
  if (!state || Array.isArray(state) || typeof state !== 'object') {
    return 'state root 必须是对象';
  }
  if (!Number.isInteger(state.version) || state.version < 1 || state.version > TASK_STATE_VERSION) {
    return `state version 必须在 1..${TASK_STATE_VERSION}`;
  }
  if (!['r0', 'governed'].includes(state.mode)) return 'state mode 非法';
  if (typeof state.branch !== 'string' || !state.branch.trim()) return 'state branch 缺失';
  if (!/^[0-9a-f]{40}$/i.test(String(state.baseSha || ''))) return 'state baseSha 非法';
  if (!/^[0-9a-f]{40}$/i.test(String(state.startedHead || ''))) return 'state startedHead 非法';
  if (!Array.isArray(state.owned) || state.owned.length === 0 ||
      state.owned.some((value) => typeof value !== 'string' || !value)) {
    return 'state owned scope 非法';
  }
  try {
    normalizeTaskOwnedScope(state.owned);
  } catch (error) {
    return error.message;
  }
  if (!Array.isArray(state.excluded) ||
      state.excluded.some((value) => typeof value !== 'string')) {
    return 'state excluded scope 非法';
  }
  if (
    state.adoptedDirty !== undefined &&
    (
      !Array.isArray(state.adoptedDirty) ||
      state.adoptedDirty.some((value) => typeof value !== 'string' || !value)
    )
  ) {
    return 'state adoptedDirty 非法';
  }
  for (const file of state.adoptedDirty || []) {
    if (hasGitMetadataPathSegment(file) || matchesAny(file, state.excluded) || !matchesAny(file, state.owned)) {
      return `state adoptedDirty 含越界路径：${file}`;
    }
  }
  if (!Number.isFinite(Date.parse(state.startedAt))) return 'state startedAt 非法';
  if (state.verifiedAt && !Number.isFinite(Date.parse(state.verifiedAt))) {
    return 'state verifiedAt 非法';
  }
  if (state.mode === 'r0') {
    if (state.stage !== 'r0' || state.risk !== 'R0') return 'R0 state 合同非法';
    if (
      typeof state.reason !== 'string' ||
      state.reason.trim() !== state.reason ||
      state.reason.length < 6
    ) {
      return 'R0 state reason 非法';
    }
    return null;
  }
  if (!Number.isInteger(state.issue) || state.issue <= 0) return 'governed state issue 非法';
  if (
    typeof state.issueUrl !== 'string' ||
    !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/[1-9]\d*$/i.test(state.issueUrl)
  ) {
    return 'governed state issueUrl 非法';
  }
  if (typeof state.issueTitle !== 'string' || !state.issueTitle.trim()) {
    return 'governed state issueTitle 缺失';
  }
  if (!MODIFY_STAGES.has(state.stage)) return 'governed state stage 非法';
  if (typeof state.owner !== 'string' || !state.owner.trim()) return 'governed state owner 缺失';
  if (!/^R[0-3]$/.test(String(state.risk || ''))) return 'governed state risk 非法';
  if (!/^[0-9a-f]{64}$/i.test(String(state.issueBodyHash || ''))) {
    return 'governed state issueBodyHash 非法';
  }
  if (state.version >= 2) {
    const rating = validateIssueImplementationLabels([
      state.issuePriority,
      state.issueReleaseImpact,
    ]);
    if (!rating.ok) return `governed state rating 非法：${rating.errors.join(' ')}`;
  }
  return null;
}

function inspectTaskState(root) {
  const file = stateFile(root);
  let state;
  try {
    const raw = readPrivateText(file);
    if (raw === null) return { kind: 'missing', file, state: null };
    state = JSON.parse(raw);
  } catch (error) {
    return { kind: 'malformed', file, state: null, detail: error.message };
  }
  const shapeError = taskStateShapeError(state);
  if (shapeError) return { kind: 'malformed', file, state, detail: shapeError };
  const now = Date.now();
  const startedAt = Date.parse(state.startedAt);
  const verifiedAt = Date.parse(state.verifiedAt || state.startedAt);
  if (
    startedAt > now + TASK_STATE_CLOCK_SKEW_MS ||
    verifiedAt > now + TASK_STATE_CLOCK_SKEW_MS ||
    verifiedAt < startedAt
  ) {
    return {
      kind: 'malformed',
      file,
      state,
      detail: 'state timestamp 顺序或未来时钟非法',
    };
  }
  const age = now - startedAt;
  if (age > STATE_MAX_AGE_MS) return { kind: 'expired', file, state };
  const branch = git(['branch', '--show-current'], root).stdout;
  if (branch !== state.branch) {
    return { kind: 'branch-mismatch', file, state, branch };
  }
  try {
    git(['cat-file', '-e', `${state.baseSha}^{commit}`], root);
    git(['cat-file', '-e', `${state.startedHead}^{commit}`], root);
    git(['merge-base', '--is-ancestor', state.startedHead, 'HEAD'], root);
    git(['merge-base', '--is-ancestor', state.baseSha, 'HEAD'], root);
  } catch (error) {
    return {
      kind: 'malformed',
      file,
      state,
      detail: `state Git baseline 非法：${error.message}`,
    };
  }
  return { kind: 'valid', file, state, branch };
}

function inactiveTaskStateMessage(snapshot) {
  if (snapshot.kind === 'missing') return 'no local task state';
  if (snapshot.kind === 'expired') {
    return 'task state expired (>12h) and is an inactive historical record';
  }
  if (snapshot.kind === 'branch-mismatch') {
    return `task state branch mismatch / branch 已变化 (${snapshot.state?.branch || '<missing>'} -> ` +
      `${snapshot.branch || 'DETACHED'}) and is an inactive historical record`;
  }
  return `task state is malformed (${snapshot.detail || 'invalid structure'}) and is an inactive historical record`;
}

function writePrivateJson(file, value) {
  const directory = ensurePrivateDirectory(path.dirname(file));
  const previous = privateFileIdentity(file, { allowMissing: true });
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    const current = privateFileIdentity(file, { allowMissing: true });
    if (
      (previous === null) !== (current === null) ||
      (
        previous &&
        (previous.dev !== current.dev || previous.ino !== current.ino)
      )
    ) {
      throw unsafePrivatePath(`私有治理文件 ${file} 在原子替换前被并发替换。`);
    }
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    privateFileIdentity(file);
    let directoryDescriptor;
    try {
      directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      // Windows cannot FlushFileBuffers a directory handle (EPERM)；
      // 文件级 fsync + 原子 rename 仍是持久化边界，目录 fsync 仅在非 win32 保留。
      if (process.platform !== 'win32') fs.fsyncSync(directoryDescriptor);
    } finally {
      if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function removePrivateFile(file) {
  const identity = privateFileIdentity(file, { allowMissing: true });
  if (!identity) return;
  const current = privateFileIdentity(file);
  if (identity.dev !== current.dev || identity.ino !== current.ino) {
    throw unsafePrivatePath(`私有治理文件 ${file} 在删除前被替换。`);
  }
  fs.unlinkSync(file);
}

function parseFlags(argv) {
  const flags = { owned: [], excluded: [], dryRun: false, adoptDirty: false };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (arg === '--adopt-dirty') {
      flags.adoptDirty = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    if (!match) throw new Error(`参数必须使用 --key=value：${arg}`);
    const [, key, value] = match;
    if (key === 'owned' || key === 'excluded') flags[key].push(value);
    else if (key === 'adopt-dirty') {
      if (value !== 'true' && value !== 'false') {
        throw new Error('--adopt-dirty 只接受 true / false 或裸开关。');
      }
      flags.adoptDirty = value === 'true';
    }
    else flags[key] = value;
  }
  return flags;
}

function toPosix(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function gitMetadataSegmentEquals(value) {
  const normalized = String(value || '').normalize('NFKC');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase() === '.git'
    : normalized === '.git';
}

function hasGitMetadataPathSegment(value) {
  return toPosix(String(value || ''))
    .split('/')
    .filter(Boolean)
    .some(gitMetadataSegmentEquals);
}

function normalizeTaskOwnedScope(patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('owned scope 至少需要一个 repo-relative 路径或有限 glob。');
  }
  return patterns.map((value) => {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.includes('\0')) {
      throw new Error('owned scope 只能包含无首尾空白/NUL 的非空路径。');
    }
    const posix = toPosix(value);
    if (
      path.posix.isAbsolute(posix) ||
      path.win32.isAbsolute(value) ||
      posix.startsWith('~')
    ) {
      throw new Error(`owned scope ${value} 位于仓库外；必须使用 repo-relative 路径。`);
    }
    const rawSegments = posix.split('/');
    if (rawSegments.includes('..')) {
      throw new Error(`owned scope ${value} 包含路径逃逸段 ../。`);
    }
    const normalized = path.posix.normalize(posix);
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      throw new Error(`owned scope ${value} 是过宽全仓范围或仓库外路径。`);
    }
    const segments = normalized.split('/').filter(Boolean);
    if (
      segments.length === 0 ||
      segments.every((segment) => /^[*?]+$/.test(segment))
    ) {
      throw new Error(`owned scope ${value} 是过宽全仓 glob。`);
    }
    const firstSegment = segments[0];
    if (
      firstSegment === '**' ||
      globToRegExp(firstSegment).test('.git')
    ) {
      throw new Error(`owned scope ${value} 可覆盖 Git metadata / task state，禁止授权。`);
    }
    return normalized;
  });
}

function globToRegExp(glob) {
  const source = toPosix(glob);
  let pattern = '^';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '*' && source[index + 1] === '*') {
      if (source[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index += 1;
      }
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  pattern += '$';
  return new RegExp(
    pattern,
    process.platform === 'win32' || process.platform === 'darwin' ? 'i' : '',
  );
}

function matchesAny(relativePath, patterns) {
  const candidate = toPosix(relativePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(candidate));
}

// Claude harness 的跨会话记忆目录在仓库之外（~/.claude/projects/<slug>/memory/），
// 不属于仓库治理面；Edit/Write 守卫对它豁免任务合同（PM 2026-07-21 拍板）。
// 仅精确匹配第二段为 memory 的路径，仓库内与其他仓库外路径不受影响。
function isHarnessMemoryPath(target, projectsRoot = path.resolve(os.homedir(), '.claude', 'projects')) {
  const relative = path.relative(path.resolve(projectsRoot), path.resolve(String(target)));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep).filter(Boolean);
  return segments.length >= 2 && segments[1] === 'memory';
}

function parseOwnerBlock(body) {
  const block = String(body || '').match(
    /<!--\s*coreone-owner:start\s*-->([\s\S]*?)<!--\s*coreone-owner:end\s*-->/i,
  );
  if (!block) return null;
  const owner = block[1].match(/-\s*\*\*current owner\*\*\s*[:：]\s*(.+)/i);
  return owner ? owner[1].trim() : null;
}

function parsePrdRef(value) {
  const raw = String(value || '').trim();
  const separator = raw.lastIndexOf('@');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const file = toPosix(raw.slice(0, separator));
  const ref = raw.slice(separator + 1);
  if (path.isAbsolute(file) || file.startsWith('../') || !/^[0-9a-fA-F]{7,40}$/.test(ref)) {
    return null;
  }
  return { file, ref };
}

function isRelevantPrompt(prompt) {
  return /(PRD|需求|功能|实现|写码|开发|Bug|缺陷|Issue|Pull Request|\bPR\b|复核|验收|交接|GitHub|worktree|preflight|deliver|implement|accept)/i.test(
    String(prompt || ''),
  );
}

function parseGitHubArtifactUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || !['issues', 'pull'].includes(parts[2])) return null;
    const number = Number(parts[3]);
    if (!Number.isInteger(number) || number <= 0) return null;
    const issueComment = url.hash.match(/^#issuecomment-(\d+)$/i);
    const reviewComment = url.hash.match(/^#discussion_r(\d+)$/i);
    return {
      owner: parts[0],
      repo: parts[1],
      kind: parts[2] === 'issues' ? 'issue' : 'pull',
      number,
      commentId: issueComment ? Number(issueComment[1]) : reviewComment ? Number(reviewComment[1]) : null,
      commentType: issueComment ? 'issue' : reviewComment ? 'review' : null,
      url: url.toString(),
    };
  } catch {
    return null;
  }
}

function repoIdentity(root) {
  const data = JSON.parse(
    run('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], { cwd: root, timeout: 10_000 }).stdout,
  );
  return data;
}

function assertSameRepo(root, parsed) {
  const identity = repoIdentity(root);
  if (`${parsed.owner}/${parsed.repo}`.toLowerCase() !== identity.nameWithOwner.toLowerCase()) {
    throw new Error(`GitHub 证据必须属于当前仓库 ${identity.nameWithOwner}。`);
  }
  return identity;
}

function assertRecent(timestamp, since, label) {
  if (!since) return;
  const actual = Date.parse(timestamp);
  const baseline = Date.parse(since);
  if (!Number.isFinite(actual) || !Number.isFinite(baseline) || actual + 120_000 < baseline) {
    throw new Error(`${label} 早于本次 task start，不能作为本轮交接证据。`);
  }
}

function verifyGitHubEvidence(root, value, options = {}) {
  const parsed = parseGitHubArtifactUrl(value);
  if (!parsed) throw new Error(`${options.label || 'GitHub 证据'}必须是 Issue / PR / comment URL。`);
  const identity = assertSameRepo(root, parsed);
  const repo = identity.nameWithOwner;
  let body = '';
  let timestamp = null;
  let author = null;

  if (parsed.commentType === 'review') {
    throw new Error(`${options.label || 'GitHub 证据'}请使用 Issue/PR 普通评论，不使用行级 review comment。`);
  }

  if (parsed.commentType === 'issue') {
    const comment = JSON.parse(
      run('gh', ['api', `repos/${repo}/issues/comments/${parsed.commentId}`], {
        cwd: root,
        timeout: 10_000,
      }).stdout,
    );
    const expectedSuffix = `/issues/${parsed.number}`;
    if (!String(comment.issue_url || '').endsWith(expectedSuffix)) {
      throw new Error(`${options.label || 'GitHub 证据'}评论与 URL 中的 Issue/PR 编号不一致。`);
    }
    body = String(comment.body || '');
    timestamp = comment.created_at || comment.updated_at;
    author = comment.user?.login || null;
  } else if (options.requireComment) {
    throw new Error(`${options.label || 'GitHub 证据'}必须指向一条普通 GitHub 评论。`);
  }

  if (parsed.kind === 'issue') {
    const issue = JSON.parse(
      run('gh', ['issue', 'view', String(parsed.number), '--json', 'number,state,url,updatedAt'], {
        cwd: root,
        timeout: 10_000,
      }).stdout,
    );
    if (options.activeIssue && parsed.number !== options.activeIssue) {
      throw new Error(`handoff Issue #${parsed.number} 不是活动 Issue #${options.activeIssue}。`);
    }
    timestamp ||= issue.updatedAt;
  } else {
    const pr = JSON.parse(
      run('gh', ['pr', 'view', String(parsed.number), '--json', 'number,state,url,body,createdAt,updatedAt'], {
        cwd: root,
        timeout: 10_000,
      }).stdout,
    );
    if (options.activeIssue) {
      const issuePattern = new RegExp(`(?:#|/issues/)${options.activeIssue}(?!\\d)`);
      if (!issuePattern.test(pr.body || '')) {
        throw new Error(`PR #${parsed.number} 未在 body 关联活动 Issue #${options.activeIssue}。`);
      }
    }
    timestamp ||= pr.createdAt || pr.updatedAt;
  }

  assertRecent(timestamp, options.since, options.label || 'GitHub 证据');
  if (options.expectedStatus) {
    const escaped = options.expectedStatus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const contract = new RegExp(
      `^\\[HANDOFF\\]\\s+status=${escaped}\\s*$`,
      'im',
    );
    if (!contract.test(body)) {
      throw new Error(
        `handoff 评论必须包含 [HANDOFF] status=${options.expectedStatus}，不能只提供旧 URL。`,
      );
    }
  }
  for (const requirement of options.bodyPatterns || []) {
    if (!requirement.pattern.test(body)) {
      throw new Error(`${options.label || 'GitHub 证据'}缺少${requirement.label}。`);
    }
  }
  if (options.requireHandoffFields) {
    const missing = handoffFieldErrors(body);
    if (missing.length > 0) {
      throw new Error(
        `handoff 评论缺少字段或字段格式无效：${missing.join(', ')}。` +
        'least-confidence / biggest-missing 必须使用 risk-v1 或 no-finding-v1 typed grammar；' +
        'raw/canonical contract 均不得超过 4096 UTF-8 bytes。',
      );
    }
  }
  if (options.requireCurrentActor) {
    const login = run('gh', ['api', 'user', '--jq', '.login'], { cwd: root, timeout: 10_000 }).stdout;
    if (author?.toLowerCase() !== login.toLowerCase()) {
      throw new Error(`handoff 评论作者 ${author || '未知'} 与当前 GitHub 操作者 ${login} 不一致。`);
    }
  }
  return { parsed, body, timestamp, author, repoOwner: identity.nameWithOwner.split('/')[0] };
}

function issueFormField(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body || '').match(new RegExp(`^### ${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^### |(?![\\s\\S]))`, 'im'));
  return match ? match[1].trim() : '';
}

function isPmApprovedStatus(status) {
  return /^PM_APPROVED(?:\s|$|[（(])/i.test(String(status || '').trim());
}

function parsePmApprovalMarker(body) {
  const marker = String(body || '').match(
    /^\[PM-APPROVAL\]\s+decision=approved\s+artifact=(\S+)\s*$/im,
  );
  return marker ? marker[1] : null;
}

function collectHandoffFields(body) {
  return collectVisibleFields(
    stripIgnoredMarkdown(String(body || '')),
    {
      allowEquals: true,
      allowUnknownFieldBoundaries: true,
      continuationBoundaryKeys: HANDOFF_CONTINUATION_BOUNDARY_KEYS,
    },
  );
}

function handoffFieldErrors(body) {
  const errors = [];
  const fields = collectHandoffFields(body);
  if (fields.malformed.includes('unsafe-invisible')) errors.push('field-key-invisible');
  if (fields.malformed.some((reason) => reason !== 'unsafe-invisible')) errors.push('field-key');
  for (const field of [
    'result',
    'evidence',
    'risk',
    'next-owner',
    'trigger',
    'least-confidence',
    'biggest-missing',
  ]) {
    if (fields.duplicates.has(field)) {
      errors.push(field);
      continue;
    }
    const value =
      field === 'least-confidence' || field === 'biggest-missing'
        ? fields.rawValues.get(field) || ''
        : fields.values.get(field) || '';
    if (field === 'least-confidence' || field === 'biggest-missing') {
      if (isWeakReflection(value)) errors.push(field);
      continue;
    }
    const minLength = field === 'next-owner' ? 2 : 4;
    if (value.length < minLength || /^(?:todo|tbd|n\/?a|none|无|待补|\.\.\.)$/i.test(value)) errors.push(field);
  }
  return errors;
}

function parseRequirementAcceptanceMap(value) {
  const mappings = [];
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/`/g, ''))
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(RQ-\d+)\s*(?:->|→|:)\s*(.+)$/i);
    const acceptance = match?.[2]?.match(/AC-\d+/gi) || [];
    const remainder = match?.[2]?.replace(/AC-\d+/gi, '').replace(/[\s,，、;；]+/g, '') || '';
    if (!match || acceptance.length === 0 || remainder) {
      throw new Error(`RQ → AC 映射格式无效：${line}；使用 RQ-01 -> AC-01, AC-02。`);
    }
    for (const ac of acceptance) {
      mappings.push({ requirement: match[1].toUpperCase(), acceptance: ac.toUpperCase() });
    }
  }
  if (mappings.length === 0) {
    throw new Error('PRD 驱动 Issue 必须填写至少一条 RQ → AC 映射。');
  }
  return mappings;
}

function isExactNotApplicable(value) {
  return /^N\/A$/i.test(String(value || '').replace(/`/g, '').trim());
}

function assertNonPrdIssueContract(body) {
  const classification = issueFormField(body, '单一分类').replace(/`/g, '').trim();
  if (!classification) {
    throw new Error('非 PRD 工作项必须填写“单一分类”。');
  }
  if (/^父级\s*tracking(?:\s|[（(]|$)/i.test(classification)) {
    throw new Error('父级 tracking 只聚合权威链接，不能进入实现或验收阶段。');
  }

  for (const field of ['现状证据', '范围', '非范围', '验收标准']) {
    const value = issueFormField(body, field)
      .replace(/`/g, '')
      .replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/gm, '')
      .trim();
    if (value.length < 4 || /^(?:todo|tbd|n\/?a|none|无|待补|\.\.\.)$/i.test(value)) {
      throw new Error(`非 PRD 工作项必须在“${field}”填写可实施、可验收的实质合同。`);
    }
  }
}

function classifyIssueDeliveryContract(body) {
  const prdField = issueFormField(body, 'PRD 固定基线').replace(/`/g, '').trim();
  const mappingField = issueFormField(body, 'RQ → AC 映射').replace(/`/g, '').trim();
  if (!prdField || !mappingField) {
    throw new Error('实现/验收 Issue 必须同时填写“PRD 固定基线”和“RQ → AC 映射”。');
  }

  const prdNotApplicable = isExactNotApplicable(prdField);
  const mappingNotApplicable = isExactNotApplicable(mappingField);
  if (prdNotApplicable !== mappingNotApplicable) {
    throw new Error('非 PRD 工作项必须把“PRD 固定基线”和“RQ → AC 映射”同时精确填写为 N/A。');
  }
  if (prdNotApplicable) {
    assertNonPrdIssueContract(body);
    return { mode: 'NON_PRD', requirements: [], acceptance: [], mappings: [] };
  }

  const prd = parsePrdRef(prdField);
  if (!prd) {
    throw new Error('PRD 驱动 Issue 的“PRD 固定基线”必须是 repo-relative/path.md@<merged commit SHA>。');
  }
  const mappings = parseRequirementAcceptanceMap(mappingField);
  return {
    mode: 'PRD',
    prd,
    requirements: [...new Set(mappings.map((item) => item.requirement))],
    acceptance: [...new Set(mappings.map((item) => item.acceptance))],
    mappings,
  };
}

function assertIssueMockupContract(body, mockupRaw, mockupApprovalUrl) {
  const mockupGate = issueFormField(body, 'Mockup 闸点');
  const mockupLines = mockupGate
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/`/g, ''))
    .filter(Boolean);
  if (!mockupLines.includes(String(mockupRaw || '')) || !mockupLines.includes(String(mockupApprovalUrl || ''))) {
    throw new Error('Issue 的“Mockup 闸点”必须同时包含 --mockup 值和对应 PM 批准评论 URL。');
  }
}

function assertIssueDeliveryContract(root, body, prd, mockupRaw, mockupApprovalUrl) {
  const contract = classifyIssueDeliveryContract(body);
  if (contract.mode !== 'PRD' || contract.prd.file !== prd.file) {
    throw new Error(`Issue 的“PRD 固定基线”必须精确引用 ${prd.file}@<merged SHA>。`);
  }
  const issuePrd = contract.prd;
  const issuePrdCommit = git(['rev-parse', `${issuePrd.ref}^{commit}`], root).stdout;
  if (issuePrdCommit !== prd.commit) throw new Error('Issue 的 PRD merge SHA 与 --prd 不一致。');

  const { mappings, requirements, acceptance } = contract;
  const prdText = git(['show', `${prd.commit}:${prd.file}`], root).stdout;
  for (const id of [...requirements, ...acceptance]) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?:^|[^A-Z0-9-])${escaped}(?:$|[^A-Z0-9-])`, 'i').test(prdText)) {
      throw new Error(`Issue 引用的 ${id} 不存在于固定 PRD。`);
    }
  }
  const prdRows = prdText.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
  for (const mapping of mappings) {
    const mapped = prdRows.some((row) => {
      const ids = row.match(/(?:RQ|AC)-\d+/gi)?.map((id) => id.toUpperCase()) || [];
      return ids.includes(mapping.requirement) && ids.includes(mapping.acceptance);
    });
    if (!mapped) {
      throw new Error(
        `Issue 的 ${mapping.requirement} → ${mapping.acceptance} 在固定 PRD 的同一验收表行中不存在。`,
      );
    }
  }
  assertIssueMockupContract(body, mockupRaw, mockupApprovalUrl);
  return { mode: 'PRD', requirements, acceptance, mappings };
}

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`无法读取 Claude hook 输入：${error.message}`);
  }
}

function loadState(root) {
  const snapshot = inspectTaskState(root);
  if (snapshot.kind === 'missing') return null;
  if (snapshot.kind !== 'valid') {
    throw new Error(
      `${inactiveTaskStateMessage(snapshot)}; it has no authorization effect. ` +
      'Run a new task start to replace it after safe inspection.',
    );
  }
  return { file: snapshot.file, state: snapshot.state };
}

function commandContext() {
  const root = repoRoot();
  const branch = git(['branch', '--show-current'], root).stdout || 'DETACHED';
  const head = git(['rev-parse', '--short=12', 'HEAD'], root).stdout;
  const base = git(['rev-parse', '--short=12', 'origin/master'], root, { allowFailure: true });
  const dirty = git(['status', '--short'], root).stdout;
  const snapshot = inspectTaskState(root);
  const active = snapshot.kind === 'valid' ? snapshot.state : null;
  const stateSummary = active
    ? active.mode === 'r0'
      ? `active task: local R0 / reason=${active.reason}`
      : `active task: #${active.issue} / ${active.stage} / owner=${active.owner}`
    : snapshot.kind === 'missing'
      ? 'active task: none; writes require start-r0 (no Issue) or governed task start'
      : `inactive historical task state: ${inactiveTaskStateMessage(snapshot)}; ` +
        '不具备授权效力，安全检查后重新运行 task start';

  process.stdout.write([
    '[COREONE SESSION ROUTER]',
    `branch=${branch} HEAD=${head} origin/master=${base.status === 0 ? base.stdout : 'UNVERIFIED'}`,
    `working tree=${dirty ? 'DIRTY' : 'clean'}`,
    stateSummary,
    'For PRD/feature/Issue/PR work, invoke project skill coreone-conventions. GitHub/Git live state overrides chat memory.',
  ].join('\n'));
}

function commandPrompt() {
  const input = readHookInput();
  if (!isRelevantPrompt(input.prompt)) return;
  process.stdout.write([
    '[COREONE PROMPT ROUTER]',
    'This prompt may affect PRD, implementation, review, acceptance, or GitHub state.',
    'Invoke coreone-conventions, resolve the live stage, output LOCAL TASK CONTRACT before governed edits, and use /coreone-deliver-prd for PRD-driven work.',
  ].join('\n'));
}

function assertMainlineMerge(root, commit, label) {
  const firstParent = new Set(git(['rev-list', '--first-parent', 'origin/master'], root).stdout.split(/\r?\n/));
  if (!firstParent.has(commit)) {
    throw new Error(`${label} 的 SHA 必须是 origin/master first-parent 上的合并后基线。`);
  }
}

function assertPmApproval(root, evidenceUrl, options) {
  const evidence = verifyGitHubEvidence(root, evidenceUrl, {
    label: options.label,
    requireComment: true,
    activeIssue: options.activeIssue || null,
  });
  if (evidence.author?.toLowerCase() !== evidence.repoOwner.toLowerCase()) {
    throw new Error(`${options.label}必须由仓库 PM owner ${evidence.repoOwner} 发布（当前：${evidence.author || '未知'}）。`);
  }
  const artifact = parsePmApprovalMarker(evidence.body);
  if (!artifact) {
    throw new Error(`${options.label}必须包含精确标记：[PM-APPROVAL] decision=approved artifact=<path@approved-head|MOCKUP_NOT_APPLICABLE>。`);
  }
  if (options.notApplicable) {
    if (artifact !== 'MOCKUP_NOT_APPLICABLE') {
      throw new Error(`${options.label}的 artifact 必须精确为 MOCKUP_NOT_APPLICABLE。`);
    }
    return { url: evidenceUrl, author: evidence.author, artifact };
  }

  const approved = parsePrdRef(artifact);
  if (!approved || approved.file !== options.baseline.file) {
    throw new Error(`${options.label}的 artifact 必须绑定 ${options.baseline.file}@<approved head SHA>。`);
  }
  const approvedCommit = git(['rev-parse', `${approved.ref}^{commit}`], root).stdout;
  const approvedBlob = git(['rev-parse', `${approvedCommit}:${approved.file}`], root).stdout;
  const mergedBlob = git(['rev-parse', `${options.baseline.commit}:${options.baseline.file}`], root).stdout;
  if (approvedBlob !== mergedBlob) {
    throw new Error(`${options.label}批准后的内容与合并基线内容不一致。`);
  }
  return { url: evidenceUrl, author: evidence.author, artifact, approvedCommit };
}

function assertOwnershipException(root, evidenceUrl, options) {
  const evidence = verifyGitHubEvidence(root, evidenceUrl, {
    label: 'Claude 实现所有权例外',
    requireComment: true,
    activeIssue: options.issue,
    requireCurrentActor: true,
  });
  if (evidence.author?.toLowerCase() !== evidence.repoOwner.toLowerCase()) {
    throw new Error(
      `所有权例外必须由仓库 PM owner ${evidence.repoOwner} 发布（当前：${evidence.author || '未知'}）。`,
    );
  }
  const marker = parseOwnershipExceptionMarker(evidence.body);
  const expectedScope = ownershipScopeDigest(options.owned);
  if (marker.issue !== options.issue || marker.scopeSha256 !== expectedScope) {
    throw new Error(
      `所有权例外必须绑定 Issue #${options.issue} 与当前 owned scope ${expectedScope}。`,
    );
  }
  return {
    verified: true,
    issue: options.issue,
    url: evidenceUrl,
    author: evidence.author,
    scopeSha256: expectedScope,
    reason: marker.reason,
  };
}

function assertPrdBaseline(root, prdValue) {
  const parsed = parsePrdRef(prdValue);
  if (!parsed) throw new Error('实现/验收阶段的 --prd 必须是 repo-relative/path.md@<merged commit SHA>。');
  const commit = git(['rev-parse', `${parsed.ref}^{commit}`], root).stdout;
  git(['merge-base', '--is-ancestor', commit, 'origin/master'], root);
  assertMainlineMerge(root, commit, 'PRD');
  git(['cat-file', '-e', `${commit}:${parsed.file}`], root);
  const header = git(['show', `${commit}:${parsed.file}`], root)
    .stdout
    .split(/\r?\n/)
    .slice(0, 40)
    .join('\n');
  const status = header.match(/^\s*>?\s*\*\*状态\*\*\s*[:：]\s*(.+)$/im)?.[1] || '';
  if (!isPmApprovedStatus(status)) {
    throw new Error(
      `PRD ${parsed.file}@${parsed.ref} 的头部状态不是 PM_APPROVED（当前：${status || '缺失'}）。`,
    );
  }
  return { ...parsed, commit };
}

function assertMockupBaseline(root, value) {
  const raw = String(value || '').trim();
  if (/^NOT_APPLICABLE\s*:\s*\S.+/i.test(raw)) return { mode: 'NOT_APPLICABLE', reason: raw };
  const parsed = parsePrdRef(raw);
  if (!parsed) {
    throw new Error('--mockup 必须是 path@merged-SHA，或 NOT_APPLICABLE:<纯后端等具体理由>。');
  }
  if (!/(^|\/)(?:mockups?|prototypes?|designs?|v1\.1设计稿)(?:\/|$)|设计稿/i.test(parsed.file)) {
    throw new Error('--mockup 的文件路径必须位于 mockup / prototype / design / 设计稿产物目录。');
  }
  const commit = git(['rev-parse', `${parsed.ref}^{commit}`], root).stdout;
  git(['merge-base', '--is-ancestor', commit, 'origin/master'], root);
  assertMainlineMerge(root, commit, 'Mockup');
  git(['cat-file', '-e', `${commit}:${parsed.file}`], root);
  return { mode: 'APPROVED', ...parsed, commit };
}

function commandStart(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  const issue = Number(flags.issue);
  const stage = String(flags.stage || '').toLowerCase();
  const owner = String(flags.owner || '').trim();
  const risk = String(flags.risk || '').toUpperCase();

  if (!Number.isInteger(issue) || issue <= 0) throw new Error('--issue 必须是开放 GitHub Issue 编号。');
  if (!MODIFY_STAGES.has(stage)) throw new Error(`--stage 必须是 ${[...MODIFY_STAGES].join(' / ')}。`);
  if (!owner || /^unassigned$/i.test(owner)) throw new Error('--owner 必须与 Issue body 当前 owner 一致。');
  if (!/^R[0-3]$/.test(risk)) throw new Error('--risk 必须是 R0 / R1 / R2 / R3。');
  if (flags.owned.length === 0) throw new Error('至少提供一个 --owned=<path/glob>。');
  flags.owned = normalizeTaskOwnedScope(flags.owned);
  if (inspectTaskState(root).kind === 'valid') {
    throw new Error('已有活动 task state；先完成 finish-r0 或 GitHub handoff，不能用新的 start 覆盖。');
  }
  const dirtyPaths = listDirtyPaths(root);
  if (dirtyPaths.length > 0 && !flags.adoptDirty) {
    throw new Error('task start 前工作树必须 clean，避免把合同建立前的改动并入本任务。');
  }
  if (flags.adoptDirty && dirtyPaths.length > 0) {
    const adoptScope = { owned: flags.owned, excluded: flags.excluded };
    const violations = findScopeViolations(dirtyPaths, adoptScope);
    if (violations.length > 0) {
      throw new Error(
        `--adopt-dirty 拒绝：以下既有 dirty 路径不在 --owned 内或命中 --excluded：${violations.join(', ')}`,
      );
    }
  }

  git(['fetch', 'origin', '--prune'], root, { timeout: 120_000 });

  const branch = git(['branch', '--show-current'], root).stdout;
  if (!branch || /^(master|main)$/i.test(branch)) {
    throw new Error(`当前分支 ${branch || 'DETACHED'} 不可用于实现；请从 origin/master 建任务 worktree。`);
  }
  git(['merge-base', '--is-ancestor', 'origin/master', 'HEAD'], root);

  const issueResult = run(
    'gh',
    ['issue', 'view', String(issue), '--json', 'state,body,url,title,labels'],
    { cwd: root, timeout: 10_000 },
  );
  const issueData = JSON.parse(issueResult.stdout);
  if (issueData.state !== 'OPEN') throw new Error(`Issue #${issue} 不是 OPEN。`);
  const issueRating = assertIssueImplementationLabels(issueData.labels, issue);
  const issueOwner = parseOwnerBlock(issueData.body);
  if (!issueOwner) throw new Error(`Issue #${issue} 缺少 coreone-owner 受控块。`);
  const wantsClaim = String(flags.claim || '').toLowerCase() === 'true';
  const canClaim = wantsClaim && /^(?:unassigned|待认领)$/i.test(issueOwner);
  if (!canClaim && issueOwner.localeCompare(owner, undefined, { sensitivity: 'accent' }) !== 0) {
    throw new Error(`Issue #${issue} 当前 owner=${issueOwner}，与 --owner=${owner} 不一致。`);
  }

  const ownershipInspection = inspectClaudeImplementationOwnership(stage, flags.owned);
  let ownershipException = null;
  if (ownershipInspection.requiresException && flags['ownership-exception']) {
    ownershipException = assertOwnershipException(root, flags['ownership-exception'], {
      issue,
      owned: flags.owned,
    });
  }
  assertClaudeImplementationOwnership(stage, flags.owned, ownershipException);

  let prd = null;
  let mockup = null;
  let approval = null;
  let mockupApproval = null;
  let deliveryContract = null;
  let sourceMode = null;
  if (stage === 'implementation' || stage === 'acceptance') {
    const sourceContract = classifyIssueDeliveryContract(issueData.body);
    sourceMode = sourceContract.mode;
    if (sourceMode === 'PRD') {
      prd = assertPrdBaseline(root, flags.prd);
      approval = assertPmApproval(root, flags.approval, {
        label: 'PRD PM 定稿证据',
        baseline: prd,
      });
    } else {
      if (flags.prd && !isExactNotApplicable(flags.prd)) {
        throw new Error('非 PRD 工作项的 --prd 只能省略或精确填写 N/A。');
      }
      if (flags.approval) {
        throw new Error('非 PRD 工作项不得提供 PRD --approval；权威源是 Issue 的复现/范围/验收合同。');
      }
    }
    mockup = assertMockupBaseline(root, flags.mockup);
    mockupApproval = assertPmApproval(root, flags['mockup-approval'], {
      label: mockup.mode === 'NOT_APPLICABLE' ? 'Mockup 不适用的 PM 证据' : 'Mockup PM 定稿证据',
      baseline: mockup.mode === 'APPROVED' ? mockup : null,
      notApplicable: mockup.mode === 'NOT_APPLICABLE',
      activeIssue: mockup.mode === 'NOT_APPLICABLE' ? issue : null,
    });
    if (sourceMode === 'PRD') {
      deliveryContract = assertIssueDeliveryContract(
        root,
        issueData.body,
        prd,
        flags.mockup,
        flags['mockup-approval'],
      );
    } else {
      assertIssueMockupContract(issueData.body, flags.mockup, flags['mockup-approval']);
      deliveryContract = sourceContract;
    }
  }

  const preflightArgs = [
    path.join(root, 'scripts', 'agent-preflight.cjs'),
    '--mode=develop',
    '--base-ref=origin/master',
    '--no-worktree-report',
    ...flags.owned.map((value) => `--owned=${value}`),
    ...flags.excluded.map((value) => `--excluded=${value}`),
  ];
  const preflight = run(process.execPath, preflightArgs, { cwd: root, timeout: 240_000 });

  if (canClaim && !flags.dryRun) {
    const claimedBody = issueData.body.replace(
      /(-\s*\*\*current owner\*\*\s*[:：]\s*)(.+)/i,
      `$1${owner}`,
    );
    runGitHubWrite(root, ['issue', 'edit', String(issue), '--body', claimedBody], {
      timeout: 15_000,
    });
    const claimedIssue = JSON.parse(
      run('gh', ['issue', 'view', String(issue), '--json', 'state,body,url,title,labels'], {
        cwd: root,
        timeout: 10_000,
      }).stdout,
    );
    const claimedRating = assertIssueImplementationLabels(claimedIssue.labels, issue);
    if (
      claimedIssue.state !== 'OPEN' ||
      parseOwnerBlock(claimedIssue.body) !== owner ||
      claimedRating.priority !== issueRating.priority ||
      claimedRating.releaseImpact !== issueRating.releaseImpact
    ) {
      throw new Error(`Issue #${issue} 认领后复核失败；停止建立本地 task state。`);
    }
    Object.assign(issueData, claimedIssue);
  }

  const state = {
    version: TASK_STATE_VERSION,
    mode: 'governed',
    issue,
    issueUrl: issueData.url,
    issueTitle: issueData.title,
    issueBodyHash: sha256(issueData.body),
    issuePriority: issueRating.priority,
    issueReleaseImpact: issueRating.releaseImpact,
    stage,
    owner,
    risk,
    branch,
    baseSha: git(['rev-parse', 'origin/master'], root).stdout,
    startedHead: git(['rev-parse', 'HEAD'], root).stdout,
    startedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    owned: flags.owned.map(toPosix),
    excluded: flags.excluded.map(toPosix),
    adoptedDirty: flags.adoptDirty ? dirtyPaths : [],
    prd,
    mockup,
    approval,
    mockupApproval,
    deliveryContract,
    sourceMode,
    ownershipException,
  };

  if (!flags.dryRun) {
    const file = stateFile(root);
    writePrivateJson(file, state);
    if (canClaim) {
      runGitHubWrite(
        root,
        ['issue', 'comment', String(issue), '--body', `[CLAIM] owner=${owner}\nstage=${stage}\nbranch=${branch}`],
        { timeout: 15_000 },
      );
    }
  }

  process.stdout.write([
    `COREONE task start: ${flags.dryRun ? 'DRY-RUN PASS' : 'PASS'}`,
    `Issue #${issue} / stage=${stage} / owner=${owner}`,
    sourceMode ? `source=${sourceMode}` : null,
    `branch=${branch} / base=${state.baseSha.slice(0, 12)}`,
    `owned=${state.owned.join(', ')}`,
    preflight.stdout,
  ].filter(Boolean).join('\n'));
}

function issueCreationLedgerFile(root) {
  return path.join(githubWriteControlDirectory(root), 'issue-creation-ledger.json');
}

function beginIssueCreationLedger(root, manifestSha256, approvalUrl) {
  const controlDirectory = githubWriteControlDirectory(root);
  // The reservation is shared by every linked worktree and stays held through
  // all remote creates/readbacks. Two sessions therefore cannot both observe
  // the same authorized manifest as unconsumed before either starts writing.
  const release = acquireExclusiveLocalLock(
    path.join(controlDirectory, 'issue-creation-ledger.lock'),
    'Issue candidate 防重放锁',
  );
  try {
    const ledgerPath = issueCreationLedgerFile(root);
    const ledger = loadJsonFile(ledgerPath) || { version: 1, consumed: {} };
    ledger.version = 1;
    ledger.consumed ||= {};
    const previous = ledger.consumed[manifestSha256];
    if (previous?.status === 'completed') {
      throw new Error(`Issue candidate manifest ${manifestSha256} 已消费；禁止重放创建。`);
    }
    if (previous) {
      if (previous.approval !== approvalUrl) {
        throw new Error(`Issue candidate manifest ${manifestSha256} 的恢复授权与原事务不一致。`);
      }
      if (!['in-progress', 'failed'].includes(previous.status)) {
        throw new Error(
          `Issue candidate manifest ${manifestSha256} 的账本状态 ${previous.status || '<missing>'} 不可恢复。`,
        );
      }
      if (previous.status === 'in-progress' && isLocalProcessAlive(Number(previous.pid))) {
        throw new Error(`Issue candidate manifest ${manifestSha256} 仍由活动进程处理；禁止并发接管。`);
      }
      previous.status = 'in-progress';
      previous.resumedAt = new Date().toISOString();
      previous.pid = process.pid;
      previous.issues ||= [];
    } else {
      ledger.consumed[manifestSha256] = {
        approval: approvalUrl,
        startedAt: new Date().toISOString(),
        status: 'in-progress',
        pid: process.pid,
        issues: [],
      };
    }
    writePrivateJson(ledgerPath, ledger);
    return {
      created: ledger.consumed[manifestSha256].issues,
      ledger,
      ledgerPath,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

function currentGitHubActor(root) {
  const actor = run('gh', ['api', 'user', '--jq', '.login'], {
    cwd: root,
    timeout: 10_000,
  }).stdout.trim();
  if (!actor) throw new Error('无法确认当前 GitHub actor；停止 GitHub 写入。');
  return actor;
}

function recoverCreatedIssue(root, candidate, attempt) {
  if (!attempt?.attemptStartedAt) return null;
  const actor = currentGitHubActor(root);
  if (
    !attempt.attemptActor ||
    actor.toLowerCase() !== String(attempt.attemptActor).toLowerCase()
  ) {
    throw new Error(
      `Issue 创建恢复 actor 不一致（attempt=${attempt.attemptActor || '<missing>'}, ` +
      `current=${actor}）；停止自动恢复和重试。`,
    );
  }
  const identity = repoIdentity(root);
  if (
    !attempt.attemptRepo ||
    identity.nameWithOwner.toLowerCase() !== String(attempt.attemptRepo).toLowerCase()
  ) {
    throw new Error(
      `Issue 创建恢复仓库不一致（attempt=${attempt.attemptRepo || '<missing>'}, ` +
      `current=${identity.nameWithOwner}）；停止自动恢复和重试。`,
    );
  }
  const startedAtMs = Date.parse(attempt.attemptStartedAt);
  const notAfterMs = Date.parse(attempt.attemptNotAfter);
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(notAfterMs) ||
    notAfterMs <= startedAtMs ||
    notAfterMs - startedAtMs > ISSUE_CREATION_RECOVERY_REMOTE_WINDOW_MS
  ) {
    throw new Error('Issue 创建恢复 attempt 时间窗缺失或非法；停止自动恢复和重试。');
  }
  const lowerBound = startedAtMs - ISSUE_CREATION_RECOVERY_CLOCK_SKEW_MS;
  const upperBound = notAfterMs + ISSUE_CREATION_RECOVERY_CLOCK_SKEW_MS;
  const endpoint =
    `repos/${identity.nameWithOwner}/issues?state=all&` +
    `since=${encodeURIComponent(new Date(lowerBound).toISOString())}&per_page=100`;
  const pages = JSON.parse(
    run(
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        endpoint,
      ],
      { cwd: root, timeout: 10_000 },
    ).stdout,
  );
  const rows = (Array.isArray(pages) ? pages : [])
    .flatMap((page) => Array.isArray(page) ? page : [page]);
  const matches = (Array.isArray(rows) ? rows : []).filter((row) =>
    !row.pull_request &&
    Number.isInteger(Number(row.number)) &&
    row.title === candidate.title &&
    String(row.body || '') === candidate.body &&
    String(row.user?.login || '').toLowerCase() === actor.toLowerCase() &&
    Number.isFinite(Date.parse(row.created_at)) &&
    Date.parse(row.created_at) >= lowerBound &&
    Date.parse(row.created_at) <= upperBound);
  if (matches.length > 1) {
    throw new Error(
      `远端恢复发现 ${matches.length} 个同内容 Issue；停止自动选择，须由 Codex 去重处置。`,
    );
  }
  if (!matches[0]) return null;
  return {
    number: Number(matches[0].number),
    url: matches[0].html_url,
  };
}

function resolveIssueCreationManifestPath(
  value,
  root = repoRoot(),
  projectsRoot = null,
) {
  const raw = String(value || '');
  if (!path.isAbsolute(raw)) {
    throw new Error('Issue candidate manifest 必须使用当前 Claude project memory 下的绝对路径。');
  }
  const target = path.resolve(raw);
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.resolve(os.homedir(), '.claude');
  const resolvedProjectsRoot = projectsRoot
    ? path.resolve(projectsRoot)
    : path.join(configDirectory, 'projects');
  const projectSlug = path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-');
  const expectedMemoryRoot = path.join(resolvedProjectsRoot, projectSlug, 'memory');
  let canonicalMemoryRoot;
  let canonicalTarget;
  try {
    const memoryRootStat = fs.lstatSync(expectedMemoryRoot);
    if (!memoryRootStat.isDirectory() || memoryRootStat.isSymbolicLink()) {
      throw new Error('当前 Claude project memory 目录不是可信的真实目录（疑似符号链接逃逸）。');
    }
    canonicalMemoryRoot = fs.realpathSync.native(expectedMemoryRoot);
    canonicalTarget = fs.realpathSync.native(target);
  } catch (error) {
    throw new Error(`Issue candidate manifest 路径无法验证：${error.message}`);
  }
  if (
    path.extname(canonicalTarget).toLowerCase() !== '.json' ||
    !fs.statSync(canonicalTarget).isFile() ||
    !isPathInside(canonicalMemoryRoot, canonicalTarget)
  ) {
    throw new Error(
      'Issue candidate manifest 必须位于当前 Claude project 的 memory 目录；' +
      '不得借用其他 project、符号链接逃逸、仓库 dirty 文件或任意外部路径创建。',
    );
  }
  return canonicalTarget;
}

function commandCreateIssues(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  const taskSnapshot = inspectTaskState(root);
  if (taskSnapshot.kind === 'valid') {
    throw new Error('已有活动 task state；必须先完成 handoff，再串行创建获准的新需求 Issues。');
  }
  const manifestPath = resolveIssueCreationManifestPath(flags.manifest, root);
  const rawManifest = fs.readFileSync(manifestPath, 'utf8');
  const manifest = validateIssueCreationManifest(rawManifest);
  const approvalUrl = String(flags.approval || '').trim();
  if (!approvalUrl) throw new Error('--approval 必须是 PM 对该 manifest hash 的普通评论 URL。');
  const evidence = verifyGitHubEvidence(root, approvalUrl, {
    label: 'Issue 创建授权',
    requireComment: true,
    requireCurrentActor: true,
  });
  if (evidence.author?.toLowerCase() !== evidence.repoOwner.toLowerCase()) {
    throw new Error(
      `Issue 创建授权必须由仓库 PM owner ${evidence.repoOwner} 发布（当前：${evidence.author || '未知'}）。`,
    );
  }
  const marker = parseIssueCreationApprovalMarker(evidence.body);
  if (marker.sha256 !== manifest.sha256 || marker.count !== manifest.issues.length) {
    throw new Error(
      `Issue 创建授权与候选 manifest 不一致：expected ${manifest.sha256}/${manifest.issues.length}。`,
    );
  }
  const reservation = beginIssueCreationLedger(root, manifest.sha256, approvalUrl);
  const { created, ledger, ledgerPath } = reservation;
  const transaction = ledger.consumed[manifest.sha256];
  try {
    for (let index = 0; index < manifest.issues.length; index += 1) {
      const candidate = manifest.issues[index];
      let createdIssue = created.find((item) => Number(item.index) === index);
      if (!createdIssue && created[index] && created[index].title === candidate.title) {
        createdIssue = created[index];
        createdIssue.index = index;
      }
      if (!createdIssue) {
        createdIssue = {
          index,
          title: candidate.title,
          bodySha256: sha256(candidate.body),
          status: 'pending',
          readbackVerified: false,
        };
        created.push(createdIssue);
        writePrivateJson(ledgerPath, ledger);
      }
      if (
        createdIssue.title !== candidate.title ||
        (createdIssue.bodySha256 && createdIssue.bodySha256 !== sha256(candidate.body))
      ) {
        throw new Error(`Issue candidate #${index + 1} 与恢复账本不一致；停止写入。`);
      }
      createdIssue.bodySha256 = sha256(candidate.body);
      if (createdIssue.readbackVerified === true) continue;
      try {
        if (!createdIssue.url && createdIssue.attemptStartedAt) {
          const recovered = recoverCreatedIssue(
            root,
            candidate,
            createdIssue,
          );
          if (recovered) {
            createdIssue.number = Number(recovered.number);
            createdIssue.url = recovered.url;
            createdIssue.status = 'recovered';
            createdIssue.recoveredAt = new Date().toISOString();
            writePrivateJson(ledgerPath, ledger);
          }
        }
        if (!createdIssue.url) {
          const createResult = runGitHubWrite(
            root,
            ['issue', 'create', '--title', candidate.title, '--body', candidate.body],
            {
              timeout: 30_000,
              beforeWrite: () => {
                const identity = repoIdentity(root);
                const attemptStartedAtMs = Date.now();
                createdIssue.status = 'creating';
                createdIssue.attemptStartedAt = new Date(attemptStartedAtMs).toISOString();
                createdIssue.attemptNotAfter = new Date(
                  attemptStartedAtMs + ISSUE_CREATION_RECOVERY_REMOTE_WINDOW_MS,
                ).toISOString();
                createdIssue.attemptActor = currentGitHubActor(root);
                createdIssue.attemptRepo = identity.nameWithOwner;
                createdIssue.error = null;
                writePrivateJson(ledgerPath, ledger);
              },
            },
          );
          const url = createResult.stdout
            .split(/\r?\n/)
            .find((line) => /^https:\/\/github\.com\//.test(line));
          const parsed = parseGitHubArtifactUrl(url);
          if (!parsed || parsed.kind !== 'issue') {
            throw new Error(`gh issue create 未返回可验证的 Issue URL：${createResult.stdout || '<empty>'}`);
          }
          createdIssue.number = parsed.number;
          createdIssue.url = url;
          createdIssue.status = 'created';
          writePrivateJson(ledgerPath, ledger);
        }
        const readback = JSON.parse(
          run(
            'gh',
            [
              'issue',
              'view',
              String(createdIssue.number),
              '--json',
              'number,state,url,title,body,labels',
            ],
            { cwd: root, timeout: 10_000 },
          ).stdout,
        );
        const labels = (readback.labels || []).map((label) => label?.name || label);
        if (
          readback.state !== 'OPEN' ||
          readback.url !== createdIssue.url ||
          readback.title !== candidate.title ||
          String(readback.body || '') !== candidate.body ||
          labels.some((label) => ISSUE_PRIORITY_LABELS.has(label) || ISSUE_RELEASE_LABELS.has(label))
        ) {
          throw new Error(`Issue #${createdIssue.number} 创建后回读不符合 question-only 候选合同。`);
        }
        createdIssue.readbackVerified = true;
        createdIssue.status = 'verified';
        createdIssue.verifiedAt = new Date().toISOString();
        writePrivateJson(ledgerPath, ledger);
      } catch (error) {
        createdIssue.status = 'failed';
        createdIssue.error = error.message;
        transaction.status = 'failed';
        transaction.pid = null;
        transaction.failedAt = new Date().toISOString();
        transaction.error = error.message;
        writePrivateJson(ledgerPath, ledger);
        throw new Error(
          `Issue candidate 串行创建停止：${error.message}` +
          (created.some((item) => item.url)
            ? `；此前已创建 ${created.filter((item) => item.url).map((item) => item.url).join(', ')}`
            : ''),
        );
      }
    }

    transaction.status = 'completed';
    transaction.pid = null;
    transaction.error = null;
    transaction.completedAt = new Date().toISOString();
    writePrivateJson(ledgerPath, ledger);
    process.stdout.write([
      `COREONE authorized Issue creation: PASS (` +
        `${created.filter((item) => item.readbackVerified).length}/${manifest.issues.length})`,
      `manifest-sha256=${manifest.sha256}`,
      ...created
        .filter((item) => item.readbackVerified)
        .map((item) => `Issue #${item.number}: ${item.url}`),
      'Writer ownership relinquished. Codex must now deduplicate, review scope/AC, rate, write labels, and read them back before implementation.',
    ].join('\n'));
  } finally {
    reservation.release();
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function commandStartR0(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  if (flags.adoptDirty) {
    throw new Error('start-r0 不支持 --adopt-dirty；R0 仍要求 clean 工作树。');
  }
  const reason = String(flags.reason || '').trim();
  if (reason.length < 6) throw new Error('--reason 必须说明本项为何属于 R0 琐碎、可逆修改。');
  if (flags.owned.length === 0) throw new Error('R0 也至少提供一个 --owned=<path/glob>。');
  flags.owned = normalizeTaskOwnedScope(flags.owned);
  if (inspectTaskState(root).kind === 'valid') {
    throw new Error('已有活动 task state；先完成 finish-r0 或 GitHub handoff，不能用 R0 覆盖。');
  }
  const branch = git(['branch', '--show-current'], root).stdout;
  if (!branch || /^(master|main)$/i.test(branch)) {
    throw new Error(`R0 修改也必须在任务分支；当前为 ${branch || 'DETACHED'}。`);
  }
  if (git(['status', '--short'], root).stdout) {
    throw new Error('start-r0 前工作树必须 clean，避免把既有改动误算进本任务。');
  }
  const state = {
    version: TASK_STATE_VERSION,
    mode: 'r0',
    stage: 'r0',
    risk: 'R0',
    reason,
    branch,
    baseSha: git(['rev-parse', 'origin/master'], root).stdout,
    startedHead: git(['rev-parse', 'HEAD'], root).stdout,
    startedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    owned: flags.owned.map(toPosix),
    excluded: flags.excluded.map(toPosix),
  };
  writePrivateJson(stateFile(root), state);
  process.stdout.write(
    `COREONE R0 task start: PASS\nreason=${reason}\nowned=${state.owned.join(', ')}`,
  );
}

function commandFinishR0(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  const active = loadState(root);
  if (!active || active.state.mode !== 'r0') throw new Error('没有活动 R0 task state。');
  const evidence = String(flags.evidence || '').trim();
  if (evidence.length < 8 || /^(?:pass|done|完成|通过)$/i.test(evidence)) {
    throw new Error('--evidence 必须写明实际目标检查，不能只写 done/pass。');
  }
  assertActiveState(root, active, { force: true });
  assertOwnedChanges(root, active.state);
  removePrivateFile(active.file);
  process.stdout.write(`COREONE R0 task finished: ${evidence}`);
}

function resolveHookPath(input) {
  return input.tool_input?.file_path || input.tool_input?.notebook_path || null;
}

function assertActiveState(root, active, options = {}) {
  const { state } = active;
  const now = Date.now();
  const startedAt = Date.parse(state.startedAt);
  const verifiedAt = Date.parse(state.verifiedAt || state.startedAt);
  const age = now - startedAt;
  if (
    !Number.isFinite(age) ||
    age > STATE_MAX_AGE_MS ||
    startedAt > now + TASK_STATE_CLOCK_SKEW_MS ||
    verifiedAt > now + TASK_STATE_CLOCK_SKEW_MS ||
    verifiedAt < startedAt
  ) {
    throw new Error('task contract 已过期（>12h）；重新读取 GitHub 并运行 task start。');
  }
  const branch = git(['branch', '--show-current'], root).stdout;
  if (branch !== state.branch) {
    throw new Error(`branch 已变化（${state.branch} -> ${branch}）；重新运行 task start。`);
  }
  git(['merge-base', '--is-ancestor', state.startedHead, 'HEAD'], root);

  if (state.mode === 'r0') return;
  git(['merge-base', '--is-ancestor', state.baseSha, 'HEAD'], root);

  const sinceVerify = now - verifiedAt;
  if (!options.force && Number.isFinite(sinceVerify) && sinceVerify < LIVE_RECHECK_MS) return null;

  const remoteLine = git(['ls-remote', 'origin', 'refs/heads/master'], root).stdout.split(/\s+/)[0];
  if (!remoteLine || remoteLine !== state.baseSha) {
    throw new Error('origin/master 已变化；先 fetch/rebase，再重新运行 task start。');
  }
  const issue = JSON.parse(
    run('gh', ['issue', 'view', String(state.issue), '--json', 'state,body,url,labels'], {
      cwd: root,
      timeout: 10_000,
    }).stdout,
  );
  if (issue.state !== 'OPEN') throw new Error(`活动 Issue #${state.issue} 已不是 OPEN。`);
  const liveRating = assertIssueImplementationLabels(issue.labels, state.issue);
  if (
    liveRating.priority !== state.issuePriority ||
    liveRating.releaseImpact !== state.issueReleaseImpact
  ) {
    if (!options.allowRatingDrift) {
      throw new Error(
        `Issue #${state.issue} 评级已变化（${state.issuePriority ?? 'UNRECORDED'}/` +
        `${state.issueReleaseImpact ?? 'UNRECORDED'} -> ` +
        `${liveRating.priority}/${liveRating.releaseImpact}）；由 Codex 留下正式评级评论后运行 ` +
        'rebaseline-rating --evidence=<comment URL>。',
      );
    }
  }
  if (sha256(issue.body) !== state.issueBodyHash) {
    throw new Error(`Issue #${state.issue} body 已变化；重新读取范围/RQ/AC 并运行 task start。`);
  }
  const liveOwner = parseOwnerBlock(issue.body);
  if (liveOwner?.localeCompare(state.owner, undefined, { sensitivity: 'accent' }) !== 0) {
    throw new Error(`Issue #${state.issue} owner 已变化（${state.owner} -> ${liveOwner || '缺失'}）。`);
  }
  if (state.approval) {
    assertPmApproval(root, state.approval.url, { label: 'PRD PM 定稿证据', baseline: state.prd });
  }
  if (state.mockupApproval) {
    assertPmApproval(root, state.mockupApproval.url, {
      label: state.mockup?.mode === 'NOT_APPLICABLE' ? 'Mockup 不适用的 PM 证据' : 'Mockup PM 定稿证据',
      baseline: state.mockup?.mode === 'APPROVED' ? state.mockup : null,
      notApplicable: state.mockup?.mode === 'NOT_APPLICABLE',
      activeIssue: state.mockup?.mode === 'NOT_APPLICABLE' ? state.issue : null,
    });
  }
  if (options.persistVerification !== false) {
    state.verifiedAt = new Date().toISOString();
    writePrivateJson(active.file, state);
  }
  return { issue, liveRating };
}

function commandRebaselineRating(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  const active = loadState(root);
  if (!active || active.state.mode !== 'governed') {
    throw new Error('没有可重定评级基线的活动 governed task state。');
  }
  const { state } = active;
  if (Number(state.version) > TASK_STATE_VERSION) {
    throw new Error(`task state version=${state.version} 高于当前支持版本 ${TASK_STATE_VERSION}。`);
  }
  const evidence = String(flags.evidence || '').trim();
  if (!evidence) throw new Error('--evidence 必须是活动 Issue 上的正式评级普通评论 URL。');

  const live = assertActiveState(root, active, {
    force: true,
    allowRatingDrift: true,
    persistVerification: false,
  });
  const recorded = validateIssueImplementationLabels([
    state.issuePriority,
    state.issueReleaseImpact,
  ]);
  const previousPriority = recorded.ok ? recorded.priority : 'UNRECORDED';
  const previousReleaseImpact = recorded.ok ? recorded.releaseImpact : 'UNRECORDED';
  const ratingChanged =
    live.liveRating.priority !== state.issuePriority ||
    live.liveRating.releaseImpact !== state.issueReleaseImpact;
  const schemaChanged = state.version !== TASK_STATE_VERSION;
  if (!ratingChanged && !schemaChanged) {
    throw new Error('活动 task state 的评级与 schema 已是当前基线，无需重定。');
  }

  const ratingEvidence = verifyGitHubEvidence(root, evidence, {
    label: 'Issue 正式评级证据',
    requireComment: true,
    activeIssue: state.issue,
    since: state.startedAt,
    requireCurrentActor: true,
  });
  if (ratingEvidence.parsed.kind !== 'issue') {
    throw new Error(`评级证据必须是活动 Issue #${state.issue} 的普通评论。`);
  }
  const marker = parseIssueRatingMarker(ratingEvidence.body);
  if (
    marker.previousPriority !== previousPriority ||
    marker.previousReleaseImpact !== previousReleaseImpact
  ) {
    throw new Error(
      `评级证据 previous=${marker.previousPriority}/${marker.previousReleaseImpact} ` +
      `与本地 state=${previousPriority}/${previousReleaseImpact} 不一致。`,
    );
  }
  if (
    marker.currentPriority !== live.liveRating.priority ||
    marker.currentReleaseImpact !== live.liveRating.releaseImpact
  ) {
    throw new Error(
      `评级证据 current=${marker.currentPriority}/${marker.currentReleaseImpact} ` +
      `与 Issue 实时标签=${live.liveRating.priority}/${live.liveRating.releaseImpact} 不一致。`,
    );
  }

  Object.assign(state, {
    version: TASK_STATE_VERSION,
    issuePriority: live.liveRating.priority,
    issueReleaseImpact: live.liveRating.releaseImpact,
    ratingEvidenceUrl: evidence,
    ratingRebaselinedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
  });
  writePrivateJson(active.file, state);
  process.stdout.write(
    `COREONE rating rebaseline: PASS\nIssue #${state.issue}: ` +
    `${previousPriority}/${previousReleaseImpact} -> ` +
    `${state.issuePriority}/${state.issueReleaseImpact}\nevidence=${evidence}`,
  );
}

function listDirtyPaths(root) {
  const commands = [
    ['diff', '--no-renames', '--name-only', '-z'],
    ['diff', '--cached', '--no-renames', '--name-only', '-z'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ];
  const paths = new Set();
  for (const args of commands) {
    const result = git(args, root);
    for (const file of result.stdout.split('\0').filter(Boolean)) paths.add(toPosix(file));
  }
  return [...paths];
}

function listChangedPaths(root, state) {
  const paths = new Set(listDirtyPaths(root));
  const committed = git(['diff', '--no-renames', '--name-only', '-z', `${state.startedHead}..HEAD`], root);
  for (const file of committed.stdout.split('\0').filter(Boolean)) paths.add(toPosix(file));
  return [...paths];
}

function findScopeViolations(paths, state) {
  return paths.filter((file) =>
    hasGitMetadataPathSegment(file) ||
    matchesAny(file, state.excluded) ||
    !matchesAny(file, state.owned));
}

function findDriftViolations(paths, state) {
  // 合同前 adopted 路径（state.adoptedDirty）在 start 时已逐一核验并记录基线；
  // 合同后新路径按同一 owned/excluded 约束实时复检。即使 state 被篡改，
  // adopted 路径也按同一约束复检，不能豁免越界路径。
  return findScopeViolations(paths, state);
}

function assertOwnedChanges(root, state) {
  const violations = findDriftViolations(listChangedPaths(root, state), state);
  if (violations.length > 0) {
    const adopted = Array.isArray(state.adoptedDirty) && state.adoptedDirty.length > 0;
    throw new Error(
      `${adopted ? 'adopted 基线后新增越界 drift' : '检测到 owned/excluded 范围外改动'}：${violations.join(', ')}`,
    );
  }
}

function hasShellControl(command) {
  return /[;&|<>\r\n`]/.test(command) || /\$\(|\$\{/.test(command);
}

function shellTokens(command) {
  return (String(command).match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || []).map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function shellClosingParenthesis(source, openIndex) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')' && --depth === 0) return index;
  }
  return -1;
}

function splitShellCommandSegments(command) {
  const source = String(command || '');
  const segments = [];
  const nestedSegments = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    const startsCommandSubstitution =
      quote !== "'" &&
      character === '$' &&
      source[index + 1] === '(';
    const startsProcessSubstitution =
      !quote &&
      (character === '<' || character === '>') &&
      source[index + 1] === '(';
    if (startsCommandSubstitution || startsProcessSubstitution) {
      const closing = shellClosingParenthesis(source, index + 1);
      if (closing >= 0) {
        const nested = source.slice(index + 2, closing);
        if (nested.trim()) nestedSegments.push(...splitShellCommandSegments(nested));
        current += source.slice(index, closing + 1);
        index = closing;
        continue;
      }
    }
    if (quote !== "'" && character === '`') {
      let closing = index + 1;
      let nestedEscaped = false;
      for (; closing < source.length; closing += 1) {
        if (nestedEscaped) {
          nestedEscaped = false;
          continue;
        }
        if (source[closing] === '\\') {
          nestedEscaped = true;
          continue;
        }
        if (source[closing] === '`') break;
      }
      if (closing < source.length) {
        const nested = source.slice(index + 1, closing);
        if (nested.trim()) nestedSegments.push(...splitShellCommandSegments(nested));
        current += source.slice(index, closing + 1);
        index = closing;
        continue;
      }
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    const ampersandSeparatesCommands =
      character === '&' &&
      source[index - 1] !== '>' &&
      source[index + 1] !== '>';
    if (
      character === ';' ||
      character === '\n' ||
      character === '|' ||
      ampersandSeparatesCommands
    ) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if (
        (character === '|' && source[index + 1] === '|') ||
        (character === '&' && source[index + 1] === '&')
      ) {
        index += 1;
      }
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.concat(nestedSegments);
}

function commandTokens(segment) {
  return shellTokens(segment);
}

function assertSafeEnvironmentAssignment(value) {
  const match = String(value || '').match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
  if (!match) throw new Error(`环境前缀 ${value} 无法静态验证。`);
  const [, name] = match;
  const upper = name.toUpperCase();
  const changesExecutableOrRuntimeLoading =
    upper === 'PATH' ||
    upper === 'BASH_ENV' ||
    upper === 'ENV' ||
    upper === 'ZDOTDIR' ||
    upper === 'NODE_OPTIONS' ||
    upper === 'PYTHONPATH' ||
    upper === 'PYTHONSTARTUP' ||
    upper === 'PERL5OPT' ||
    upper === 'RUBYOPT' ||
    upper === 'LD_PRELOAD' ||
    upper.startsWith('DYLD_');
  const changesGitOrToolHelpers =
    upper.startsWith('GIT_') ||
    upper === 'PAGER' ||
    upper === 'EDITOR' ||
    upper === 'VISUAL' ||
    upper.startsWith('NPM_CONFIG_');
  if (changesExecutableOrRuntimeLoading || changesGitOrToolHelpers) {
    throw new Error(
      `环境覆写 ${name} 会改变 executable、runtime loader、Git scope 或 helper；无 task state 时禁止。`,
    );
  }
}

function unwrapCommandTokens(tokens, options = {}) {
  let current = [...tokens];
  for (let depth = 0; depth < 6 && current.length > 0; depth += 1) {
    while (
      current.length > 0 &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(current[0]))
    ) {
      assertSafeEnvironmentAssignment(current[0]);
      current = current.slice(1);
    }
    if (current.length === 0) return current;
    const executable = path.basename(String(current[0] || '')).toLowerCase();
    if (executable === 'command') {
      if (['-v', '-V'].includes(String(current[1] || ''))) return current;
      let index = 1;
      if (current[index] === '--') index += 1;
      if (index >= current.length || String(current[index]).startsWith('-')) {
        throw new Error('command wrapper 只允许不改变 executable 解析语义的形式。');
      }
      current = current.slice(index);
      continue;
    }
    if (executable === 'env') {
      let index = 1;
      if (current[index] === '--') index += 1;
      while (index < current.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(current[index]))) {
        assertSafeEnvironmentAssignment(current[index]);
        index += 1;
      }
      if (index >= current.length || String(current[index]).startsWith('-')) {
        throw new Error('env 只允许显式安全变量后跟一个可审计命令。');
      }
      current = current.slice(index);
      continue;
    }
    if (['sudo', 'nohup'].includes(executable) && !options.hasActiveState) {
      throw new Error(`${executable} 会改变权限/环境或留下后台输出，无 task state 时禁止。`);
    }
    if (executable === 'nohup') {
      const index = current.slice(1).findIndex((value) => !String(value).startsWith('-'));
      if (index < 0) return current;
      current = current.slice(index + 1);
      continue;
    }
    if (executable === 'sudo') {
      let index = 1;
      while (index < current.length && String(current[index]).startsWith('-')) {
        const option = String(current[index]);
        index += 1;
        if (['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt'].includes(option)) {
          index += 1;
        }
      }
      if (index >= current.length) return current;
      current = current.slice(index);
      continue;
    }
    break;
  }
  return current;
}

function resolvePhysicalPath(base, value) {
  const absolute = path.resolve(base, String(value));
  const suffix = [];
  let existing = absolute;
  while (true) {
    try {
      return path.join(fs.realpathSync.native(existing), ...suffix);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function isNullDeviceTarget(value) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (process.platform === 'win32') {
    return /^(?:nul|\\\\\.\\nul)$/i.test(raw);
  }
  return path.resolve(raw) === '/dev/null';
}

function temporaryPhysicalRoots() {
  const candidates = process.platform === 'win32'
    ? [os.tmpdir()]
    : [os.tmpdir(), '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp'];
  const roots = new Set();
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate);
    roots.add(absolute);
    try {
      roots.add(fs.realpathSync.native(absolute));
    } catch {
      // A platform without a listed alias is covered by the roots that exist.
    }
  }
  return roots;
}

function assertNotGitMetadataTarget(root, raw, target) {
  if (hasGitMetadataPathSegment(raw) || hasGitMetadataPathSegment(target)) {
    throw new Error(`文件写目标 ${raw} 指向 Git metadata；任何 task scope 都不得授权。`);
  }
  for (const directory of [
    physicalGitDirectory(root),
    physicalGitDirectory(root, { common: true }),
  ]) {
    if (target === directory || isPathInside(directory, target)) {
      throw new Error(`文件写目标 ${raw} 指向 Git metadata；任何 task scope 都不得授权。`);
    }
  }
}

function assertTaskWriteTarget(value, state = {}) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw || isNullDeviceTarget(raw)) return;
  if (/[$%*?\[\]{}]/.test(raw) || raw.startsWith('~')) {
    throw new Error(`文件写目标 ${raw} 无法静态解析；请改用明确的 owned 路径或临时目录。`);
  }
  const root = resolvePhysicalPath(process.cwd(), state.root || process.cwd());
  const cwd = resolvePhysicalPath(root, state.cwd || root);
  const target = resolvePhysicalPath(cwd, raw);
  assertNotGitMetadataTarget(root, raw, target);
  if (isPathInside(root, target)) {
    const relative = toPosix(path.relative(root, target));
    if (
      !Array.isArray(state.owned) ||
      matchesAny(relative, state.excluded || []) ||
      !matchesAny(relative, state.owned)
    ) {
      throw new Error(`文件写目标 ${relative} 不在当前 task owned scope。`);
    }
    return;
  }
  if ([...temporaryPhysicalRoots()].some((temporaryRoot) =>
    isPathInside(temporaryRoot, target, { allowSame: true }))) return;
  if (isHarnessMemoryPath(target)) return;
  throw new Error(`文件写目标 ${raw} 位于当前仓库和临时目录之外。`);
}

function gitConfigOverrideKey(raw, source) {
  const value = String(raw || '');
  const separator = value.indexOf('=');
  if (separator === 0 || (separator < 0 && source !== '-c')) {
    throw new Error(`git ${source} 缺少 key=value。`);
  }
  const key = (separator < 0 ? value : value.slice(0, separator)).trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/i.test(key)) {
    throw new Error(`git ${source} config key ${key || '<missing>'} 无法验证。`);
  }
  return key;
}

function assertSafeGitConfigOverride(raw, source) {
  const key = gitConfigOverrideKey(raw, source);
  const executesOrRedirects = [
    /^alias\./,
    /^filter\./,
    /^credential(?:\.|$)/,
    /^include(?:if)?\./,
    /^remote\./,
    /^url\./,
    /^http\./,
    /^protocol\./,
    /^pager\./,
    /^difftool\./,
    /^mergetool\./,
    /^gpg\./,
    /^core\.(?:hookspath|fsmonitor|pager|editor|sshcommand|askpass|attributesfile|excludesfile|worktree|gitproxy)$/,
    /^diff\.(?:external|[^.]+\.textconv|[^.]+\.command)$/,
    /^merge\.[^.]+\.driver$/,
    /^interactive\.difffilter$/,
    /^sequence\.editor$/,
  ];
  if (executesOrRedirects.some((pattern) => pattern.test(key))) {
    throw new Error(
      `git ${source} ${key} 可改写 helper、凭据、远端或仓库边界，已拒绝。`,
    );
  }
  return key;
}

function gitSubcommand(tokens) {
  let index = 1;
  const globals = [];
  const configOverrides = [];
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const current = String(tokens[index]);
    globals.push(current);
    if (current === '-c') {
      const config = String(tokens[index + 1] || '');
      globals.push(config);
      configOverrides.push({ source: '-c', value: config });
      index += 2;
    } else if (/^-c.+/.test(current)) {
      configOverrides.push({ source: '-c', value: current.slice(2) });
      index += 1;
    } else if (current === '--config-env') {
      const config = String(tokens[index + 1] || '');
      globals.push(config);
      configOverrides.push({ source: '--config-env', value: config });
      index += 2;
    } else if (current.startsWith('--config-env=')) {
      configOverrides.push({
        source: '--config-env',
        value: current.slice('--config-env='.length),
      });
      index += 1;
    } else if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(current)) {
      globals.push(tokens[index + 1] || '');
      index += 2;
    } else {
      index += 1;
    }
  }
  return {
    globals,
    configOverrides,
    command: String(tokens[index] || '').toLowerCase(),
    args: tokens.slice(index + 1),
  };
}

function assertSafeWorktreeAdd(args, options = {}) {
  if (args.length !== 5 || args[0] !== 'add' || args[1] !== '-b' || args[4] !== 'origin/master') {
    throw new Error('task start 前只允许 git worktree add -b <新分支> <新路径> origin/master。');
  }

  const branch = String(args[2] || '');
  if (
    !branch ||
    /^(?:master|main)$/i.test(branch) ||
    /^[-.]|[/.]$|\.lock$/i.test(branch) ||
    /(?:\.\.|\/\/|@\{|[\s~^:?*\[\\])/.test(branch)
  ) {
    throw new Error(`worktree 分支名 ${branch || '<missing>'} 不是安全的具名任务分支。`);
  }

  const literalTarget = String(args[3] || '');
  if (!literalTarget || literalTarget.startsWith('-') || /[$%!*?\[\]`~]/.test(literalTarget)) {
    throw new Error('worktree 路径必须是无变量、无通配符的字面路径。');
  }
  const root = path.resolve(options.root || process.cwd());
  const target = path.resolve(options.cwd || root, literalTarget);
  if (target === root) throw new Error('worktree 路径不能覆盖当前仓库。');
  if (isPathInside(root, target) && !isPathInside(path.join(root, '.claude', 'worktrees'), target)) {
    throw new Error('仓库内 worktree 只能创建在 .claude/worktrees/<任务名>；也可使用仓库外字面路径。');
  }
}

function gitArgumentHas(args, names) {
  return args.some((value) => names.some((name) =>
    value === name || value.startsWith(`${name}=`)));
}

function assertNoGitExecutionOrOutputFlags(command, args) {
  const blocked = [
    '--ext-diff',
    '--textconv',
    '--output',
    '--output-directory',
    '-o',
    '--exec',
    '--remote',
    '--upload-pack',
  ];
  if (gitArgumentHas(args, blocked)) {
    throw new Error(`git ${command} 包含 helper/output override，无 task state 时禁止。`);
  }
}

function parseNoStateGitInvocation(tokens, root, cwd) {
  assertTrustedExecutablePath(tokens[0], cwd);
  let currentDirectory = resolvePhysicalPath(root, cwd);
  let index = 1;
  let pagerDisabled = false;
  const globals = [];
  while (index < tokens.length && String(tokens[index]).startsWith('-')) {
    const value = String(tokens[index]);
    if (value === '--') {
      index += 1;
      break;
    }
    if (['--no-pager', '-P'].includes(value)) {
      globals.push(value);
      pagerDisabled = true;
      index += 1;
      continue;
    }
    if ([
      '--paginate',
      '-p',
      '--literal-pathspecs',
      '--glob-pathspecs',
      '--noglob-pathspecs',
      '--icase-pathspecs',
      '--no-optional-locks',
      '--no-replace-objects',
      '--version',
      '--help',
    ].includes(value)) {
      globals.push(value);
      index += 1;
      continue;
    }
    if (value === '-c' || (value.startsWith('-c') && value.length > 2)) {
      const config = value === '-c'
        ? String(tokens[index + 1] || '')
        : value.slice(2);
      assertSafeGitConfigOverride(config, '-c');
      globals.push(...(value === '-c' ? [value, config] : [value]));
      index += value === '-c' ? 2 : 1;
      continue;
    }
    if (value === '--config-env' || value.startsWith('--config-env=')) {
      const config = value === '--config-env'
        ? String(tokens[index + 1] || '')
        : value.slice('--config-env='.length);
      assertSafeGitConfigOverride(config, '--config-env');
      globals.push(...(value === '--config-env' ? [value, config] : [value]));
      index += value === '--config-env' ? 2 : 1;
      continue;
    }
    let directory = null;
    if (value === '-C') {
      directory = String(tokens[index + 1] || '');
      globals.push(value, directory);
      index += 2;
    } else if (value.startsWith('-C') && value.length > 2) {
      directory = value.slice(2);
      globals.push(value);
      index += 1;
    } else {
      throw new Error(`git global override ${value} 无 task state 时禁止。`);
    }
    if (!directory) throw new Error('git -C 缺少目录。');
    const target = resolvePhysicalPath(currentDirectory, directory);
    if (!isPathInside(root, target, { allowSame: true })) {
      throw new Error('git -C 必须保持在当前 repo/worktree 物理边界内。');
    }
    const targetRoot = repoRoot(target);
    if (targetRoot !== resolvePhysicalPath(process.cwd(), root)) {
      throw new Error('git -C 不得切换到嵌套或其他仓库。');
    }
    currentDirectory = target;
  }
  const command = String(tokens[index] || '').toLowerCase();
  return {
    command,
    args: tokens.slice(index + 1).map(String),
    cwd: currentDirectory,
    globals,
    pagerDisabled,
  };
}

function isReadOnlyBranchArgs(args) {
  if (args.length === 0) return true;
  if (args.length === 1 && args[0] === '--show-current') return true;
  if (args.some((value) =>
    /^(?:-[dDmMcCfuU]|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|create-reflog|track|no-track))(?:=|$)/
      .test(value))) {
    return false;
  }
  if (args.some((value) =>
    /^(?:-a|-r|-l|-v|-vv|--(?:all|remotes|list|contains|no-contains|merged|no-merged|points-at|format|sort|column|color|ignore-case|omit-empty|abbrev|no-abbrev))(?:=|$)/
      .test(value))) {
    return true;
  }
  return args.some((value) => value.startsWith('-'));
}

function isReadOnlyTagArgs(args) {
  if (args.length === 0) return true;
  if (args.some((value) =>
    /^(?:-[adfsu]|--(?:annotate|delete|force|sign|local-user|cleanup|create-reflog))(?:=|$)/
      .test(value))) {
    return false;
  }
  if (args.some((value) =>
    /^(?:-l|-n\d*|--(?:list|contains|no-contains|merged|no-merged|points-at|format|sort|column|color|ignore-case))(?:=|$)/
      .test(value))) {
    return true;
  }
  return args.some((value) => value.startsWith('-'));
}

const GIT_CONFIG_OPTIONS_WITH_VALUE = new Set([
  '--file',
  '-f',
  '--blob',
  '--type',
  '-t',
  '--default',
  '--comment',
  '--value',
  '--url',
]);

const GIT_CONFIG_LONG_OPTIONS = new Set([
  '--add',
  '--all',
  '--append',
  '--blob',
  '--bool',
  '--bool-or-int',
  '--bool-or-str',
  '--comment',
  '--config-env',
  '--default',
  '--edit',
  '--expiry-date',
  '--file',
  '--fixed-value',
  '--get',
  '--get-all',
  '--get-color',
  '--get-colorbool',
  '--get-regexp',
  '--get-urlmatch',
  '--global',
  '--help',
  '--includes',
  '--int',
  '--list',
  '--local',
  '--name-only',
  '--null',
  '--path',
  '--regexp',
  '--remove-section',
  '--rename-section',
  '--replace-all',
  '--show-names',
  '--show-origin',
  '--show-scope',
  '--system',
  '--type',
  '--unset',
  '--unset-all',
  '--url',
  '--value',
  '--worktree',
  ...[
    'all',
    'append',
    'blob',
    'comment',
    'default',
    'file',
    'fixed-value',
    'global',
    'includes',
    'local',
    'name-only',
    'null',
    'regexp',
    'show-names',
    'show-origin',
    'show-scope',
    'system',
    'type',
    'url',
    'value',
    'worktree',
  ].map((name) => `--no-${name}`),
]);

function resolveGitConfigLongOption(name) {
  if (GIT_CONFIG_LONG_OPTIONS.has(name)) return name;
  const matches = [...GIT_CONFIG_LONG_OPTIONS].filter((candidate) =>
    candidate.startsWith(name));
  return matches.length === 1 ? matches[0] : null;
}

function tokenizeGitConfigArgs(args) {
  const options = [];
  const positionals = [];
  const unknownOptions = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (value === '--') {
      positionals.push(...args.slice(index + 1).map(String));
      break;
    }
    if (value.startsWith('--')) {
      const equalsIndex = value.indexOf('=');
      const rawName = (equalsIndex < 0 ? value : value.slice(0, equalsIndex)).toLowerCase();
      const name = resolveGitConfigLongOption(rawName);
      const inlineValue = equalsIndex < 0 ? null : value.slice(equalsIndex + 1);
      if (!name) {
        unknownOptions.push(value);
        continue;
      }
      if (GIT_CONFIG_OPTIONS_WITH_VALUE.has(name)) {
        options.push({
          name,
          value: inlineValue === null ? String(args[index + 1] || '') : inlineValue,
        });
        if (inlineValue === null) index += 1;
      } else {
        options.push({ name, value: inlineValue });
      }
      continue;
    }
    if (value.startsWith('-') && value !== '-') {
      if (value.startsWith('-e')) {
        options.push({ name: '-e', value: value.slice(2) || null });
        continue;
      }
      const name = value.slice(0, 2).toLowerCase();
      if (GIT_CONFIG_OPTIONS_WITH_VALUE.has(name)) {
        const attached = value.slice(2).replace(/^=/, '');
        options.push({
          name,
          value: attached || String(args[index + 1] || ''),
        });
        if (!attached) index += 1;
      } else if (value === '-h' || value === '-l' || value === '-z') {
        options.push({ name, value: null });
      } else {
        unknownOptions.push(value);
      }
      continue;
    }
    positionals.push(value);
  }
  return { options, positionals, unknownOptions };
}

function isReadOnlyConfigArgs(args) {
  const parsed = tokenizeGitConfigArgs(args);
  if (parsed.unknownOptions.length > 0) return false;
  const optionNames = new Set(parsed.options.map((option) => option.name));
  if ([
    '--add',
    '--append',
    '--replace-all',
    '--unset',
    '--unset-all',
    '--rename-section',
    '--remove-section',
    '--edit',
    '--config-env',
    '-e',
  ].some((name) => optionNames.has(name))) {
    return false;
  }
  const { positionals } = parsed;
  const subcommand = String(positionals[0] || '').toLowerCase();
  if ([
    'set',
    'unset',
    'rename-section',
    'remove-section',
    'edit',
  ].includes(subcommand)) {
    return false;
  }
  if (['get', 'list', 'get-color', 'get-colorbool'].includes(subcommand)) return true;
  if ([
    '--get',
    '--get-all',
    '--get-regexp',
    '--get-urlmatch',
    '--list',
    '--get-color',
    '--get-colorbool',
    '-l',
  ].some((name) => optionNames.has(name))) {
    return true;
  }
  if (positionals.length <= 1) return true;
  return false;
}

function effectiveGitConfigEntries(cwd, pattern) {
  const result = git(
    ['config', '--null', '--get-regexp', pattern],
    cwd,
    { allowFailure: true },
  );
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`无法检查有效 Git config：${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf('\n');
      return separator < 0
        ? { key: record, value: '' }
        : { key: record.slice(0, separator), value: record.slice(separator + 1) };
    });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function repositoryAttributeSources(root, cwd) {
  const sources = new Set();
  const attributePathspec = ['.gitattributes', ':(glob)**/.gitattributes'];
  for (const args of [
    [
      'ls-files',
      '-z',
      '--full-name',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...attributePathspec,
    ],
    [
      'ls-files',
      '-z',
      '--full-name',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...attributePathspec,
    ],
  ]) {
    const listed = git(args, cwd, { allowFailure: true });
    if (listed.status !== 0) {
      throw new Error(
        `无法枚举有效 Git attributes：${listed.stderr || listed.stdout || listed.status}`,
      );
    }
    for (const relative of listed.stdout.split('\0').filter(Boolean)) {
      sources.add(path.resolve(root, relative));
    }
  }
  for (const gitDirectory of [
    physicalGitDirectory(root),
    physicalGitDirectory(root, { common: true }),
  ]) {
    sources.add(path.join(gitDirectory, 'info', 'attributes'));
  }
  const configuredAttributes = effectiveGitConfigEntries(cwd, '^core\\.attributesfile$');
  for (const entry of configuredAttributes) {
    const raw = String(entry.value || '').trim();
    if (!raw) continue;
    sources.add(raw.startsWith('~/')
      ? path.join(os.homedir(), raw.slice(2))
      : path.resolve(cwd, raw));
  }
  if (configuredAttributes.length === 0) {
    sources.add(path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'git',
      'attributes',
    ));
  }
  if (process.platform !== 'win32') {
    sources.add('/etc/gitattributes');
    const execPath = git(['--exec-path'], cwd, { allowFailure: true });
    if (execPath.status === 0 && execPath.stdout) {
      sources.add(path.resolve(execPath.stdout, '..', '..', 'etc', 'gitattributes'));
    }
  }
  return [...sources];
}

function configuredTextconvDrivers(root, cwd) {
  const drivers = [];
  for (const entry of effectiveGitConfigEntries(cwd, '^diff\\..*\\.textconv$')) {
    const match = entry.key.match(/^diff\.(.+)\.textconv$/i);
    if (match && String(entry.value || '').trim()) drivers.push(match[1]);
  }
  if (drivers.length === 0) return [];
  const attributeTexts = [];
  for (const source of repositoryAttributeSources(root, cwd)) {
    try {
      const stat = fs.statSync(source);
      if (stat.isFile()) attributeTexts.push(fs.readFileSync(source, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`无法检查 Git attributes ${source}：${error.message}`);
      }
    }
  }
  return drivers.filter((driver) => {
    const marker = new RegExp(
      `(?:^|[\\t ])diff=${escapeRegExp(driver)}(?=$|[\\t ])`,
      'mi',
    );
    return attributeTexts.some((text) => marker.test(text));
  });
}

function configuredFsmonitorHelper(cwd) {
  const values = effectiveGitConfigEntries(cwd, '^core\\.fsmonitor$')
    .map((entry) => String(entry.value || '').trim())
    .filter(Boolean);
  return values.find((value) => !/^(?:true|false)$/i.test(value)) || null;
}

function configuredPagerHelper(command, cwd) {
  const entries = effectiveGitConfigEntries(
    cwd,
    `^(core\\.pager|pager\\.${escapeRegExp(command)})$`,
  );
  for (const entry of entries) {
    const value = String(entry.value || '').trim();
    if (!value || /^false$/i.test(value)) continue;
    if (hasShellControl(value)) return value;
    const first = shellTokens(value)[0] || '';
    if (['cat', 'less', 'more'].includes(executableBasename(first))) {
      if (!executableHasExplicitPath(first)) continue;
      try {
        assertTrustedExecutablePath(first, cwd);
        continue;
      } catch {
        return value;
      }
    }
    return value;
  }
  return null;
}

function configuredGitAlias(command, cwd) {
  const entries = effectiveGitConfigEntries(
    cwd,
    `^alias\\.${escapeRegExp(command)}$`,
  );
  return entries[0]?.value || null;
}

// Git resolves builtins before searching git-<subcommand> in exec-path/PATH.
// Keep the Git 2.50 builtin inventory explicit so an absent/unknown command may
// remain observable while a physically executable external helper is blocked.
const GIT_250_BUILTINS = new Set((
  'add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file ' +
  'check-attr check-ignore check-mailmap check-ref-format checkout checkout--worker ' +
  'checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree ' +
  'config count-objects credential credential-cache credential-cache--daemon credential-store ' +
  'describe diagnose diff diff-files diff-index diff-pairs diff-tree difftool fast-export ' +
  'fast-import fetch fetch-pack fmt-merge-msg for-each-ref for-each-repo format-patch fsck ' +
  'fsck-objects fsmonitor--daemon gc get-tar-commit-id grep hash-object help hook index-pack ' +
  'init init-db interpret-trailers log ls-files ls-remote ls-tree mailinfo mailsplit maintenance ' +
  'merge merge-base merge-file merge-index merge-ours merge-recursive merge-recursive-ours ' +
  'merge-recursive-theirs merge-subtree merge-tree mktag mktree multi-pack-index mv name-rev ' +
  'notes pack-objects pack-redundant pack-refs patch-id pickaxe prune prune-packed pull push ' +
  'range-diff read-tree rebase receive-pack reflog refs remote remote-ext remote-fd repack ' +
  'replace replay rerere reset restore rev-list rev-parse revert rm send-pack shortlog show ' +
  'show-branch show-index show-ref sparse-checkout stage stash status stripspace ' +
  'submodule--helper switch symbolic-ref tag unpack-file unpack-objects update-index update-ref ' +
  'update-server-info upload-archive upload-archive--writer upload-pack var verify-commit ' +
  'verify-pack verify-tag version whatchanged worktree write-tree'
).split(/\s+/));

function externalGitSubcommandHelper(command, cwd) {
  if (!command || !/^[a-z0-9][a-z0-9-]*$/i.test(command)) return null;
  if (GIT_250_BUILTINS.has(command)) return null;
  const directories = [];
  const execPath = git(['--exec-path'], cwd, { allowFailure: true });
  if (execPath.status === 0 && execPath.stdout) directories.push(execPath.stdout);
  directories.push(...String(process.env.PATH || '').split(path.delimiter).filter(Boolean));
  for (const directory of new Set(directories)) {
    for (const name of executableCandidates(`git-${command}`)) {
      const candidate = path.join(directory, name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // The real Git invocation cannot execute this candidate.
      }
    }
  }
  return null;
}

function assertNoImplicitGitHelper(command, args, options) {
  const usesTextconv =
    command === 'diff' ||
    (
      command === 'show' &&
      !args.some((value) => ['--no-patch', '-s'].includes(value))
    ) ||
    (
      command === 'log' &&
      gitArgumentHas(args, ['-p', '--patch', '--stat', '--numstat', '--shortstat'])
    );
  if (
    usesTextconv &&
    !gitArgumentHas(args, ['--no-textconv']) &&
    configuredTextconvDrivers(options.root, options.cwd).length > 0
  ) {
    throw new Error(
      `git ${command} 会按有效 attributes/config 执行 textconv helper；无 task state 时禁止。`,
    );
  }
  if (
    usesTextconv &&
    !gitArgumentHas(args, ['--no-ext-diff']) &&
    effectiveGitConfigEntries(options.cwd, '^diff\\.external$')
      .some((entry) => String(entry.value || '').trim())
  ) {
    throw new Error(
      `git ${command} 会按有效 diff.external config 执行 helper；请显式使用 --no-ext-diff。`,
    );
  }
  if (
    new Set(['status', 'diff', 'show', 'log']).has(command) &&
    configuredFsmonitorHelper(options.cwd)
  ) {
    throw new Error(
      `git ${command} 会执行有效 core.fsmonitor helper；无 task state 时禁止。`,
    );
  }
  if (
    !options.pagerDisabled &&
    new Set(['log', 'show', 'diff', 'blame']).has(command) &&
    configuredPagerHelper(command, options.cwd)
  ) {
    throw new Error(
      `git ${command} 配置了可执行 pager helper；请用 git -P/--no-pager 运行诊断。`,
    );
  }
}

function assertNoKnownGitMutation(command, args) {
  const alwaysMutating = new Set([
    'add',
    'am',
    'apply',
    'bisect',
    'checkout',
    'cherry-pick',
    'clean',
    'clone',
    'commit',
    'commit-tree',
    'credential',
    'daemon',
    'fast-import',
    'fetch',
    'filter-branch',
    'filter-repo',
    'gc',
    'index-pack',
    'init',
    'maintenance',
    'merge',
    'mergetool',
    'mktag',
    'mktree',
    'mv',
    'pack-objects',
    'pack-refs',
    'prune',
    'pull',
    'push',
    'read-tree',
    'rebase',
    'receive-pack',
    'reflog',
    'repack',
    'reset',
    'restore',
    'revert',
    'rm',
    'send-pack',
    'switch',
    'update-index',
    'update-ref',
    'update-server-info',
    'write-tree',
  ]);
  if (alwaysMutating.has(command)) {
    throw new Error(`git ${command} 会写本地状态、对象、远端或执行 helper；需先建立 task contract。`);
  }
  if (command === 'fsck' && gitArgumentHas(args, ['--lost-found'])) {
    throw new Error('git fsck --lost-found 会写 Git metadata；需先建立 task contract。');
  }
  if (command === 'grep' && gitArgumentHas(args, ['--open-files-in-pager'])) {
    throw new Error('git grep pager helper mode 无 task state 时禁止。');
  }
  if (['difftool', 'gui', 'citool', 'instaweb'].includes(command)) {
    throw new Error(`git ${command} 会启动外部 helper；无 task state 时禁止。`);
  }
}

function gitBuiltinAction(args) {
  const optionsWithValue = new Set(['--object-dir']);
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '');
    if (optionsWithValue.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('-')) return value.toLowerCase();
  }
  return '';
}

function assertNoGitBuiltinSideEffect(command, args, options = {}) {
  const action = gitBuiltinAction(args);
  if (command === 'hook' && action === 'run') {
    throw new Error('git hook run 会执行仓库 hook helper，已拒绝。');
  }
  if (command === 'checkout-index') {
    throw new Error('git checkout-index 会直接写 worktree、prefix 或临时输出，已拒绝。');
  }
  if (command === 'commit-graph' && action === 'write') {
    throw new Error('git commit-graph write 会写 Git object metadata，已拒绝。');
  }
  if (command === 'multi-pack-index' && ['write', 'repack', 'expire'].includes(action)) {
    throw new Error(`git multi-pack-index ${action} 会写 Git object metadata，已拒绝。`);
  }
  if (options.hasActiveState && command === 'worktree' && action !== 'list') {
    throw new Error('活动 task 内禁止新增、移动、删除或修复嵌套 worktree/ref。');
  }
  if (
    !options.hasActiveState &&
    new Set([
      'backfill',
      'checkout--worker',
      'credential-cache--daemon',
      'fsmonitor--daemon',
      'prune-packed',
      'replay',
      'rerere',
      'unpack-file',
      'unpack-objects',
    ]).has(command)
  ) {
    throw new Error(`git ${command} 会写 Git metadata、worktree 或启动 helper；需先建立 task contract。`);
  }
  if (
    !options.hasActiveState &&
    command === 'refs' &&
    ['migrate', 'pack-refs'].includes(action)
  ) {
    throw new Error(`git refs ${action} 会写 ref metadata；需先建立 task contract。`);
  }
}

function isReadOnlyRemoteArgs(args) {
  if (args.length === 0) return true;
  if (args.length === 1 && ['-v', '--verbose'].includes(args[0])) return true;
  if (args[0] !== 'get-url') return false;
  const positionals = args.slice(1).filter((value) => !value.startsWith('-'));
  return (
    positionals.length === 1 &&
    args.slice(1).every((value) =>
      !value.startsWith('-') || ['--all', '--push'].includes(value))
  );
}

function isReadOnlySymbolicRefArgs(args) {
  const positionals = args.filter((value) => !value.startsWith('-'));
  return (
    positionals.length === 1 &&
    args.every((value) =>
      !value.startsWith('-') ||
      ['-q', '--quiet', '--short', '--no-recurse', '--recurse'].includes(value))
  );
}

function assertSafeGitReadCommand(tokens, options = {}) {
  const root = resolvePhysicalPath(process.cwd(), options.root || process.cwd());
  const cwd = resolvePhysicalPath(root, options.cwd || root);
  const {
    command,
    args,
    globals,
    pagerDisabled,
  } = parseNoStateGitInvocation(tokens, root, cwd);
  if (!command && globals.some((value) => ['--version', '--help'].includes(value))) {
    return { command, args };
  }
  assertNoGitBuiltinSideEffect(command, args);
  assertNoGitExecutionOrOutputFlags(command, args);
  assertNoKnownGitMutation(command, args);
  assertNoImplicitGitHelper(command, args, {
    root,
    cwd,
    pagerDisabled,
  });
  if (
    ['diff', 'show', 'log', 'diff-tree', 'blame'].includes(command) &&
    gitArgumentHas(args, ['--ext-diff', '--textconv', '--output', '-o'])
  ) {
    throw new Error(`git ${command} helper/output mode 无 task state 时禁止。`);
  }
  if (command === 'cat-file') {
    if (gitArgumentHas(args, ['--filters', '--textconv'])) {
      throw new Error('git cat-file filters/textconv 可执行 helper，无 task state 时禁止。');
    }
    return { command, args };
  }
  if (command === 'branch') {
    if (isReadOnlyBranchArgs(args)) return { command, args };
    throw new Error('git branch mutation 需先建立 task contract。');
  }
  if (command === 'tag') {
    if (isReadOnlyTagArgs(args)) return { command, args };
    throw new Error('git tag mutation 需先建立 task contract。');
  }
  if (command === 'worktree') {
    if (
      args[0] === 'list' &&
      args.slice(1).every((value) =>
        ['--porcelain', '-v', '--verbose', '-z'].includes(value) ||
        value.startsWith('--expire='))
    ) {
      return { command, args };
    }
    throw new Error('git worktree mutation 需先建立 task contract。');
  }
  if (command === 'config') {
    if (isReadOnlyConfigArgs(args)) return { command, args };
    throw new Error('git config write/edit 需先建立 task contract。');
  }
  if (command === 'remote') {
    if (isReadOnlyRemoteArgs(args)) return { command, args };
    throw new Error('git remote mutation 需先建立 task contract。');
  }
  if (command === 'symbolic-ref') {
    if (isReadOnlySymbolicRefArgs(args)) return { command, args };
    throw new Error('git symbolic-ref mutation 需先建立 task contract。');
  }
  if (command === 'notes') {
    if (
      ['list', 'show', 'get-ref'].includes(String(args[0] || '')) &&
      !gitArgumentHas(args, ['--ext-diff', '--textconv'])
    ) {
      return { command, args };
    }
    throw new Error('git notes mutation/helper mode 需先建立 task contract。');
  }
  if (command === 'replace') {
    if (
      args.length === 0 ||
      args[0] === '-l' ||
      args[0] === '--list' ||
      args[0]?.startsWith('--list=')
    ) {
      return { command, args };
    }
    throw new Error('git replace mutation 需先建立 task contract。');
  }
  if (command === 'sparse-checkout') {
    if (args[0] === 'list' && args.length === 1) return { command, args };
    throw new Error('git sparse-checkout mutation 需先建立 task contract。');
  }
  if (command === 'submodule') {
    if (args[0] === 'status') return { command, args };
    throw new Error('git submodule mutation/helper mode 需先建立 task contract。');
  }
  if (command === 'stash') {
    if (
      ['list', 'show'].includes(String(args[0] || '')) &&
      !gitArgumentHas(args, ['--ext-diff', '--textconv'])
    ) {
      return { command, args };
    }
    throw new Error('git stash mutation 需先建立 task contract。');
  }
  if (command === 'hash-object') {
    if (gitArgumentHas(args, ['-w', '--path', '--filters'])) {
      throw new Error('git hash-object write/filter mode 无 task state 时禁止。');
    }
    return { command, args };
  }
  if (command === 'merge-tree') {
    if (args[0] === '--trivial-merge' && args.length === 4) {
      return { command, args };
    }
    throw new Error('git merge-tree 默认 write-tree 语义会写 object store；仅允许显式 --trivial-merge 三树模式。');
  }
  if (
    command === 'format-patch' &&
    args.includes('--stdout') &&
    !gitArgumentHas(args, ['--output-directory', '-o'])
  ) {
    return { command, args };
  }
  if (command === 'format-patch') {
    throw new Error('git format-patch 必须显式 --stdout，禁止生成文件。');
  }
  if (
    command === 'archive' &&
    !gitArgumentHas(args, ['--output', '-o', '--remote', '--exec', '--format'])
  ) {
    return { command, args };
  }
  if (command === 'archive') {
    throw new Error('git archive output/remote/custom-helper mode 需先建立 task contract。');
  }
  if (command === 'bundle' && ['list-heads', 'verify'].includes(String(args[0] || ''))) {
    return { command, args };
  }
  if (command === 'bundle') {
    throw new Error('git bundle create/unbundle 会写文件或 refs；需先建立 task contract。');
  }
  const alias = command ? configuredGitAlias(command, cwd) : null;
  if (alias) {
    throw new Error(`git ${command} 由有效 alias 配置执行（${alias}）；无 task state 时禁止。`);
  }
  const externalHelper = externalGitSubcommandHelper(command, cwd);
  if (externalHelper) {
    throw new Error(
      `git ${command} 会执行外部 subcommand helper ${externalHelper}；无 task state 时禁止。`,
    );
  }
  return { command, args };
}

function assertSafeGitCommand(tokens, state) {
  const { globals, configOverrides, command, args } = gitSubcommand(tokens);
  for (const override of configOverrides) {
    assertSafeGitConfigOverride(override.value, override.source);
  }
  assertNoGitBuiltinSideEffect(command, args, { hasActiveState: true });
  if (command === 'config' && !isReadOnlyConfigArgs(args)) {
    throw new Error('活动 task 只允许只读 git config 查询；配置写入或 editor 执行已拒绝。');
  }
  const scopeOverride = globals.find((value) =>
    /^(?:--git-dir|--work-tree|--namespace)(?:=|$)/i.test(value));
  const loweredArgs = args.map((value) => String(value).toLowerCase());
  const restoreStagesOnly =
    command === 'restore' &&
    args.some((value) => value === '--staged' || value === '-S') &&
    !args.some((value) => value === '--worktree' || value === '-W');
  const destructive =
    (command === 'reset' && loweredArgs.some((value) =>
      ['--hard', '--merge', '--keep'].includes(value))) ||
    command === 'clean' ||
    (command === 'checkout' && (
      loweredArgs.includes('-f') ||
      loweredArgs.includes('--force') ||
      loweredArgs.includes('--')
    )) ||
    (command === 'restore' && !restoreStagesOnly) ||
    (command === 'branch' && loweredArgs.some((value) => value === '-d')) ||
    (command === 'worktree' && ['remove', 'prune'].includes(loweredArgs[0])) ||
    (command === 'stash' && ['drop', 'clear'].includes(loweredArgs[0])) ||
    (command === 'reflog' && loweredArgs[0] === 'expire') ||
    (command === 'rebase' && loweredArgs.some((value) =>
      value === '--exec' || value.startsWith('--exec=')));
  if (destructive) {
    throw new Error(`git ${command} 请求会丢弃、删除或重写本地状态，已拒绝。`);
  }
  if (
    command === 'hash-object' &&
    gitArgumentHas(args, ['-w', '--path', '--filters'])
  ) {
    throw new Error('git hash-object write/filter mode 会写 object store 或执行 attribute helper，已拒绝。');
  }
  const changesWorktree = new Set([
    'am', 'apply', 'checkout', 'cherry-pick', 'merge', 'mv',
    'rebase', 'reset', 'restore', 'revert', 'switch', 'worktree',
  ]);
  if (scopeOverride && (command === 'push' || changesWorktree.has(command))) {
    throw new Error(`git ${scopeOverride} 与文件修改/GitHub 写入组合会绕过当前 worktree scope，已拒绝。`);
  }
  if (command === 'push') {
    const allowedOptions = new Set(['-u', '--set-upstream', '--porcelain', '--dry-run']);
    const positional = args.filter((arg) => !arg.startsWith('-'));
    if (
      args.some((arg) => arg.startsWith('-') && !allowedOptions.has(arg)) ||
      positional.length !== 2 ||
      positional[0] !== 'origin' ||
      positional[1] !== state.branch ||
      positional.some((arg) => arg.includes(':'))
    ) {
      throw new Error(`push 必须显式使用 git push [-u] origin ${state.branch}，且不得使用 refspec/force/delete/all/tags。`);
    }
    state.githubWrite = true;
  }
  if (command === 'diff') {
    const outputIndex = args.findIndex((value) => value === '--output');
    const inlineOutput = args.find((value) => value.startsWith('--output='));
    const outputTarget = inlineOutput?.slice('--output='.length) ||
      (outputIndex >= 0 ? args[outputIndex + 1] : null);
    if (outputTarget) assertTaskWriteTarget(outputTarget, state);
  }
  if ([
    'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'commit',
    'fetch', 'merge', 'mv', 'rebase', 'revert', 'switch', 'tag', 'worktree',
  ].includes(command) || command === 'push') {
    state.forceLiveCheck = true;
  }
}

function assertNoRepoOverride(tokens) {
  if (tokens.some((value) => /^(?:-R|--repo)(?:=|$)/i.test(value))) {
    throw new Error('GitHub 命令不得用 --repo/-R 改写当前仓库。');
  }
}

function assertGhApiReadOnly(values) {
  if (values.some((value) =>
    /^-X/i.test(value) ||
    /^-[fF](?:=|$|.)/.test(value) ||
    /^(?:--method|--field|--raw-field|--input)(?:=|$)/i.test(value))) {
    throw new Error('gh api 只允许无字段、无自定义 method 的 GET。');
  }
}

function isSafeGhRead(tokens) {
  const area = String(tokens[1] || '').toLowerCase();
  const action = String(tokens[2] || '').toLowerCase();
  if (area === 'auth' && action === 'status') return true;
  if (area === 'repo' && action === 'view') return true;
  if (area === 'issue' && ['view', 'list', 'status'].includes(action)) return true;
  if (area === 'pr' && ['view', 'list', 'checks', 'status', 'diff'].includes(action)) return true;
  if (area === 'run' && ['view', 'list', 'watch'].includes(action)) return true;
  if (area === 'workflow' && ['view', 'list'].includes(action)) return true;
  if (area === 'api') {
    assertGhApiReadOnly(tokens.slice(2));
    return true;
  }
  return false;
}

function assertSafeGhCommand(tokens, state) {
  const area = String(tokens[1] || '').toLowerCase();
  const action = String(tokens[2] || '').toLowerCase();
  const rest = tokens.slice(3);
  if (isSafeGhRead(tokens)) return;
  assertNoRepoOverride(tokens);
  if (area === 'issue') {
    if (state.mode !== 'governed' || action !== 'comment') {
      throw new Error(`gh issue ${action || '<missing>'} 不允许。`);
    }
    if (Number(rest[0]) !== state.issue) {
      throw new Error(`GitHub 写操作只能指向活动 Issue #${state.issue}。`);
    }
    if (rest.some((value) => /^(?:--delete-last|--edit-last|--web)$/i.test(value))) {
      throw new Error('活动任务只允许新增 Issue 评论，不允许编辑/删除既有评论。');
    }
    state.forceLiveCheck = true;
    state.githubWrite = true;
    return;
  }
  if (area === 'pr') {
    if (['view', 'list', 'checks', 'status', 'diff'].includes(action)) return;
    if (state.mode === 'governed' && action === 'create') {
      const headIndex = rest.findIndex((value) => value === '--head' || value.startsWith('--head='));
      const head = headIndex < 0 ? null : rest[headIndex].includes('=') ? rest[headIndex].split('=').slice(1).join('=') : rest[headIndex + 1];
      const baseIndex = rest.findIndex((value) => value === '--base' || value.startsWith('--base='));
      const base = baseIndex < 0 ? null : rest[baseIndex].includes('=') ? rest[baseIndex].split('=').slice(1).join('=') : rest[baseIndex + 1];
      if (head && head !== state.branch) throw new Error(`PR --head 必须是活动分支 ${state.branch}。`);
      if (base && !/^(?:master|main)$/.test(base)) throw new Error('PR --base 必须是 master/main。');
      state.forceLiveCheck = true;
      state.githubWrite = true;
      return;
    }
    throw new Error(`gh pr ${action || '<missing>'} 不允许；PR 状态变更须走独立授权。`);
  }
  if (area === 'api') {
    assertGhApiReadOnly(rest.concat(action));
    return;
  }
  throw new Error(`gh ${area || '<missing>'} ${action || ''} 不在任务允许列表。`);
}

function isPathInside(parent, candidate, options = {}) {
  const relative = path.relative(parent, candidate);
  if (!relative) return options.allowSame === true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function executableBasename(value) {
  const raw = String(value || '');
  return (raw.includes('\\') ? path.win32.basename(raw) : path.basename(raw)).toLowerCase();
}

function executableHasExplicitPath(value) {
  const raw = String(value || '');
  return path.isAbsolute(raw) || path.win32.isAbsolute(raw) || /[\\/]/.test(raw);
}

function executableCandidates(name) {
  if (process.platform !== 'win32') return [name];
  if (/\.[a-z0-9]+$/i.test(name)) return [name];
  const extensions = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`)];
}

function pathExecutableIdentity(name) {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const candidateName of executableCandidates(name)) {
      const candidate = path.join(directory, candidateName);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return { dev: stat.dev, ino: stat.ino, path: candidate };
      } catch {
        // Continue through PATH exactly as the shell would.
      }
    }
  }
  return null;
}

function assertTrustedExecutablePath(value, cwd = process.cwd()) {
  const raw = String(value || '');
  if (!executableHasExplicitPath(raw)) return;
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(raw) && process.platform !== 'win32') {
    throw new Error(`显式 executable ${raw} 不是当前平台可验证路径。`);
  }
  const explicit = path.resolve(cwd, raw);
  let explicitStat;
  try {
    explicitStat = fs.statSync(explicit);
  } catch {
    throw new Error(`显式 executable ${raw} 不存在或不可验证。`);
  }
  const pathEntry = pathExecutableIdentity(executableBasename(raw));
  if (
    !explicitStat.isFile() ||
    !pathEntry ||
    explicitStat.dev !== pathEntry.dev ||
    explicitStat.ino !== pathEntry.ino
  ) {
    throw new Error(
      `显式 executable ${raw} 与当前 PATH 同名入口不是同一物理对象，拒绝 basename 冒充。`,
    );
  }
}

const TRUSTED_NODE_SCRIPTS = new Set([
  'scripts/agent-preflight.cjs',
  'scripts/agent-preflight.selftest.cjs',
  'scripts/build-discipline/run-all.cjs',
  'scripts/build-discipline/selftest.cjs',
  'scripts/check-document-drift.cjs',
  'scripts/check-document-drift.selftest.cjs',
  'scripts/check-no-secrets.cjs',
  'scripts/check-no-secrets.selftest.cjs',
  'scripts/claude-task.cjs',
  'scripts/claude-task.selftest.cjs',
  'scripts/gc-worktrees.selftest.cjs',
  'scripts/issue-handoff/check-pr-body.cjs',
  'scripts/issue-handoff/check-pr-body.selftest.cjs',
  'scripts/offline-github-governance.cjs',
  'scripts/offline-github-governance.selftest.cjs',
]);

function repositoryRelativePhysicalFile(root, cwd, value) {
  const physicalRoot = resolvePhysicalPath(process.cwd(), root);
  const physicalCwd = resolvePhysicalPath(physicalRoot, cwd);
  const target = resolvePhysicalPath(physicalCwd, value);
  if (!isPathInside(physicalRoot, target)) {
    throw new Error(`运行入口 ${value} 位于当前仓库之外。`);
  }
  assertNotGitMetadataTarget(physicalRoot, value, target);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`运行入口 ${value} 不存在。`);
  }
  if (!stat.isFile()) throw new Error(`运行入口 ${value} 不是普通文件。`);
  return {
    target,
    relative: toPosix(path.relative(physicalRoot, target)),
    root: physicalRoot,
    cwd: physicalCwd,
  };
}

function assertSafeNodeCommand(tokens, root = process.cwd(), cwd = root, options = {}) {
  assertTrustedExecutablePath(tokens[0], cwd);
  const args = tokens.slice(1).map(String);
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    return { kind: 'version', executable: String(tokens[0] || '') };
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    return { kind: 'help', executable: String(tokens[0] || '') };
  }
  if (['--check', '-c'].includes(args[0])) {
    if (args.length !== 2 || args[1].startsWith('-')) {
      throw new Error('node --check 只允许一个仓库内明确文件。');
    }
    const entry = repositoryRelativePhysicalFile(root, cwd, args[1]);
    return { kind: 'check', entries: [entry.relative], executable: String(tokens[0] || '') };
  }
  if (
    ['-e', '--eval', '-p', '--print'].includes(args[0]) ||
    /^-[ep]+$/.test(args[0])
  ) {
    const code = String(args[1] || '');
    if (
      /(?:writeFile|appendFile|truncate|createWriteStream|copyFile|rename|unlink|rmSync|mkdir|child_process|execSync|spawnSync|process\.dlopen|fetch\s*\()/i
        .test(code)
    ) {
      throw new Error('Node inline code 包含可证明的文件、进程、loader 或外部写入。');
    }
    return { kind: 'inline-diagnostic', executable: String(tokens[0] || '') };
  }
  if (args[0] === '--test') {
    if (args.some((value) =>
      /^(?:--require|--import|--loader|--test-reporter|--experimental-loader)(?:=|$)/i
        .test(value))) {
      throw new Error('Node test runtime loader/reporter override 无 task state 时禁止。');
    }
    for (const value of args.slice(1)) {
      if (value.startsWith('-') || !/[\\/]/.test(value)) continue;
      repositoryRelativePhysicalFile(root, cwd, value);
    }
    return { kind: 'test', executable: String(tokens[0] || '') };
  }
  if (
    args.length === 0 ||
    args[0].startsWith('-') ||
    args.some((value, index) =>
      index === 0 &&
      /^(?:--require|-r|--import|--loader|--experimental-loader|--inspect|--inspect-brk|--debug|--watch)(?:=|$)|^-r.+/i
        .test(value))
  ) {
    throw new Error('Node interactive/preload/debug/runtime loader flags 无 task state 时禁止。');
  }
  const entry = repositoryRelativePhysicalFile(root, cwd, args[0]);
  if (
    /(?:^|\/)(?:start|deploy|release|migrate|seed|reset)[^/]*(?:prod|production)[^/]*\.[cm]?[jt]s$/i
      .test(entry.relative)
  ) {
    throw new Error(`Node 入口 ${entry.relative} 是显式生产/迁移生命周期脚本。`);
  }
  if (
    entry.relative === 'scripts/claude-task.cjs' &&
    String(args[1] || '').toLowerCase() === 'github-write' &&
    !options.hasActiveState
  ) {
    throw new Error('github-write 必须由活动 task state 的完整 writer wrapper 验证。');
  }
  if (!TRUSTED_NODE_SCRIPTS.has(entry.relative)) {
    throw new Error(
      `Node 入口 ${entry.relative} 是未登记的可执行脚本；无 task state 时禁止执行 helper。`,
    );
  }
  return {
    kind: 'trusted-governance',
    entries: [entry.relative],
    executable: String(tokens[0] || ''),
  };
}

function npmLifecycleHasWriteCapability(name) {
  const normalized = String(name || '').toLowerCase();
  const withoutHookPrefix = normalized.replace(/^(?:pre|post)/, '');
  const segments = withoutHookPrefix.split(/[:/_-]+/).filter(Boolean);
  const riskySegments = new Set([
    'deploy',
    'migrate',
    'migration',
    'publish',
    'release',
    'reset',
    'restart',
    'seed',
    'serve',
    'start',
    'stop',
  ]);
  return segments.some((segment) => riskySegments.has(segment));
}

// Mirrors npm 10.9.8 lib/utils/cmd-list.js: camelCase conversion, exact
// commands, direct aliases, unique abbreviations, then alias dereferencing.
const NPM_COMMANDS = [
  'access',
  'adduser',
  'audit',
  'bugs',
  'cache',
  'ci',
  'completion',
  'config',
  'dedupe',
  'deprecate',
  'diff',
  'dist-tag',
  'docs',
  'doctor',
  'edit',
  'exec',
  'explain',
  'explore',
  'find-dupes',
  'fund',
  'get',
  'help',
  'help-search',
  'hook',
  'init',
  'install',
  'install-ci-test',
  'install-test',
  'link',
  'll',
  'login',
  'logout',
  'ls',
  'org',
  'outdated',
  'owner',
  'pack',
  'ping',
  'pkg',
  'prefix',
  'profile',
  'prune',
  'publish',
  'query',
  'rebuild',
  'repo',
  'restart',
  'root',
  'run-script',
  'sbom',
  'search',
  'set',
  'shrinkwrap',
  'star',
  'stars',
  'start',
  'stop',
  'team',
  'test',
  'token',
  'uninstall',
  'unpublish',
  'unstar',
  'update',
  'version',
  'view',
  'whoami',
];
const NPM_COMMAND_SET = new Set(NPM_COMMANDS);
const NPM_COMMAND_ALIASES = new Map([
  ['author', 'owner'],
  ['home', 'docs'],
  ['issues', 'bugs'],
  ['info', 'view'],
  ['show', 'view'],
  ['find', 'search'],
  ['add', 'install'],
  ['unlink', 'uninstall'],
  ['remove', 'uninstall'],
  ['rm', 'uninstall'],
  ['r', 'uninstall'],
  ['un', 'uninstall'],
  ['rb', 'rebuild'],
  ['list', 'ls'],
  ['ln', 'link'],
  ['create', 'init'],
  ['i', 'install'],
  ['it', 'install-test'],
  ['cit', 'install-ci-test'],
  ['up', 'update'],
  ['c', 'config'],
  ['s', 'search'],
  ['se', 'search'],
  ['tst', 'test'],
  ['t', 'test'],
  ['ddp', 'dedupe'],
  ['v', 'view'],
  ['run', 'run-script'],
  ['clean-install', 'ci'],
  ['clean-install-test', 'install-ci-test'],
  ['x', 'exec'],
  ['why', 'explain'],
  ['la', 'll'],
  ['verison', 'version'],
  ['ic', 'ci'],
  ['innit', 'init'],
  ['in', 'install'],
  ['ins', 'install'],
  ['inst', 'install'],
  ['insta', 'install'],
  ['instal', 'install'],
  ['isnt', 'install'],
  ['isnta', 'install'],
  ['isntal', 'install'],
  ['isntall', 'install'],
  ['install-clean', 'ci'],
  ['isntall-clean', 'ci'],
  ['hlep', 'help'],
  ['dist-tags', 'dist-tag'],
  ['upgrade', 'update'],
  ['udpate', 'update'],
  ['rum', 'run-script'],
  ['sit', 'install-ci-test'],
  ['urn', 'run-script'],
  ['ogr', 'org'],
  ['add-user', 'adduser'],
]);

function buildNpmCommandAbbreviations(values) {
  const sorted = [...values].map(String).sort();
  const abbreviations = new Map();
  let previous = '';
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1] || '';
    if (current === next) continue;
    let nextMatches = true;
    let previousMatches = true;
    let length = 0;
    for (; length < current.length; length += 1) {
      const character = current.charAt(length);
      nextMatches = nextMatches && character === next.charAt(length);
      previousMatches = previousMatches && character === previous.charAt(length);
      if (!nextMatches && !previousMatches) {
        length += 1;
        break;
      }
    }
    previous = current;
    if (length === current.length) {
      abbreviations.set(current, current);
      continue;
    }
    for (
      let abbreviation = current.slice(0, length);
      length <= current.length;
      length += 1
    ) {
      abbreviations.set(abbreviation, current);
      abbreviation += current.charAt(length);
    }
  }
  return abbreviations;
}

const NPM_COMMAND_ABBREVIATIONS = buildNpmCommandAbbreviations([
  ...NPM_COMMANDS,
  ...NPM_COMMAND_ALIASES.keys(),
]);

function canonicalNpmCommand(name) {
  const normalized = String(name || '')
    .replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)
    .toLowerCase();
  if (!normalized) return null;
  if (NPM_COMMAND_SET.has(normalized)) return normalized;
  let resolved = NPM_COMMAND_ALIASES.get(normalized) ||
    NPM_COMMAND_ABBREVIATIONS.get(normalized);
  const seen = new Set();
  while (resolved && NPM_COMMAND_ALIASES.has(resolved) && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = NPM_COMMAND_ALIASES.get(resolved);
  }
  return NPM_COMMAND_SET.has(resolved) ? resolved : null;
}

const NPM_COMMAND_CAPABILITY_ENTRIES = [
  ['access', 'action-sensitive'],
  ['adduser', 'external-write'],
  ['audit', 'action-sensitive'],
  ['bugs', 'read'],
  ['cache', 'action-sensitive'],
  ['ci', 'local-write'],
  ['completion', 'read'],
  ['config', 'action-sensitive'],
  ['dedupe', 'local-write'],
  ['deprecate', 'external-write'],
  ['diff', 'read'],
  ['dist-tag', 'action-sensitive'],
  ['docs', 'read'],
  ['doctor', 'local-write'],
  ['edit', 'local-write'],
  ['exec', 'local-write'],
  ['explain', 'read'],
  ['explore', 'local-write'],
  ['find-dupes', 'read'],
  ['fund', 'read'],
  ['get', 'read'],
  ['help', 'read'],
  ['help-search', 'read'],
  ['hook', 'action-sensitive'],
  ['init', 'local-write'],
  ['install', 'local-write'],
  ['install-ci-test', 'local-write'],
  ['install-test', 'local-write'],
  ['link', 'local-write'],
  ['ll', 'read'],
  ['login', 'external-write'],
  ['logout', 'external-write'],
  ['ls', 'read'],
  ['org', 'action-sensitive'],
  ['outdated', 'read'],
  ['owner', 'action-sensitive'],
  ['pack', 'local-write'],
  ['ping', 'read'],
  ['pkg', 'action-sensitive'],
  ['prefix', 'read'],
  ['profile', 'action-sensitive'],
  ['prune', 'local-write'],
  ['publish', 'external-write'],
  ['query', 'read'],
  ['rebuild', 'local-write'],
  ['repo', 'read'],
  ['restart', 'lifecycle'],
  ['root', 'read'],
  ['run-script', 'lifecycle'],
  ['sbom', 'read'],
  ['search', 'read'],
  ['set', 'local-write'],
  ['shrinkwrap', 'local-write'],
  ['star', 'external-write'],
  ['stars', 'read'],
  ['start', 'lifecycle'],
  ['stop', 'lifecycle'],
  ['team', 'action-sensitive'],
  ['test', 'lifecycle'],
  ['token', 'action-sensitive'],
  ['uninstall', 'local-write'],
  ['unpublish', 'external-write'],
  ['unstar', 'external-write'],
  ['update', 'local-write'],
  ['version', 'local-write'],
  ['view', 'read'],
  ['whoami', 'read'],
];

const NPM_COMMAND_CAPABILITIES = new Map(NPM_COMMAND_CAPABILITY_ENTRIES);
const npmPolicyNames = NPM_COMMAND_CAPABILITY_ENTRIES.map(([name]) => name);
const npmPolicyMissing = NPM_COMMANDS.filter(
  (name) => !NPM_COMMAND_CAPABILITIES.has(name),
);
const npmPolicyExtra = npmPolicyNames.filter(
  (name) => !NPM_COMMAND_SET.has(name),
);
if (
  npmPolicyNames.length !== NPM_COMMANDS.length ||
  new Set(npmPolicyNames).size !== npmPolicyNames.length ||
  npmPolicyMissing.length > 0 ||
  npmPolicyExtra.length > 0
) {
  throw new Error(
    'npm command capability policy must cover every canonical command exactly once: ' +
    `missing=${npmPolicyMissing.join(',') || '<none>'}; ` +
    `extra=${npmPolicyExtra.join(',') || '<none>'}`,
  );
}

const NPM_ACTION_CAPABILITIES = new Map([
  ['access', {
    read: new Set(['get', 'list', 'ls']),
    'external-write': new Set(['grant', 'revoke', 'set']),
  }],
  ['audit', {
    read: new Set(['', 'signatures']),
    'local-write': new Set(['fix']),
  }],
  ['cache', {
    read: new Set(['ls']),
    'local-write': new Set(['add', 'check', 'clean', 'clear', 'rm', 'verify']),
  }],
  ['config', {
    read: new Set(['get', 'list', 'ls']),
    'local-write': new Set(['delete', 'del', 'edit', 'fix', 'rm', 'set']),
  }],
  ['dist-tag', {
    read: new Set(['', 'list', 'ls']),
    'external-write': new Set(['add', 'remove', 'rm']),
  }],
  ['hook', {
    read: new Set(['list', 'ls']),
    'external-write': new Set(['add', 'remove', 'rm', 'up', 'update']),
  }],
  ['org', {
    read: new Set(['list', 'ls']),
    'external-write': new Set(['add', 'remove', 'rm', 'set']),
  }],
  ['owner', {
    read: new Set(['list', 'ls']),
    'external-write': new Set(['add', 'remove', 'rm']),
  }],
  ['pkg', {
    read: new Set(['get']),
    'local-write': new Set(['delete', 'fix', 'set']),
  }],
  ['profile', {
    read: new Set(['get']),
    'external-write': new Set([
      'disable-2fa',
      'disable-tfa',
      'disable2fa',
      'disabletfa',
      'enable-2fa',
      'enable-tfa',
      'enable2fa',
      'enabletfa',
      'set',
    ]),
  }],
  ['team', {
    read: new Set(['list', 'ls']),
    'external-write': new Set(['add', 'create', 'destroy', 'remove', 'rm']),
  }],
  ['token', {
    read: new Set(['', 'list', 'ls']),
    'external-write': new Set(['create', 'delete', 'remove', 'revoke', 'rm']),
  }],
]);

const npmActionPolicyMissing = NPM_COMMAND_CAPABILITY_ENTRIES
  .filter(([, capability]) => capability === 'action-sensitive')
  .map(([name]) => name)
  .filter((name) => !NPM_ACTION_CAPABILITIES.has(name));
const npmActionPolicyExtra = [...NPM_ACTION_CAPABILITIES.keys()]
  .filter((name) => NPM_COMMAND_CAPABILITIES.get(name) !== 'action-sensitive');
if (npmActionPolicyMissing.length > 0 || npmActionPolicyExtra.length > 0) {
  throw new Error(
    'npm action capability policy must match action-sensitive commands: ' +
    `missing=${npmActionPolicyMissing.join(',') || '<none>'}; ` +
    `extra=${npmActionPolicyExtra.join(',') || '<none>'}`,
  );
}

function npmActionCapability(command, commandOperands, optionNames) {
  if (command === 'audit' && optionNames.has('--fix')) return 'local-write';
  const action = String(commandOperands[0] || '').toLowerCase();
  const capabilities = NPM_ACTION_CAPABILITIES.get(command);
  if (!capabilities) return null;
  for (const capability of ['read', 'local-write', 'external-write']) {
    if (capabilities[capability]?.has(action)) return capability;
  }
  return null;
}

const NPM_PATH_OPTIONS = new Set([
  '--prefix',
  '--config',
  '--userconfig',
  '--globalconfig',
  '--cache',
  '--cwd',
  '--dir',
  '--root',
  '--project',
  '--setupfiles',
  '--globalsetup',
  '--require',
  '--import',
  '--loader',
  '-c',
]);

const NPM_OPTIONS_WITH_VALUE = new Set([
  ...NPM_PATH_OPTIONS,
  '--workspace',
  '-w',
  '--registry',
  '--loglevel',
  '--otp',
  '--scope',
  '--tag',
  '--location',
]);

function tokenizeNpmArgs(args) {
  const options = [];
  const positionals = [];
  let afterSeparator = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (!afterSeparator && value === '--') {
      afterSeparator = true;
      continue;
    }
    if (value.startsWith('--')) {
      const equalsIndex = value.indexOf('=');
      const name = (equalsIndex < 0 ? value : value.slice(0, equalsIndex)).toLowerCase();
      const inlineValue = equalsIndex < 0 ? null : value.slice(equalsIndex + 1);
      if (NPM_OPTIONS_WITH_VALUE.has(name)) {
        options.push({
          afterSeparator,
          name,
          raw: value,
          value: inlineValue === null ? String(args[index + 1] || '') : inlineValue,
        });
        if (inlineValue === null) index += 1;
      } else {
        options.push({ afterSeparator, name, raw: value, value: inlineValue });
      }
      continue;
    }
    if (value.startsWith('-') && value !== '-') {
      const name = value.slice(0, 2).toLowerCase();
      if (NPM_OPTIONS_WITH_VALUE.has(name)) {
        const attached = value.slice(2).replace(/^=/, '');
        options.push({
          afterSeparator,
          name,
          raw: value,
          value: attached || String(args[index + 1] || ''),
        });
        if (!attached) index += 1;
      } else {
        options.push({ afterSeparator, name: value.toLowerCase(), raw: value, value: null });
      }
      continue;
    }
    positionals.push({ afterSeparator, index, value });
  }
  return { options, positionals };
}

function assertSafeNpmCommand(tokens, root = process.cwd(), cwd = root, options = {}) {
  assertTrustedExecutablePath(tokens[0], cwd);
  const physicalRoot = resolvePhysicalPath(process.cwd(), root);
  const physicalCwd = resolvePhysicalPath(physicalRoot, cwd);
  if (!isPathInside(physicalRoot, physicalCwd, { allowSame: true })) {
    throw new Error('npm 只能在当前仓库物理边界内运行。');
  }
  assertNotGitMetadataTarget(physicalRoot, cwd, physicalCwd);
  const args = tokens.slice(1).map(String);
  if (args.length === 1 && ['--version', '-v', '--help', '-h'].includes(args[0])) {
    return { kind: 'diagnostic', executable: String(tokens[0] || '') };
  }
  const parsed = tokenizeNpmArgs(args);
  const optionPath = (option) => {
    const candidate = String(option.value || '');
    const trimmed = candidate.trim();
    if (
      trimmed.length >= 2 &&
      ['"', "'"].includes(trimmed[0]) &&
      trimmed.at(-1) === trimmed[0]
    ) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };
  for (const option of parsed.options) {
    if (NPM_PATH_OPTIONS.has(option.name)) {
      const candidate = optionPath(option);
      if (!candidate || candidate.startsWith('-')) {
        throw new Error(`npm option ${option.raw} 缺少可验证的仓库内路径。`);
      }
      if (/[$%*?\[\]{}]/.test(candidate) || candidate.startsWith('~')) {
        throw new Error(`npm option ${option.raw} 使用动态或通配路径，无法验证物理边界。`);
      }
      const target = resolvePhysicalPath(physicalCwd, candidate);
      assertNotGitMetadataTarget(physicalRoot, candidate, target);
      if (!isPathInside(physicalRoot, target, { allowSame: true })) {
        throw new Error(`npm option ${option.raw} 指向当前仓库之外。`);
      }
    }
  }
  const operands = parsed.positionals.map((entry) => entry.value);
  const command = canonicalNpmCommand(operands[0]);
  const commandOperands = operands.slice(1);
  const optionNames = new Set(parsed.options.map((option) => option.name));
  if (operands[0] && !command) {
    throw new Error(
      `npm command ${operands[0]} 不是当前 npm 可验证的命令、别名或唯一缩写。`,
    );
  }
  let capability = NPM_COMMAND_CAPABILITIES.get(command);
  if (capability === 'action-sensitive') {
    capability = npmActionCapability(command, commandOperands, optionNames);
    if (!capability) {
      throw new Error(
        `npm ${command} ${commandOperands[0] || '<missing>'} 没有可验证的副作用分类。`,
      );
    }
  } else if (!capability && command) {
    throw new Error(`npm ${command} 缺少显式 capability policy。`);
  }
  const lifecycle = command === 'run-script'
    ? String(commandOperands[0] || '').toLowerCase()
    : command;
  if (
    capability === 'lifecycle' &&
    npmLifecycleHasWriteCapability(lifecycle)
  ) {
    throw new Error(`npm lifecycle ${lifecycle} 是明确的部署、迁移、发布、重置或服务启动动作，已拒绝。`);
  }
  if (capability === 'external-write') {
    throw new Error(`npm ${command} 会修改 registry、account 或发布状态，已拒绝。`);
  }
  if (!options.hasActiveState && capability === 'local-write') {
    throw new Error(`npm ${command} 会写依赖、配置、缓存、包或外部 registry；需先建立 task contract。`);
  }
  return {
    kind: command || 'diagnostic',
    executable: String(tokens[0] || ''),
    forceLiveCheck: options.hasActiveState && capability === 'local-write',
  };
}

function assertSafeGeneralReadCommand(tokens, cwd = process.cwd()) {
  assertTrustedExecutablePath(tokens[0], cwd);
  const executable = executableBasename(tokens[0]);
  const args = tokens.slice(1).map(String);
  const alwaysRead = new Set([
    'pwd',
    'ls',
    'ls.exe',
    'grep',
    'grep.exe',
    'head',
    'tail',
    'wc',
    'stat',
    'shasum',
    'sha256sum',
    'sha1sum',
    'jq',
    'diff',
    'cmp',
    'uniq',
    'cut',
    'tr',
    'date',
    'uname',
    'which',
    'where',
    'basename',
    'dirname',
    'realpath',
    'readlink',
    'printf',
    'echo',
    'true',
    'false',
    'test',
    '[',
    'ps',
  ]);
  if (alwaysRead.has(executable)) return { kind: 'read', executable };
  if (executable === 'command' && ['-v', '-V'].includes(args[0]) && args.length >= 2) {
    return { kind: 'read', executable };
  }
  if (['rg', 'rg.exe', 'ripgrep'].includes(executable)) {
    if (args.some((value) =>
      /^(?:--pre|--pre-glob|--hostname-bin)(?:=|$)/.test(value))) {
      throw new Error('rg helper execution flags 无 task state 时禁止。');
    }
    return { kind: 'read', executable };
  }
  if (['sed', 'sed.exe'].includes(executable)) {
    if (args.some((value) =>
      /^--in-place(?:=|$)/.test(value) ||
      /^-[^-]*i[^-]*$/.test(value))) {
      throw new Error('sed in-place 会写文件，无 task state 时禁止。');
    }
    return { kind: 'read', executable };
  }
  if (['sort', 'sort.exe'].includes(executable)) {
    if (args.some((value) =>
      /^(?:-o|--output|--compress-program)(?:=|$)/.test(value) ||
      /^-o.+/.test(value))) {
      throw new Error('sort output/helper flags 无 task state 时禁止。');
    }
    return { kind: 'read', executable };
  }
  if (['find', 'find.exe'].includes(executable)) {
    if (args.some((value) =>
      /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/i.test(value))) {
      throw new Error('find execution/deletion/file-output actions 无 task state 时禁止。');
    }
    return { kind: 'read', executable };
  }
  const inlineCodeIndex = args.findIndex((value) =>
    ['-c', '-e', '--eval'].includes(String(value)));
  if (inlineCodeIndex >= 0) {
    const code = String(args[inlineCodeIndex + 1] || '');
    if (
      /(?:open\s*\([^)]*,\s*['"][wa+]|File\.write|writeFile|appendFile|system\s*\(|subprocess|os\.system|exec\s*\(|spawn\s*\(|unlink|remove\s*\(|mkdir|touch\b)/i
        .test(code) ||
      (['perl', 'perl.exe'].includes(executable) && /\bopen\b[\s\S]*>/i.test(code))
    ) {
      throw new Error(`${executable} inline code 包含可证明的文件或子进程写入。`);
    }
  }
  if (
    ['awk', 'gawk', 'mawk'].includes(executable) &&
    args.some((value) => /\bsystem\s*\(/i.test(String(value)))
  ) {
    throw new Error(`${executable} program 包含显式 system helper。`);
  }
  if (['npx', 'npx.cmd', 'npx.exe'].includes(executable)) {
    throw new Error('npx 会解析/下载包并写 npm cache 或依赖；需先建立 task contract。');
  }
  if (['xargs', 'xargs.exe'].includes(executable)) {
    const nestedExecutable = executableBasename(
      args.find((value) => !String(value).startsWith('-')) || '',
    );
    if ([
      'touch',
      'mkdir',
      'rm',
      'mv',
      'cp',
      'install',
      'git',
      'gh',
    ].includes(nestedExecutable)) {
      throw new Error(`xargs ${nestedExecutable} 是显式批量写入/外部操作。`);
    }
  }
  if (['make', 'gmake'].includes(executable)) {
    const fileIndex = args.findIndex((value) => ['-f', '--file', '--makefile'].includes(value));
    const inlineFile = args.find((value) =>
      /^(?:--file|--makefile)=/.test(String(value)));
    const makefile = inlineFile?.slice(inlineFile.indexOf('=') + 1) ||
      (fileIndex >= 0 ? args[fileIndex + 1] : null);
    if (makefile) {
      const target = resolvePhysicalPath(cwd, makefile);
      const root = repoRoot(cwd);
      if (!isPathInside(root, target)) {
        throw new Error(`makefile ${makefile} 位于当前仓库之外。`);
      }
    }
  }
  return { kind: 'local-command', executable };
}

function nodeRequestsGovernedAction(tokens) {
  return tokens.some((value, index) =>
    executableBasename(value) === 'claude-task.cjs' &&
    ['create-issues', 'github-write'].includes(
      String(tokens[index + 1] || '').toLowerCase(),
    ));
}

function shellMutationTargets(tokens) {
  const executable = path.basename(String(tokens[0] || '')).toLowerCase();
  const args = tokens.slice(1);
  const positional = args.filter((value) => !String(value).startsWith('-'));
  if (['touch', 'mkdir'].includes(executable)) {
    return positional;
  }
  if (['new-item', 'set-content', 'out-file'].includes(executable)) {
    return positional.slice(0, 1);
  }
  if (['rm', 'rmdir', 'unlink', 'del', 'erase', 'remove-item'].includes(executable)) {
    return positional;
  }
  if (['mv', 'move'].includes(executable)) {
    return positional;
  }
  if (['cp', 'copy', 'install'].includes(executable)) {
    return positional.slice(-1);
  }
  if (['tee', 'tee.exe'].includes(executable)) {
    return positional;
  }
  const targets = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (/^(?:\d*|&)>>?$/.test(tokens[index]) && !/^&\d$/.test(tokens[index + 1])) {
      targets.push(tokens[index + 1]);
    }
  }
  return targets;
}

function shellRedirectionTargets(segment) {
  const source = String(segment || '');
  const targets = [];
  const readWord = (start) => {
    let index = start;
    while (/\s/.test(source[index] || '')) index += 1;
    let value = '';
    let quote = null;
    let escaped = false;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (escaped) {
        value += character;
        escaped = false;
        continue;
      }
      if (character === '\\' && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (character === quote) {
          quote = null;
        } else {
          value += character;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (/[\s;&|]/.test(character)) break;
      value += character;
    }
    return { value, index };
  };
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character !== '>' || source[index + 1] === '(') continue;
    let targetIndex = index + 1;
    if (source[targetIndex] === '>' || source[targetIndex] === '|') targetIndex += 1;
    while (/\s/.test(source[targetIndex] || '')) targetIndex += 1;
    const descriptorForm = source[targetIndex] === '&';
    if (descriptorForm) {
      targetIndex += 1;
    }
    const target = readWord(targetIndex).value;
    if (!target) continue;
    if (descriptorForm && (/^\d+$/.test(target) || target === '-')) continue;
    targets.push(target);
  }
  return targets;
}

function assertNoSystemDestruction(tokens) {
  const executable = path.basename(String(tokens[0] || '')).toLowerCase();
  if ([
    'shutdown', 'reboot', 'halt', 'poweroff', 'mkfs', 'diskutil',
    'format', 'format.com',
  ].includes(executable)) {
    throw new Error(`${executable} 是明确的系统破坏性动作，已拒绝。`);
  }
  if (executable === 'dd' && tokens.slice(1).some((value) => /^of=/.test(value))) {
    throw new Error('dd 写设备/文件是明确的破坏性动作，已拒绝。');
  }
}

function assertNoRawGitHubWrite(tokens) {
  const executable = path.basename(String(tokens[0] || '')).toLowerCase();
  if (!['curl', 'curl.exe'].includes(executable)) return;
  const hasGitHubTarget = tokens.some((value) =>
    /https?:\/\/(?:api\.)?github\.com\//i.test(String(value)));
  const hasWriteSignal = tokens.some((value) =>
    /^(?:-d|--data|--data-raw|--data-binary|--data-ascii|--data-urlencode|-f|--form|--form-string|--json)(?:=|$)/i
      .test(String(value))) ||
    tokens.some((value) =>
      /^-T(?:.+)?$/.test(String(value)) ||
      /^--upload-file(?:=|$)/i.test(String(value))) ||
    tokens.some((value) =>
      /^(?:-x(?:post|put|patch|delete)|--request=(?:post|put|patch|delete))$/i
        .test(String(value))) ||
    tokens.some((value, index) =>
      /^(?:-x|--request)$/i.test(String(value)) &&
      /^(?:post|put|patch|delete)$/i.test(String(tokens[index + 1] || '')));
  if (hasGitHubTarget && hasWriteSignal) {
    throw new Error('GitHub HTTP 写入必须走受治理的 gh writer，不得用 curl 绕过。');
  }
}

function assertShellCommandSafety(command, state = null, root = process.cwd(), cwd = root) {
  const check = {
    ...(state || {}),
    root,
    cwd,
    forceLiveCheck: false,
    githubWrite: false,
  };
  const segments = splitShellCommandSegments(command);
  if (segments.length === 0) throw new Error('命令为空。');
  for (const segment of segments) {
    const tokens = unwrapCommandTokens(
      commandTokens(segment),
      { hasActiveState: Boolean(state) },
    );
    if (tokens.length === 0) continue;
    const executable = executableBasename(tokens[0]);
    const targets = [
      ...new Set([
        ...shellMutationTargets(tokens),
        ...shellRedirectionTargets(segment),
      ].filter((target) => !isNullDeviceTarget(target))),
    ];
    if (!state && targets.length > 0) {
      throw new Error(`${executable} 会修改文件，需先建立 task contract。`);
    }
    for (const target of targets) assertTaskWriteTarget(target, check);
    if (targets.length > 0) check.forceLiveCheck = true;
    if (!state) assertTrustedExecutablePath(tokens[0], cwd);

    if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'pwsh'].includes(executable)) {
      assertTrustedExecutablePath(tokens[0], cwd);
      const commandIndex = tokens.findIndex((value) =>
        /^(?:-c|--command)$/i.test(String(value)));
      if (commandIndex >= 0 && tokens[commandIndex + 1]) {
        if (!state && commandIndex !== 1) {
          throw new Error(`${executable} 只允许精确 -c/--command 递归分类。`);
        }
        const nested = assertShellCommandSafety(
          String(tokens[commandIndex + 1]),
          state,
          root,
          cwd,
        );
        check.forceLiveCheck ||= nested.forceLiveCheck;
        check.githubWrite ||= nested.githubWrite;
        continue;
      }
      if (!state) throw new Error(`${executable} 脚本/交互模式无 task state 时禁止。`);
    }
    assertNoSystemDestruction(tokens);
    assertNoRawGitHubWrite(tokens);
    if (['git', 'git.exe'].includes(executable)) {
      const parsed = gitSubcommand(tokens);
      if (!state && parsed.command === 'worktree' && parsed.args[0] === 'add') {
        assertTrustedExecutablePath(tokens[0], cwd);
        assertSafeWorktreeAdd(parsed.args, { root, cwd });
      } else if (!state) {
        assertSafeGitReadCommand(tokens, { root, cwd });
      } else {
        assertSafeGitCommand(tokens, check);
      }
    } else if (['gh', 'gh.exe'].includes(executable)) {
      if (!state && isSafeGhRead(tokens)) continue;
      assertSafeGhCommand(tokens, check);
    } else if (['node', 'node.exe'].includes(executable)) {
      if (!state || nodeRequestsGovernedAction(tokens)) {
        assertSafeNodeCommand(tokens, root, cwd, { hasActiveState: Boolean(state) });
      }
    } else if (['npm', 'npm.cmd', 'npm.exe'].includes(executable)) {
      const npmCheck = assertSafeNpmCommand(
        tokens,
        root,
        cwd,
        { hasActiveState: Boolean(state) },
      );
      check.forceLiveCheck ||= Boolean(npmCheck.forceLiveCheck);
    } else if (!state) {
      assertSafeGeneralReadCommand(tokens, cwd);
    }
  }
  return check;
}

function isSafeBeforeStartShell(command, root = process.cwd(), cwd = root) {
  try {
    assertShellCommandSafety(command, null, root, cwd);
    return true;
  } catch {
    return false;
  }
}

function shellRequestsWorktreeAdd(command) {
  try {
    return splitShellCommandSegments(command).some((segment) => {
      const tokens = unwrapCommandTokens(commandTokens(segment));
      if (!['git', 'git.exe'].includes(executableBasename(tokens[0]))) return false;
      const parsed = gitSubcommand(tokens);
      return parsed.command === 'worktree' && parsed.args[0] === 'add';
    });
  } catch {
    return false;
  }
}

function commandShellGuard() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const command = String(input.tool_input?.command || '').trim();
  const safeBeforeStart = isSafeBeforeStartShell(command, root, input.cwd || root);
  if (safeBeforeStart && !shellRequestsWorktreeAdd(command)) return;
  const snapshot = inspectTaskState(root);

  if (snapshot.kind !== 'valid') {
    if (safeBeforeStart) return;
    process.stderr.write(
      'COREONE shell blocked: this command is a live-check, Git/GitHub write, explicit file mutation, ' +
      `external side effect, or destructive action, and ${inactiveTaskStateMessage(snapshot)}.`,
    );
    process.exitCode = 2;
    return;
  }

  const active = { file: snapshot.file, state: snapshot.state };
  try {
    const check = assertShellCommandSafety(
      command,
      active.state,
      root,
      input.cwd || root,
    );
    assertActiveState(root, active, { force: check.forceLiveCheck });
    if (check.forceLiveCheck) assertOwnedChanges(root, active.state);
    if (check.githubWrite) {
      throw new Error(
        'GitHub 写入必须把真实命令放进完整执行锁：' +
        'node scripts/claude-task.cjs github-write -- <原 git/gh 命令>；' +
        '禁止由 PreToolUse 只取得 slot 后再脱锁执行。',
      );
    }
  } catch (error) {
    process.stderr.write(`COREONE shell blocked: ${error.message}`);
    process.exitCode = 2;
  }
}

function commandGitHubWrite(argv) {
  const tokens = argv[0] === '--' ? argv.slice(1) : argv;
  const executable = String(tokens[0] || '').toLowerCase();
  if (!['git', 'git.exe', 'gh', 'gh.exe'].includes(executable)) {
    throw new Error('github-write 只接受经过任务合同验证的 git push 或 gh 写命令。');
  }
  const root = repoRoot();
  const active = loadState(root);
  if (!active) throw new Error('没有活动 task state；禁止远端写入。');
  const check = { ...active.state, forceLiveCheck: false, githubWrite: false };
  if (executable === 'git' || executable === 'git.exe') {
    assertSafeGitCommand(['git', ...tokens.slice(1)], check);
  } else {
    assertSafeGhCommand(['gh', ...tokens.slice(1)], check);
  }
  if (!check.githubWrite) {
    throw new Error('github-write 只能执行被治理规则识别为写入的 git/gh 命令。');
  }
  assertActiveState(root, active, { force: check.forceLiveCheck });
  assertOwnedChanges(root, active.state);
  const command = executable.startsWith('git') ? 'git' : 'gh';
  const result = runSerializedRemoteWrite(root, command, tokens.slice(1), {
    timeout: 120_000,
  });
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
}

function classifyMcpOperation(input) {
  const tool = String(input.tool_name || '');
  const operation = tool.split('__').pop() || '';
  const readOnlyName = /^(?:get|list|read|search|find|query|view|explore|status|fetch)(?:_|$)/i;
  const writeSignal = /(?:^|_)(?:write|create|update|delete|remove|add|set|post|put|patch|merge|close|comment)(?:_|$)/i;
  const readOnly = readOnlyName.test(operation) && !writeSignal.test(operation);
  return {
    tool,
    readOnly,
    writeSignal: writeSignal.test(operation),
    githubWrite: /github/i.test(tool) && !readOnly,
  };
}

function commandMcpGuard() {
  const input = readHookInput();
  const classification = classifyMcpOperation(input);
  if (classification.githubWrite) {
    process.stderr.write(
      `COREONE MCP blocked: ${classification.tool || 'unknown tool'} may write GitHub. ` +
      'Use the serialized GitHub writer so offline governance, spacing, and the real mutation share one lock.',
    );
    process.exitCode = 2;
    return;
  }
  if (!classification.writeSignal) return;
  const root = repoRoot(input.cwd || process.cwd());
  const snapshot = inspectTaskState(root);
  if (snapshot.kind !== 'valid') {
    process.stderr.write(
      `COREONE MCP blocked: ${classification.tool || 'unknown tool'} is a structured external write, ` +
      `and ${inactiveTaskStateMessage(snapshot)}.`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    assertActiveState(root, { file: snapshot.file, state: snapshot.state }, { force: true });
  } catch (error) {
    process.stderr.write(`COREONE MCP blocked: ${error.message}`);
    process.exitCode = 2;
  }
}

function assertHookSafeWithoutActiveState(input, root) {
  const tool = String(input.tool_name || '');
  if (/^(?:Bash|PowerShell)$/i.test(tool) || input.tool_input?.command !== undefined) {
    assertShellCommandSafety(
      String(input.tool_input?.command || '').trim(),
      null,
      root,
      input.cwd || root,
    );
    return;
  }
  const classification = classifyMcpOperation(input);
  if (classification.githubWrite || classification.writeSignal) {
    throw new Error(
      `${classification.tool || 'unknown MCP tool'} is a structured external write`,
    );
  }
}

function commandAudit() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const snapshot = inspectTaskState(root);
  try {
    try {
      assertHookSafeWithoutActiveState(input, root);
      if (snapshot.kind === 'valid') assertOwnedChanges(root, snapshot.state);
      return;
    } catch {
      // The operation needs live task authorization; validate it below.
    }
    if (snapshot.kind !== 'valid') {
      throw new Error(inactiveTaskStateMessage(snapshot));
    }
    const active = { file: snapshot.file, state: snapshot.state };
    assertActiveState(root, active);
    assertOwnedChanges(root, active.state);
  } catch (error) {
    process.stderr.write(`COREONE scope audit failed: ${error.message}`);
    process.exitCode = 2;
  }
}

function commandGuard() {
  const input = readHookInput();
  const requested = resolveHookPath(input);
  if (requested) {
    const target = resolvePhysicalPath(input.cwd || process.cwd(), requested);
    if (isHarnessMemoryPath(target)) return;
  }
  const root = repoRoot(input.cwd || process.cwd());
  const snapshot = inspectTaskState(root);
  if (snapshot.kind !== 'valid') {
    process.stderr.write(
      `COREONE write blocked: ${inactiveTaskStateMessage(snapshot)}. ` +
      'R0 uses start-r0 without an Issue; PRD/feature work uses governed task start.',
    );
    process.exitCode = 2;
    return;
  }

  const active = { file: snapshot.file, state: snapshot.state };
  const { state } = active;
  try {
    assertActiveState(root, active);
  } catch (error) {
    process.stderr.write(`COREONE write blocked: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  if (!requested) {
    process.stderr.write('COREONE write blocked: hook could not determine the target file path.');
    process.exitCode = 2;
    return;
  }
  try {
    assertTaskWriteTarget(requested, {
      ...state,
      root,
      cwd: input.cwd || root,
    });
  } catch (error) {
    process.stderr.write(`COREONE write blocked: ${error.message}`);
    process.exitCode = 2;
  }
}

function shouldBlockStop(input) {
  return !input.stop_hook_active;
}

function commandStop() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const snapshot = inspectTaskState(root);
  if (snapshot.kind === 'missing') return;
  if (snapshot.kind !== 'valid') {
    process.stderr.write(
      `COREONE stop notice: ${inactiveTaskStateMessage(snapshot)}; ` +
      'it remains on disk for diagnosis but cannot block this session or authorize work.',
    );
    return;
  }
  const active = { file: snapshot.file, state: snapshot.state };
  try {
    assertActiveState(root, active, { force: true });
    assertOwnedChanges(root, active.state);
  } catch (error) {
    process.stderr.write(`COREONE stop audit failed: ${error.message}`);
    if (shouldBlockStop(input)) process.exitCode = 2;
    return;
  }
  if (!shouldBlockStop(input)) {
    process.stderr.write(
      `COREONE task state remains active for ${active.state.mode === 'r0' ? 'local R0 task' : `Issue #${active.state.issue}`}. ` +
        `The first Stop reminder was not resolved; this turn may end, but the next session will still require ${active.state.mode === 'r0' ? 'finish-r0 evidence' : 'a verified GitHub handoff'}.`,
    );
    return;
  }
  if (active.state.mode === 'r0') {
    process.stderr.write(
      'COREONE stop blocked: active R0 task has no target-check evidence. Run finish-r0 --evidence=<actual check> first.',
    );
    process.exitCode = 2;
    return;
  }
  process.stderr.write(
    `COREONE stop blocked: active Issue #${active.state.issue} has no recorded GitHub handoff. ` +
      'Post a fresh ordinary comment containing [HANDOFF] status=<...>, then run node scripts/claude-task.cjs handoff --status=<...> --evidence=<comment URL>.',
  );
  process.exitCode = 2;
}

function commandHandoff(argv) {
  const flags = parseFlags(argv);
  const root = repoRoot();
  if (Object.prototype.hasOwnProperty.call(flags, 'keep-state')) {
    throw new Error('handoff --keep-state 不在本任务冻结方向；handoff 仍清除本地 task state。');
  }
  const active = loadState(root);
  if (!active) throw new Error('没有活动 task state。');
  if (active.state.mode === 'r0') throw new Error('R0 使用 finish-r0，不使用 GitHub handoff。');
  const status = String(flags.status || '').toLowerCase();
  const evidence = String(flags.evidence || '').trim();
  if (!HANDOFF_STATUSES.has(status)) {
    throw new Error(`--status 必须是 ${[...HANDOFF_STATUSES].join(' / ')}。`);
  }
  assertActiveState(root, active, { force: true });
  assertOwnedChanges(root, active.state);
  const handoff = verifyGitHubEvidence(root, evidence, {
    label: 'GitHub handoff 证据',
    requireComment: true,
    activeIssue: active.state.issue,
    since: active.state.startedAt,
    expectedStatus: status,
    requireHandoffFields: true,
    requireCurrentActor: true,
  });
  if (handoff.parsed.kind !== 'issue') {
    throw new Error(`handoff 必须是活动 Issue #${active.state.issue} 的普通评论，不使用 PR 评论。`);
  }
  removePrivateFile(active.file);
  process.stdout.write(
    `COREONE handoff recorded: Issue #${active.state.issue} / ${status} / ${evidence}\n` +
      'Local task state cleared; the next device/session must reclaim from GitHub.',
  );
}

function usage() {
  return [
    'Usage:',
    '  node scripts/claude-task.cjs context',
    '  node scripts/claude-task.cjs prompt                    # hook stdin JSON',
    '  node scripts/claude-task.cjs create-issues --manifest=<Claude memory JSON> --approval=<fresh PM manifest-hash comment URL>',
    '  node scripts/claude-task.cjs guard                     # hook stdin JSON',
    '  node scripts/claude-task.cjs stop                      # hook stdin JSON',
    '  node scripts/claude-task.cjs start-r0 --reason=<trivial reversible> --owned=path [--excluded=path]',
    '  node scripts/claude-task.cjs finish-r0 --evidence=<actual target check>',
    '  node scripts/claude-task.cjs start --issue=N --stage=implementation --owner=NAME [--claim=true] --risk=R1 --prd=path@SHA --approval=PM_COMMENT_URL --mockup=path@SHA|NOT_APPLICABLE:reason --mockup-approval=PM_COMMENT_URL --owned=glob [--excluded=glob] [--adopt-dirty] [--ownership-exception=PM_COMMENT_URL] [--dry-run]',
    '  node scripts/claude-task.cjs start --issue=N --stage=implementation --owner=NAME [--claim=true] --risk=R1 --prd=N/A --mockup=path@SHA|NOT_APPLICABLE:reason --mockup-approval=PM_COMMENT_URL --owned=glob [--excluded=glob] [--adopt-dirty] [--ownership-exception=PM_COMMENT_URL] [--dry-run]  # non-PRD Issue fields must both be N/A',
    '  node scripts/claude-task.cjs shell-guard              # Bash/PowerShell PreToolUse hook stdin JSON',
    '  node scripts/claude-task.cjs github-write -- <git push|gh issue comment|gh pr create>  # holds the writer lock through the real command',
    '  node scripts/claude-task.cjs mcp-guard                # MCP PreToolUse hook stdin JSON',
    '  node scripts/claude-task.cjs audit                    # shell/MCP PostToolUse hook stdin JSON',
    '  node scripts/claude-task.cjs rebaseline-rating --evidence=<fresh [ISSUE-RATING] comment URL>',
    '  node scripts/claude-task.cjs handoff --status=waiting-pm --evidence=<fresh [HANDOFF] comment URL>',
  ].join('\n');
}

function main() {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (!command || command === '--help') {
      process.stdout.write(usage());
      return;
    }
    if (command === 'context') commandContext();
    else if (command === 'prompt') commandPrompt();
    else if (command === 'create-issues') commandCreateIssues(argv);
    else if (command === 'start') commandStart(argv);
    else if (command === 'start-r0') commandStartR0(argv);
    else if (command === 'finish-r0') commandFinishR0(argv);
    else if (command === 'guard') commandGuard();
    else if (command === 'shell-guard') commandShellGuard();
    else if (command === 'github-write') commandGitHubWrite(argv);
    else if (command === 'mcp-guard') commandMcpGuard();
    else if (command === 'audit') commandAudit();
    else if (command === 'stop') commandStop();
    else if (command === 'rebaseline-rating') commandRebaselineRating(argv);
    else if (command === 'handoff') commandHandoff(argv);
    else throw new Error(`未知命令：${command}\n${usage()}`);
  } catch (error) {
    process.stderr.write(`COREONE Claude task guard: ${error.message}\n`);
    const command = process.argv[2];
    process.exitCode = ['guard', 'shell-guard', 'mcp-guard', 'audit', 'stop'].includes(command) ? 2 : 1;
  }
}

if (require.main === module) main();

module.exports = {
  assertClaudeImplementationOwnership,
  beginIssueCreationLedger,
  assertSafeGhCommand,
  assertSafeGitCommand,
  assertSafeNodeCommand,
  assertShellCommandSafety,
  classifyIssueDeliveryContract,
  collectHandoffFields,
  findDriftViolations,
  findScopeViolations,
  globToRegExp,
  handoffFieldErrors,
  isHarnessMemoryPath,
  isRelevantPrompt,
  isPmApprovedStatus,
  isSafeBeforeStartShell,
  issueFormField,
  listDirtyPaths,
  matchesAny,
  parseGitHubArtifactUrl,
  parseFlags,
  parseIssueCreationApprovalMarker,
  parseIssueRatingMarker,
  parsePmApprovalMarker,
  parseOwnerBlock,
  parsePrdRef,
  parseRequirementAcceptanceMap,
  resolveIssueCreationManifestPath,
  shouldBlockStop,
  shellTokens,
  toPosix,
  validateIssueCreationManifest,
  validateIssueImplementationLabels,
};
