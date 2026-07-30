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
  const common = git(['rev-parse', '--git-common-dir'], root).stdout;
  const absolute = path.isAbsolute(common) ? common : path.resolve(root, common);
  return path.join(absolute, 'coreone');
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
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
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
      } catch {
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
  fs.mkdirSync(controlDirectory, { recursive: true });
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
  return path.resolve(git(['rev-parse', '--show-toplevel'], cwd).stdout);
}

function stateFile(root) {
  const value = git(
    ['rev-parse', '--path-format=absolute', '--git-path', 'coreone/claude-task-state.json'],
    root,
  ).stdout;
  return path.resolve(value);
}

function loadJsonFile(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function removePrivateFile(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function parseFlags(argv) {
  const flags = { owned: [], excluded: [], dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      flags.dryRun = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/s);
    if (!match) throw new Error(`参数必须使用 --key=value：${arg}`);
    const [, key, value] = match;
    if (key === 'owned' || key === 'excluded') flags[key].push(value);
    else flags[key] = value;
  }
  return flags;
}

function toPosix(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
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
  return new RegExp(pattern, process.platform === 'win32' ? 'i' : '');
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
  const file = stateFile(root);
  const state = loadJsonFile(file);
  if (!state) return null;
  return { file, state };
}

function commandContext() {
  const root = repoRoot();
  const branch = git(['branch', '--show-current'], root).stdout || 'DETACHED';
  const head = git(['rev-parse', '--short=12', 'HEAD'], root).stdout;
  const base = git(['rev-parse', '--short=12', 'origin/master'], root, { allowFailure: true });
  const dirty = git(['status', '--short'], root).stdout;
  const active = loadState(root)?.state;
  const stateSummary = active
    ? active.mode === 'r0'
      ? `active task: local R0 / reason=${active.reason}`
      : `active task: #${active.issue} / ${active.stage} / owner=${active.owner}`
    : 'active task: none; writes require start-r0 (no Issue) or governed task start';

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
  if (loadState(root)) {
    throw new Error('已有活动 task state；先完成 finish-r0 或 GitHub handoff，不能用新的 start 覆盖。');
  }
  if (git(['status', '--short'], root).stdout) {
    throw new Error('task start 前工作树必须 clean，避免把合同建立前的改动并入本任务。');
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
  if (loadState(root)) {
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
  const reason = String(flags.reason || '').trim();
  if (reason.length < 6) throw new Error('--reason 必须说明本项为何属于 R0 琐碎、可逆修改。');
  if (flags.owned.length === 0) throw new Error('R0 也至少提供一个 --owned=<path/glob>。');
  if (loadState(root)) {
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
  const age = Date.now() - Date.parse(state.startedAt);
  if (!Number.isFinite(age) || age > STATE_MAX_AGE_MS) {
    throw new Error('task contract 已过期（>12h）；重新读取 GitHub 并运行 task start。');
  }
  const branch = git(['branch', '--show-current'], root).stdout;
  if (branch !== state.branch) {
    throw new Error(`branch 已变化（${state.branch} -> ${branch}）；重新运行 task start。`);
  }
  git(['merge-base', '--is-ancestor', state.startedHead, 'HEAD'], root);

  if (state.mode === 'r0') return;
  git(['merge-base', '--is-ancestor', state.baseSha, 'HEAD'], root);

  const sinceVerify = Date.now() - Date.parse(state.verifiedAt || state.startedAt);
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

function listChangedPaths(root, state) {
  const commands = [
    ['diff', '--no-renames', '--name-only', '-z', `${state.startedHead}..HEAD`],
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

function findScopeViolations(paths, state) {
  return paths.filter((file) => matchesAny(file, state.excluded) || !matchesAny(file, state.owned));
}

function assertOwnedChanges(root, state) {
  const violations = findScopeViolations(listChangedPaths(root, state), state);
  if (violations.length > 0) {
    throw new Error(`检测到 owned/excluded 范围外改动：${violations.join(', ')}`);
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
  const tokens = shellTokens(segment);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1;
  }
  return tokens.slice(index);
}

function unwrapCommandTokens(tokens) {
  let current = [...tokens];
  for (let depth = 0; depth < 4 && current.length > 0; depth += 1) {
    const executable = path.basename(String(current[0] || '')).toLowerCase();
    if (['command', 'nohup'].includes(executable)) {
      const next = current.slice(1).findIndex((value) => !String(value).startsWith('-'));
      if (next < 0) return current;
      current = current.slice(next + 1);
      continue;
    }
    if (executable === 'env') {
      let index = 1;
      while (
        index < current.length &&
        (
          String(current[index]).startsWith('-') ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(current[index]))
        )
      ) {
        index += 1;
      }
      if (index >= current.length) return current;
      current = current.slice(index);
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

function assertTaskWriteTarget(value, state = {}) {
  const raw = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw || raw === '/dev/null' || raw.toLowerCase() === 'nul') return;
  if (/[$%*?\[\]{}]/.test(raw) || raw.startsWith('~')) {
    throw new Error(`文件写目标 ${raw} 无法静态解析；请改用明确的 owned 路径或临时目录。`);
  }
  const root = path.resolve(state.root || process.cwd());
  const cwd = path.resolve(state.cwd || root);
  const target = path.resolve(cwd, raw);
  const temporaryRoots = new Set([
    path.resolve(os.tmpdir()),
    fs.realpathSync.native(os.tmpdir()),
  ]);
  if (process.platform !== 'win32') {
    temporaryRoots.add(path.resolve('/tmp'));
    try {
      temporaryRoots.add(fs.realpathSync.native('/tmp'));
    } catch {
      // A platform without /tmp is already covered by os.tmpdir().
    }
  }
  if ([...temporaryRoots].some((temporaryRoot) =>
    isPathInside(temporaryRoot, target, { allowSame: true }))) return;
  if (!isPathInside(root, target)) {
    if (isHarnessMemoryPath(target)) return;
    throw new Error(`文件写目标 ${raw} 位于当前仓库和临时目录之外。`);
  }
  const relative = toPosix(path.relative(root, target));
  if (
    !Array.isArray(state.owned) ||
    matchesAny(relative, state.excluded || []) ||
    !matchesAny(relative, state.owned)
  ) {
    throw new Error(`文件写目标 ${relative} 不在当前 task owned scope。`);
  }
}

function gitSubcommand(tokens) {
  let index = 1;
  const globals = [];
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const current = tokens[index];
    globals.push(current);
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(current)) {
      globals.push(tokens[index + 1] || '');
      index += 2;
    } else {
      index += 1;
    }
  }
  return { globals, command: String(tokens[index] || '').toLowerCase(), args: tokens.slice(index + 1) };
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

function assertSafeGitCommand(tokens, state) {
  const { globals, command, args } = gitSubcommand(tokens);
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
  if (command === 'worktree' && loweredArgs[0] === 'add') {
    const positional = args.slice(1).filter((value) => !String(value).startsWith('-'));
    const target = positional.length >= 2 ? positional[positional.length - 2] : null;
    if (target) assertTaskWriteTarget(target, state);
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

function assertSafeNodeCommand(tokens, root = process.cwd(), cwd = root) {
  void root;
  void cwd;
  return {
    kind: 'unrestricted',
    entries: [],
    executable: String(tokens[0] || ''),
  };
}

function assertSafeNpmCommand(tokens) {
  return { kind: 'unrestricted', executable: String(tokens[0] || '') };
}

function isGovernedWriteWrapper(command, action = 'github-write') {
  if (hasShellControl(command)) return false;
  const tokens = commandTokens(command);
  const executable = path.basename(String(tokens[0] || '')).toLowerCase();
  if (!['node', 'node.exe'].includes(executable)) return false;
  const scriptIndex = tokens.findIndex((value) =>
    toPosix(String(value)).endsWith('/scripts/claude-task.cjs') ||
    toPosix(String(value)) === 'scripts/claude-task.cjs');
  return scriptIndex >= 0 && String(tokens[scriptIndex + 1] || '').toLowerCase() === action;
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
    if (source[targetIndex] === '&' && /^\d/.test(source[targetIndex + 1] || '')) continue;
    if (targetIndex >= source.length) continue;
    let target = '';
    const targetQuote =
      source[targetIndex] === "'" || source[targetIndex] === '"'
        ? source[targetIndex++]
        : null;
    for (; targetIndex < source.length; targetIndex += 1) {
      const targetCharacter = source[targetIndex];
      if (targetQuote ? targetCharacter === targetQuote : /[\s;&|]/.test(targetCharacter)) break;
      target += targetCharacter;
    }
    if (target) targets.push(target);
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
  if (isGovernedWriteWrapper(command) || isGovernedWriteWrapper(command, 'create-issues')) {
    return { forceLiveCheck: Boolean(state), githubWrite: false };
  }
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
    const tokens = unwrapCommandTokens(commandTokens(segment));
    if (tokens.length === 0) continue;
    const executable = path.basename(String(tokens[0] || '')).toLowerCase();
    if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'powershell', 'pwsh'].includes(executable)) {
      const commandIndex = tokens.findIndex((value) =>
        /^(?:-c|--command)$/i.test(String(value)));
      if (commandIndex >= 0 && tokens[commandIndex + 1]) {
        const nested = assertShellCommandSafety(
          String(tokens[commandIndex + 1]),
          state,
          root,
          cwd,
        );
        check.forceLiveCheck ||= nested.forceLiveCheck;
        check.githubWrite ||= nested.githubWrite;
      }
    }
    assertNoSystemDestruction(tokens);
    assertNoRawGitHubWrite(tokens);
    if (['git', 'git.exe'].includes(executable)) {
      const parsed = gitSubcommand(tokens);
      if (!state && parsed.command === 'worktree' && parsed.args[0] === 'add') {
        assertSafeWorktreeAdd(parsed.args, { root, cwd });
      } else if (!state) {
        const mutating = new Set([
          'add', 'am', 'apply', 'checkout', 'cherry-pick',
          'merge', 'mv', 'rebase', 'reset', 'restore', 'revert', 'switch',
        ]);
        const probe = { root, cwd, owned: [], excluded: [], branch: null };
        assertSafeGitCommand(tokens, probe);
        if (probe.githubWrite || mutating.has(parsed.command)) {
          throw new Error(`git ${parsed.command} 会修改本地或远端状态，需先建立 task contract。`);
        }
      } else {
        assertSafeGitCommand(tokens, check);
      }
    } else if (['gh', 'gh.exe'].includes(executable)) {
      if (!state && isSafeGhRead(tokens)) continue;
      assertSafeGhCommand(tokens, check);
    } else {
      const targets = [
        ...new Set([
          ...shellMutationTargets(tokens),
          ...shellRedirectionTargets(segment),
        ]),
      ];
      if (!state && targets.length > 0) {
        throw new Error(`${executable} 会修改文件，需先建立 task contract。`);
      }
      for (const target of targets) assertTaskWriteTarget(target, check);
      if (targets.length > 0) check.forceLiveCheck = true;
      if (['node', 'node.exe'].includes(executable)) {
        assertSafeNodeCommand(tokens, root, cwd);
      } else if (['npm', 'npm.cmd', 'npm.exe'].includes(executable)) {
        assertSafeNpmCommand(tokens);
      }
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

function commandShellGuard() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const command = String(input.tool_input?.command || '').trim();
  const active = loadState(root);

  if (!active) {
    if (isSafeBeforeStartShell(command, root, input.cwd || root)) return;
    process.stderr.write(
      'COREONE shell blocked: this command is a GitHub write, an explicit file mutation, or a destructive action and no active task contract exists.',
    );
    process.exitCode = 2;
    return;
  }

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

function commandMcpGuard() {
  const input = readHookInput();
  const tool = String(input.tool_name || '');
  const operation = tool.split('__').pop() || '';
  const readOnlyName = /^(?:get|list|read|search|find|query|view|explore|status|fetch)(?:_|$)/i;
  const writeSignal = /(?:^|_)(?:write|create|update|delete|remove|add|set|post|put|patch|merge|close|comment)(?:_|$)/i;
  if (!/github/i.test(tool)) return;
  if (readOnlyName.test(operation) && !writeSignal.test(operation)) return;
  process.stderr.write(
    `COREONE MCP blocked: ${tool || 'unknown tool'} may write GitHub. Use the serialized GitHub writer so offline governance, spacing, and the real mutation share one lock.`,
  );
  process.exitCode = 2;
}

function commandAudit() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) return;
  try {
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
    const target = path.resolve(input.cwd || process.cwd(), requested);
    if (isHarnessMemoryPath(target)) return;
  }
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) {
    process.stderr.write(
      'COREONE write blocked: no local task state. R0 uses start-r0 without an Issue; PRD/feature work uses governed task start.',
    );
    process.exitCode = 2;
    return;
  }

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
  const absolute = path.resolve(input.cwd || root, requested);
  const relative = toPosix(path.relative(root, absolute));
  if (relative.startsWith('../') || path.isAbsolute(relative)) {
    process.stderr.write(`COREONE write blocked: target is outside the task repository (${requested}).`);
    process.exitCode = 2;
    return;
  }
  if (matchesAny(relative, state.excluded)) {
    process.stderr.write(`COREONE write blocked: ${relative} matches excluded files.`);
    process.exitCode = 2;
    return;
  }
  if (!matchesAny(relative, state.owned)) {
    process.stderr.write(`COREONE write blocked: ${relative} is not covered by owned files.`);
    process.exitCode = 2;
  }
}

function shouldBlockStop(input) {
  return !input.stop_hook_active;
}

function commandStop() {
  const input = readHookInput();
  const root = repoRoot(input.cwd || process.cwd());
  const active = loadState(root);
  if (!active) return;
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
    '  node scripts/claude-task.cjs start --issue=N --stage=implementation --owner=NAME [--claim=true] --risk=R1 --prd=path@SHA --approval=PM_COMMENT_URL --mockup=path@SHA|NOT_APPLICABLE:reason --mockup-approval=PM_COMMENT_URL --owned=glob [--excluded=glob] [--ownership-exception=PM_COMMENT_URL] [--dry-run]',
    '  node scripts/claude-task.cjs start --issue=N --stage=implementation --owner=NAME [--claim=true] --risk=R1 --prd=N/A --mockup=path@SHA|NOT_APPLICABLE:reason --mockup-approval=PM_COMMENT_URL --owned=glob [--excluded=glob] [--ownership-exception=PM_COMMENT_URL] [--dry-run]  # non-PRD Issue fields must both be N/A',
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
  findScopeViolations,
  globToRegExp,
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
